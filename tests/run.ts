// Automated checks. Needs a Postgres database it may wipe: TEST_DATABASE_URL (default storagex_test on localhost).
import './env';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, closePool, openPool } from '../src/lib/db';
import { migrate, seed } from '../src/lib/migrate';
import { toKobo, fmtNGN, valueKobo, bpOf } from '../src/lib/money';
import { hashPassword, verifyPassword, passwordProblem, encrypt, decrypt } from '../src/lib/util';
import { totpCode, base32Encode } from '../src/lib/totp';
import { can, canGrant, validRole, type Membership } from '../src/lib/rbac';
import * as A from '../src/lib/auth';
import { verifyAuditChain } from '../src/lib/audit';
import { handle } from '../src/server';
import { normPhone, encryptBuffer, decryptBuffer } from '../src/lib/util';
import { smsAllowed } from '../src/lib/rbac';
import { sniff, fileRow, readFile } from '../src/lib/files';
import { sentForTests } from '../src/lib/sms';
import * as R from '../src/lib/registry';
import * as K from '../src/lib/kyc';
import * as P from '../src/lib/applications';
import * as S from '../src/lib/settings';
import * as I from '../src/lib/intake';
import { screenIntake } from '../src/lib/agents/intake-screen';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { screenSubmission, flagOf, parseFindings, latestCheck, type ModelCall } from '../src/lib/agents/kyc-screen';

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e: any) { fail++; console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
function eq(a: unknown, b: unknown, msg = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v: unknown, msg = 'expected truthy') { if (!v) throw new Error(msg); }
async function rejects(p: Promise<unknown>, code?: string) {
  try { await p; } catch (e: any) { if (code && e.code !== code) throw new Error(`threw ${e.code}: ${e.message}, expected ${code}`); return e; }
  throw new Error(`expected an error${code ? ' ' + code : ''}`);
}
const sys = { label: 'test' };
const lastCode = () => (sentForTests.at(-1)?.text.match(/\b(\d{6})\b/) || [])[1];
const jpeg = (n = 1) => ({ filename: 'x.jpg', type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, n)]) });
const totpNow = async (userId: string) => totpCode((await A.pendingTotpSecret(userId))!);

async function freshDb() {
  await db.script('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await seed(() => {});
}

/** Creates an active, 2FA-enrolled user with one membership; returns an Actor for them. */
async function makeUser(inviter: A.Actor | null, email: string, orgId: string, role: string): Promise<A.Actor & { password: string; secret: string }> {
  const password = 'correct horse battery staple';
  let link: string;
  if (inviter) link = (await A.invite(inviter, { email, fullName: email.split('@')[0], orgId, role })).link;
  else link = await A.bootstrapSuperAdmin(email, 'Super Admin');
  await A.acceptInvite(link.split('/invite/')[1], password, '127.0.0.1');
  const user = await A.login(email, password, '127.0.0.1');
  const secret = await A.beginTotpSetup(user.id);
  await A.confirmTotp(user.id, totpCode(secret), sys);
  const ms = await A.memberships(user.id);
  return { user: { ...user, totp_enabled: true }, membership: ms.find((m) => m.org_id === orgId)!, ip: '127.0.0.1', password, secret };
}

async function main() {
  openPool();
  console.log('\nUnits');
  await t('money: parse and format kobo', () => {
    eq(toKobo('₦1,234.50'), 123450); eq(toKobo('1234'), 123400); eq(toKobo('0.5'), 50); eq(toKobo(-2.25), -225);
    eq(fmtNGN(123450), '₦1,234.50'); eq(fmtNGN('36223200'), '₦362,232.00'); eq(fmtNGN(-5), '-₦0.05');
    eq(valueKobo('1006.20', 36000), 36223200); eq(bpOf(36223200, 5000), 18111600);
    for (const bad of ['1.234', 'abc', '1,2,3.4.5', '']) { try { toKobo(bad); throw new Error('accepted ' + bad); } catch (e: any) { if (e.message.startsWith('accepted')) throw e; } }
  });
  await t('passwords: scrypt round-trip and policy', () => {
    const h = hashPassword('a long enough passphrase'); ok(verifyPassword('a long enough passphrase', h)); ok(!verifyPassword('wrong', h));
    ok(passwordProblem('short')); ok(passwordProblem('aaaaaaaaaaaaaaaa')); ok(passwordProblem('emeka-is-my-secret', 'emeka@kitovu.com.ng')); eq(passwordProblem('a long enough passphrase'), null);
  });
  await t('TOTP: RFC 6238 test vector', () => {
    eq(totpCode(base32Encode(Buffer.from('12345678901234567890')), 59_000), '287082');
    eq(totpCode(base32Encode(Buffer.from('12345678901234567890')), 1111111109_000), '081804');
  });
  await t('secrets: AES-GCM round-trip and tamper detection', () => {
    const box = encrypt('JBSWY3DPEHPK3PXP'); eq(decrypt(box), 'JBSWY3DPEHPK3PXP');
    const parts = box.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'B' : 'A');
    try { decrypt(parts.join('.')); throw new Error('accepted tampered'); } catch (e: any) { if (e.message === 'accepted tampered') throw e; }
  });
  await t('roles: valid per organisation kind, scope and no escalation', () => {
    ok(validRole('lender', 'credit_officer')); ok(!validRole('lender', 'super_admin')); ok(!validRole('warehouse_operator', 'credit_officer'));
    const k: Membership = { org_id: 'K', org_kind: 'kitovu', org_name: 'Kitovu', role: 'ops_manager' };
    const l: Membership = { org_id: 'L1', org_kind: 'lender', org_name: 'Lender 1', role: 'lender_admin' };
    ok(can(k, 'farmers.edit', 'L1'), 'kitovu reaches every org'); ok(!can(l, 'finance.view', 'L2'), 'lender limited to own org'); ok(can(l, 'finance.view', 'L1'));
    ok(can(l, 'farmers.view') && !can(l, 'farmers.edit'), 'lenders read farmers (consent-scoped), never edit');
    ok(!canGrant(k, 'kitovu', 'K', 'super_admin'), 'only super admin makes super admin');
    ok(!canGrant(k, 'kitovu', 'K', 'finance'), 'ops cannot grant finance.approve it lacks');
    ok(canGrant(k, 'warehouse_operator', 'W1', 'warehouse_clerk'));
    ok(canGrant(l, 'lender', 'L1', 'credit_officer')); ok(!canGrant(l, 'lender', 'L2', 'credit_officer')); ok(!canGrant(l, 'kitovu', 'K', 'viewer'));
  });

  await t('phones: Nigerian forms normalise to E.164', () => {
    eq(normPhone('0803 123 4567'), '+2348031234567'); eq(normPhone('2348031234567'), '+2348031234567'); eq(normPhone('+2348031234567'), '+2348031234567');
    eq(normPhone('8031234567'), '+2348031234567'); eq(normPhone('12345'), null); eq(normPhone(''), null); eq(normPhone('+44 7700 900123'), '+447700900123');
  });
  await t('files: type by first bytes, encrypted round-trip', () => {
    eq(sniff(jpeg().data), 'image/jpeg'); eq(sniff(Buffer.from('%PDF-1.7 hello world')), 'application/pdf'); eq(sniff(Buffer.from('<html><script>alert(1)</script>')), null);
    const b = Buffer.from('a photo'); ok(decryptBuffer(encryptBuffer(b)).equals(b)); ok(!encryptBuffer(b).includes(b));
  });
  await t('SMS second step only for low-risk roles', () => {
    const m = (org_kind: any, role: string): Membership => ({ org_id: 'x', org_kind, org_name: 'x', role });
    ok(smsAllowed([m('lender', 'lender_viewer')])); ok(smsAllowed([m('warehouse_operator', 'warehouse_clerk')]));
    ok(!smsAllowed([m('lender', 'credit_officer')]), 'approves money'); ok(!smsAllowed([m('kitovu', 'viewer')]), 'Kitovu staff');
    ok(!smsAllowed([m('warehouse_operator', 'warehouse_clerk'), m('lender', 'lender_admin')]), 'every membership must qualify'); ok(!smsAllowed([]));
  });

  console.log('\nDatabase');
  await freshDb();
  await t('migrations: idempotent, and a changed applied file is refused', async () => {
    eq(await migrate(() => {}), 0);
    await db.run(`UPDATE schema_migrations SET checksum='x' WHERE version='0002_access'`);
    await rejects(migrate(() => {}));
    await freshDb();
  });

  const admin = await makeUser(null, 'admin@kitovu.com.ng', (await db.val<string>(`SELECT id FROM organisations WHERE code='KITOVU'`))!, 'super_admin');
  const accionId = await A.createOrg(admin, { code: 'ACCION', name: 'Accion Microfinance Bank', kind: 'lender' });
  const otherId = await A.createOrg(admin, { code: 'LENDERB', name: 'Another Lender', kind: 'lender' });
  const whId = await A.createOrg(admin, { code: 'FARMLINK', name: 'FarmLink Apex Ventures', kind: 'warehouse_operator' });

  await t('invite → accept → password → two-step → full session', async () => {
    const { link } = await A.invite(admin, { email: 'Ops@Kitovu.com.ng ', fullName: 'Ops Lead', orgId: admin.membership!.org_id, role: 'ops_manager' });
    const token = link.split('/invite/')[1];
    await rejects(A.acceptInvite(token, 'short', '1.1.1.1'), 'password');
    await A.acceptInvite(token, 'a perfectly fine passphrase', '1.1.1.1');
    await rejects(A.acceptInvite(token, 'a perfectly fine passphrase', '1.1.1.1'), 'invalid');
    const u = await A.login('ops@kitovu.com.ng', 'a perfectly fine passphrase', '1.1.1.1');
    const sessionToken = await A.createSession(u.id, '1.1.1.1', 'test');
    const s1 = await A.loadSession(sessionToken); ok(s1 && !s1.twofaOk, 'password alone is not enough');
    await A.beginTotpSetup(u.id);
    await rejects(A.confirmTotp(u.id, '000000', sys), 'code');
    const codes = await A.confirmTotp(u.id, await totpNowFor(u.id), sys);
    eq(codes.length, 10);
    const t2 = await A.completeSecondFactor(sessionToken, sys);
    eq(await A.loadSession(sessionToken), null, 'old token is retired');
    const s2 = await A.loadSession(t2); ok(s2?.twofaOk); eq(s2?.active?.role, 'ops_manager');
    ok(await A.verifySecondFactor(u.id, codes[0], sys), 'recovery code works');
    ok(!(await A.verifySecondFactor(u.id, codes[0], sys)), 'recovery code works only once');
  });

  await t('lockout after 5 wrong passwords, even with the right one', async () => {
    for (let i = 0; i < 5; i++) await rejects(A.login('admin@kitovu.com.ng', 'wrong password ' + i, '2.2.2.2'), 'invalid');
    await rejects(A.login('admin@kitovu.com.ng', admin.password, '2.2.2.2'), 'locked');
    ok(await db.val(`SELECT 1 FROM audit_log WHERE action='auth.account.locked'`));
    await db.run('UPDATE users SET locked_until=NULL WHERE email=$1', 'admin@kitovu.com.ng');
  });

  await t('unknown email and suspended accounts fail the same way', async () => {
    await rejects(A.login('nobody@nowhere.ng', 'whatever whatever', '3.3.3.3'), 'invalid');
  });

  let accionAdmin!: A.Actor;
  await t('lender admins stay inside their own organisation', async () => {
    accionAdmin = await makeUser(admin, 'admin@accion.test', accionId, 'lender_admin');
    const otherAdmin = await makeUser(admin, 'admin@lenderb.test', otherId, 'lender_admin');
    await rejects(A.invite(accionAdmin, { email: 'x@lenderb.test', fullName: 'X', orgId: otherId, role: 'credit_officer' }), 'forbidden');
    await rejects(A.invite(accionAdmin, { email: 'x@kitovu.com.ng', fullName: 'X', orgId: admin.membership!.org_id, role: 'viewer' }), 'forbidden');
    await rejects(A.invite(accionAdmin, { email: 'x@accion.test', fullName: 'X', orgId: accionId, role: 'warehouse_clerk' }), 'input');
    await A.invite(accionAdmin, { email: 'officer@accion.test', fullName: 'Credit Officer', orgId: accionId, role: 'credit_officer' });
    const { members, invites } = await A.listPeople(accionAdmin);
    ok(members.every((m: any) => m.org_id === accionId), 'only own members listed'); eq(invites.length, 1);
    const otherMembership = await db.val<string>('SELECT id FROM memberships WHERE org_id=$1', otherId);
    await rejects(A.revokeMembership(accionAdmin, otherMembership!), 'forbidden');
    await rejects(A.reset2fa(accionAdmin, otherAdmin.user.id), 'forbidden');
    await rejects(A.setUserStatus(accionAdmin, otherAdmin.user.id, 'suspended'), 'forbidden');
  });

  await t('one person, two organisations, switchable', async () => {
    const { link } = await A.invite(admin, { email: 'admin@accion.test', fullName: 'Accion Admin', orgId: whId, role: 'warehouse_clerk' });
    await A.acceptInvite(link.split('/invite/')[1], null, '1.1.1.1');
    const ms = await A.memberships(accionAdmin.user.id); eq(ms.length, 2);
  });

  await t('suspension signs the person out everywhere', async () => {
    const officer = await makeUser(admin, 'temp@kitovu.com.ng', admin.membership!.org_id, 'viewer');
    const tok = await A.completeSecondFactor(await A.createSession(officer.user.id, '1.1.1.1', 'x'), sys);
    ok(await A.loadSession(tok));
    await A.setUserStatus(admin, officer.user.id, 'suspended');
    eq(await A.loadSession(tok), null);
    await rejects(A.login('temp@kitovu.com.ng', officer.password, '1.1.1.1'), 'invalid');
    const again = await A.invite(admin, { email: 'temp@kitovu.com.ng', fullName: 'Temp', orgId: accionId, role: 'lender_viewer' });
    await rejects(A.acceptInvite(again.link.split('/invite/')[1], 'a brand new passphrase', '1.1.1.1'), 'suspended');
  });

  await t('idle sessions expire', async () => {
    const tok = await A.createSession(admin.user.id, '1.1.1.1', 'x');
    await db.run(`UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE user_id=$1`, admin.user.id);
    eq(await A.loadSession(tok), null);
  });

  await t('password reset link works once and unlocks', async () => {
    const victim = await makeUser(admin, 'forgot@kitovu.com.ng', admin.membership!.org_id, 'viewer');
    const { link } = await A.issuePasswordReset(admin, victim.user.id);
    const token = link.split('/reset/')[1];
    await A.resetPassword(token, 'my brand new passphrase', '1.1.1.1');
    await rejects(A.resetPassword(token, 'another new passphrase', '1.1.1.1'), 'invalid');
    ok(await A.login('forgot@kitovu.com.ng', 'my brand new passphrase', '1.1.1.1'));
  });

  await t('audit log: append-only, chained, tampering detected', async () => {
    ok(Number(await db.val('SELECT count(*) FROM audit_log')) > 10);
    eq(await verifyAuditChain(), null);
    await rejects(db.run(`UPDATE audit_log SET action='x' WHERE id=1`));
    await rejects(db.run(`DELETE FROM audit_log WHERE id=1`));
    await db.script(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only; UPDATE audit_log SET data='{"forged":true}' WHERE id=2; ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;`);
    eq(await verifyAuditChain(), '2');
  });

  console.log('\nRegistry and identity checks');
  const kitovuId = admin.membership!.org_id;
  const ops = await makeUser(admin, 'field@kitovu.com.ng', kitovuId, 'ops_manager');
  const compliance = await makeUser(admin, 'compliance@kitovu.com.ng', kitovuId, 'compliance');
  const officer = await makeUser(admin, 'credit@accion.test', accionId, 'credit_officer');
  const other = await makeUser(admin, 'credit@lenderb.test', otherId, 'credit_officer');
  let ada = '';
  await t('register a farmer; codes start after legacy; same phone + similar name warns', async () => {
    ada = await R.createFarmer(ops, { full_name: 'Ada  Okafor', phone: '0803 123 4567', state_code: 'NI', community: 'Gidan Kwano', commodities: ['MAZ', 'SBN'], sex: 'female', year_of_birth: '1985' });
    eq(ada, 'SXF-200000');
    const e = await rejects(R.createFarmer(ops, { full_name: 'Okafor Ada', phone: '+2348031234567' }));
    ok(e instanceof R.DuplicateWarning, 'duplicate warned');
    ok(await R.createFarmer(ops, { full_name: 'Chidi Okafor', phone: '08031234567' }), 'a relative sharing the phone is fine');
    await rejects(R.createFarmer(ops, { full_name: 'Bad Crop', commodities: ['XYZ'] }));
    await rejects(R.createFarmer(officer, { full_name: 'Lender Made' }));
    eq((await R.searchFarmers(ops, { text: '08031234567' })).length, 2);
  });
  await t('lenders see no farmer until the farmer consents', async () => {
    eq((await R.searchFarmers(officer)).length, 0);
    eq(await R.farmerByCode(officer, ada), undefined);
  });
  let subId = '';
  await t('level 1: phone code, ID + selfie, duplicate ID refused, maker-checker review', async () => {
    await rejects(K.submitLevel1(ops, ada, { id_type: 'nin', id_number: '12345678901' }, { id_doc: jpeg(), selfie: jpeg(2) }));   // phone first
    await K.sendPhoneCode(ops, ada);
    eq(sentForTests.at(-1)!.to, '+2348031234567');
    await rejects(K.confirmPhone(ops, ada, '000000'));
    await K.confirmPhone(ops, ada, lastCode()!);
    await rejects(K.submitLevel1(ops, ada, { id_type: 'nin', id_number: '1234' }, { id_doc: jpeg(), selfie: jpeg(2) }));
    await rejects(K.submitLevel1(ops, ada, { id_type: 'nin', id_number: '12345678901' }, { id_doc: { filename: 'x.jpg', type: 'image/jpeg', data: Buffer.from('<svg onload=alert(1)>xxxxxxxx') }, selfie: jpeg(2) }));
    subId = await K.submitLevel1(ops, ada, { id_type: 'nin', id_number: '123 4567 8901' }, { id_doc: jpeg(), selfie: jpeg(2) });
    const raw = await db.get<any>('SELECT * FROM kyc_submissions WHERE id=$1', subId);
    eq(raw.id_last4, '8901'); ok(!JSON.stringify(raw).includes('12345678901'), 'full number never stored');
    await rejects(K.review(ops, subId, 'approve', { checks: ['name_matches', 'face_matches', 'id_original'] }));   // ops lacks kyc.review
    await rejects(K.review(compliance, subId, 'approve', { checks: ['name_matches'] }));
    await K.review(compliance, subId, 'approve', { checks: ['name_matches', 'face_matches', 'id_original'] });
    const f = (await R.farmerByCode(ops, ada))!;
    eq(f.kyc_level, 1); eq(f.id_last4, '8901');
    ok(await db.val(`SELECT delete_after FROM files WHERE id=$1`, raw.id_doc_file_id), 'ID photo scheduled for deletion');
  });
  await t('the same ID number cannot back a second farmer', async () => {
    const twin = await R.createFarmer(ops, { full_name: 'Ada Twin', phone: '08099990000' });
    await K.sendPhoneCode(ops, twin); await K.confirmPhone(ops, twin, lastCode()!);
    const e = await rejects(K.submitLevel1(ops, twin, { id_type: 'nin', id_number: '12345678901' }, { id_doc: jpeg(), selfie: jpeg(2) }));
    ok(String(e.message).includes(ada));
  });
  await t('a reviewer cannot approve their own submission', async () => {
    const own = await R.createFarmer(admin, { full_name: 'Self Check', phone: '08055550000' });
    await K.sendPhoneCode(admin, own); await K.confirmPhone(admin, own, lastCode()!);
    const id = await K.submitLevel1(admin, own, { id_type: 'voters_card', id_number: '90F5B1E0A1234567890' }, { id_doc: jpeg(), selfie: jpeg(2) });
    await rejects(K.review(admin, id, 'approve', { checks: ['name_matches', 'face_matches', 'id_original'] }));
    await rejects(db.run(`UPDATE kyc_submissions SET reviewed_by=submitted_by WHERE id=$1`, id));   // the database refuses it too
    await K.review(compliance, id, 'reject', { reason: 'unreadable' });
    eq((await R.farmerByCode(admin, own))!.kyc_level, 0);
  });
  await t('consent by SMS code opens the record to that lender only', async () => {
    await rejects(K.recordConsent(ops, ada, { org_id: accionId, method: 'sms_code', otp: '123456', read_aloud: '1' }));
    await K.sendConsentCode(ops, ada, accionId);
    ok(sentForTests.at(-1)!.text.includes('Accion'));
    await rejects(K.recordConsent(ops, ada, { org_id: accionId, method: 'sms_code', otp: lastCode() }), );   // not read aloud
    await K.sendConsentCode(ops, ada, accionId);
    await K.recordConsent(ops, ada, { org_id: accionId, method: 'sms_code', otp: lastCode(), read_aloud: '1' });
    eq((await R.searchFarmers(officer)).map((f) => f.code), [ada]);
    eq((await R.searchFarmers(other)).length, 0);
  });
  await t('level 2: lender confirms its account; account numbers refused', async () => {
    await rejects(K.lenderVerify(officer, ada, '0123456789'));
    await rejects(K.lenderVerify(other, ada, 'CUST-1'));
    await K.lenderVerify(officer, ada, 'ACC-CIF-88812');
    eq((await R.farmerByCode(officer, ada))!.kyc_level, 2);
    const seen = await K.verificationsFor(officer, (await R.farmerByCode(officer, ada))!.id);
    eq(seen[0].customer_ref, 'ACC-CIF-88812');
    await K.lenderRevoke(officer, ada);
    eq((await R.farmerByCode(officer, ada))!.kyc_level, 1);
  });
  await t('withdrawn consent hides the farmer again', async () => {
    const c = (await K.consentsFor((await R.farmerByCode(ops, ada))!.id))[0];
    await rejects(K.withdrawConsent(officer, c.id, 'x'));
    await K.withdrawConsent(ops, c.id, 'Farmer called to withdraw');
    eq(await R.farmerByCode(officer, ada), undefined);
  });
  await t('identity files open only for Kitovu roles that need them, and decrypt intact', async () => {
    const k = await db.get<any>('SELECT * FROM kyc_submissions WHERE id=$1', subId);
    const idDoc = (await fileRow(k.id_doc_file_id))!;
    ok(await K.canOpenFile(compliance, idDoc)); ok(!(await K.canOpenFile(ops, idDoc)), 'ops sees selfies, not IDs'); ok(!(await K.canOpenFile(officer, idDoc)));
    ok(readFile(idDoc).equals(jpeg().data));
  });
  await t('field partners: networks add, Kitovu verifies; networks see their own farmers', async () => {
    const netId = await A.createOrg(admin, { code: 'AGENTS', name: 'Agent Network', kind: 'field_partner_network' });
    const net = await makeUser(admin, 'lead@agents.test', netId, 'network_admin');
    const code = await R.createFieldPartner(net, { full_name: 'Musa Bello', phone: '08061112222', state_code: 'KD' });
    ok(/^SXA-5\d{4}$/.test(code));
    await rejects(R.createFarmer(net, { full_name: 'Too Early', field_partner_code: code }));   // not verified yet
    const fp = (await R.listFieldPartners(net))[0];
    await rejects(R.setFieldPartnerStatus(net, fp.id, 'active'));
    await R.setFieldPartnerStatus(admin, fp.id, 'active');
    const mine = await R.createFarmer(net, { full_name: 'Halima Musa', field_partner_code: code });
    eq((await R.searchFarmers(net)).map((f) => f.code), [mine]);
  });
  await t('review queue: resolving the last item clears the review flag', async () => {
    const f = (await R.farmerByCode(ops, ada))!;
    await db.run('UPDATE farmers SET needs_review=true WHERE id=$1', f.id);
    await db.run(`INSERT INTO data_issues (entity, entity_id, severity, code, detail) VALUES ('farmer',$1,'review','phone_invalid','test')`, f.id);
    const [i] = await R.openIssues(ops, { entity: 'farmer', entityId: f.id });
    await rejects(R.openIssues(officer));
    await rejects(R.resolveIssue(ops, i.id, ''));
    await R.resolveIssue(ops, i.id, 'Called the farmer, number confirmed');
    eq((await R.farmerByCode(ops, ada))!.needs_review, false);
  });
  await t('warehouses: certification needs GPS and capacity; insurance needs a second person', async () => {
    const opId = await A.createOrg(admin, { code: 'KITWH', name: 'Kitovu Stores', kind: 'warehouse_operator' });
    const whid = await db.val<string>(`INSERT INTO warehouses (code, name, operator_org_id, tier, state_code) VALUES ('WH-NI-MNA-02','Minna 2',$1,'A','NI') RETURNING id`, opId);
    await rejects(R.updateWarehouse(ops, 'WH-NI-MNA-02', { status: 'certified' }));
    await R.updateWarehouse(ops, 'WH-NI-MNA-02', { status: 'certified', lat: '9.61', lng: '6.55', capacity_tonnes: '500', commodities: 'MAZ, SBN' });
    ok((await R.warehouseByCode(ops, 'WH-NI-MNA-02'))!.can_back_loans);
    await R.addPolicy(ops, 'WH-NI-MNA-02', { insurer_name: 'Leadway', cover_from: '2026-01-01', cover_to: '2027-12-31', sum_insured_naira: '50,000,000' });
    const [p] = await R.policiesFor(whid!);
    await rejects(R.verifyPolicy(ops, p.id));
    await R.verifyPolicy(admin, p.id);
    eq((await R.policiesFor(whid!))[0].status, 'active');
  });

  console.log('\nPhone check options and AI pre-check');
  await t('settings: only super admins; a required check keeps at least one method', async () => {
    await rejects(S.saveSettings(ops, { 'phone_check.sms': '0' }));
    await rejects(S.saveSettings(admin, { 'phone_check.sms': '0', 'phone_check.voice': '0', 'phone_check.attested': '0' }));
    eq(await S.saveSettings(admin, { 'phone_check.sms': '0' }), 1);
    ok(await db.val(`SELECT 1 FROM audit_log WHERE action='settings.changed'`));
  });
  let vf = '';
  await t('voice-call code works when text messages are switched off', async () => {
    vf = await R.createFarmer(ops, { full_name: 'Voice Farmer', phone: '08012340000' });
    await rejects(K.sendPhoneCode(ops, vf, 'sms'));
    await K.sendPhoneCode(ops, vf, 'voice');
    eq(sentForTests.at(-1)!.channel, 'voice');
    await K.confirmPhone(ops, vf, lastCode()!);
    eq((await R.farmerByCode(ops, vf))!.phone_check_method, 'voice');
    await S.saveSettings(admin, { 'phone_check.sms': '1' });
  });
  let nf = '';
  await t('no phone: a witnessed attestation lets the ID check go ahead; consent then needs paper', async () => {
    nf = await R.createFarmer(ops, { full_name: 'Bala Nophone', state_code: 'KN' });
    await rejects(K.submitLevel1(ops, nf, { id_type: 'nin', id_number: '22233344455' }, { id_doc: jpeg(7), selfie: jpeg(8) }));
    await rejects(K.attestPresence(ops, nf, { witness_name: 'Alhaji Musa Kano', witness_role: 'Coop chairman', witness_phone: '08077001100', reason: 'no_phone' }));   // no declaration
    await rejects(K.attestPresence(ops, nf, { witness_name: 'Musa', witness_role: 'Coop chairman', witness_phone: '08077001100', reason: 'no_phone', declare: '1' }));
    await K.attestPresence(ops, nf, { witness_name: 'Alhaji Musa Kano', witness_role: 'Coop chairman', witness_phone: '08077001100', reason: 'no_phone', declare: '1' });
    const id = await K.submitLevel1(ops, nf, { id_type: 'nin', id_number: '22233344455' }, { id_doc: jpeg(7), selfie: jpeg(8) });
    eq(await db.val('SELECT phone_check_method FROM kyc_submissions WHERE id=$1', id), 'attested');
    await rejects(K.sendConsentCode(ops, nf, accionId));
    await S.saveSettings(admin, { 'phone_check.attested': '0' });
    eq((await K.phoneMethods()).attested, false);
    await S.saveSettings(admin, { 'phone_check.attested': '1' });
  });
  await t('phone check can be made optional', async () => {
    await S.saveSettings(admin, { 'phone_check.required': '0' });
    const f = await R.createFarmer(ops, { full_name: 'Optional Check', phone: '08012349999' });
    ok(await K.submitLevel1(ops, f, { id_type: 'nin', id_number: '33344455566' }, { id_doc: jpeg(9), selfie: jpeg(10) }));
    await S.saveSettings(admin, { 'phone_check.required': '1' });
  });
  const good = { document: { type_seen: 'nin_slip', legible: true, name_on_document: 'DANLADI Aisha', name_match: 'exact', last4_seen: '4455', year_of_birth_seen: null, expiry_date: null, original_capture: 'yes', original_note: '' }, face_photo: { one_clear_face: true, live_capture: 'yes', quality_note: 'clear' }, concerns: [], suggested_reject_reason: null };
  const rec = { full_name: 'Aisha Danladi', id_type: 'nin', id_last4: '4455', year_of_birth: 1984, state_name: 'Taraba' };
  await t('AI flag is computed from findings, not chosen by the model', () => {
    eq(flagOf(parseFindings(JSON.stringify(good)), rec).flag, 'green');
    eq(flagOf(parseFindings('Here you go: ' + JSON.stringify({ ...good, document: { ...good.document, last4_seen: '9999' } })), rec).flag, 'red');
    eq(flagOf(parseFindings(JSON.stringify({ ...good, document: { ...good.document, original_capture: 'unsure' } })), rec).flag, 'amber');
    eq(flagOf(parseFindings(JSON.stringify({ ...good, document: { ...good.document, type_seen: 'voters_card' } })), rec).flag, 'red');
    eq(flagOf(parseFindings(JSON.stringify({ ...good, document: { ...good.document, expiry_date: '2020-01-01' } })), rec).flag, 'red');
    eq(flagOf(parseFindings(JSON.stringify({ ...good, document: { ...good.document, name_on_document: 'Peter Obi', name_match: 'exact' } })), rec).flag, 'amber', 'cross-checks the model');
    eq(parseFindings(JSON.stringify({ ...good, document: { ...good.document, last4_seen: '222 333 44455' } })).document.last4_seen, '4455', 'never keeps more than 4');
  });
  await t('AI pre-check stores findings, sees both photos, and reviewer agreement is tracked', async () => {
    const id = await db.val<string>(`SELECT k.id FROM kyc_submissions k JOIN farmers f ON f.id=k.farmer_id WHERE f.code=$1`, nf);
    let images = 0;
    const fake: ModelCall = async (_s, content: any[]) => { images = content.filter((x) => x.type === 'image').length; return { text: JSON.stringify({ ...good, document: { ...good.document, name_on_document: 'Bala Nophone' } }), tin: 1000, tout: 200 }; };
    eq(await screenSubmission(id!, fake), 'green'); eq(images, 2);
    const chk = await latestCheck(id!); eq(chk?.flag, 'green');
    await K.review(compliance, id!, 'approve', { checks: ['name_matches', 'face_matches', 'id_original'] });
    eq(await db.val('SELECT reviewer_agreed_with_ai FROM kyc_submissions WHERE id=$1', id), true);
  });
  await t('AI failures and a missing key never block the human review', async () => {
    const f = await R.createFarmer(ops, { full_name: 'Junk Answer', phone: '08012348888' });
    await K.sendPhoneCode(ops, f); await K.confirmPhone(ops, f, lastCode()!);
    const id = await K.submitLevel1(ops, f, { id_type: 'nin', id_number: '44455566677' }, { id_doc: jpeg(11), selfie: jpeg(12) });
    eq(await screenSubmission(id, async () => ({ text: 'I cannot help with that', tin: 1, tout: 1 })), null);
    eq((await latestCheck(id))?.status, 'failed');
    eq(await screenSubmission(id, null), null);
    eq((await latestCheck(id))?.status, 'skipped');
    await S.saveSettings(admin, { 'kyc.ai_mode': 'off' });
    eq(await screenSubmission(id, async () => { throw new Error('should not be called'); }), null);
    await S.saveSettings(admin, { 'kyc.ai_mode': 'assist' });
    ok((await K.reviewQueue(compliance)).some((r) => r.id === id), 'still in the human queue');
  });

  console.log('\nGate app: deliveries');
  await t('the gate app uses only syntax old Android browsers understand (ES5)', () => {
    for (const f of ['public/intake/app.js', 'public/intake/sw.js']) transformSync(fs.readFileSync(f, 'utf8'), { target: 'es5', loader: 'js' });
  });
  await t('the phone app’s SHA-256 and canonical JSON match the server’s', () => {
    const src = fs.readFileSync('public/intake/app.js', 'utf8');
    const grab = (name: string) => { const i = src.indexOf('function ' + name + '('); let d = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') d++; if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
    const kStart = src.indexOf('var K = ['), kEnd = src.indexOf('];', kStart) + 2;
    const ctx: any = { Uint8Array, unescape, encodeURIComponent, JSON, Object };
    vm.runInNewContext(src.slice(kStart, kEnd) + grab('sha256') + grab('utf8') + grab('canonical') + ';this.f={sha256:sha256,utf8:utf8,canonical:canonical};', ctx);
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70001]) { const b = crypto.randomBytes(n); eq(ctx.f.sha256(new Uint8Array(b)), I.sha256hex(b), `length ${n}`); }
    const rec = { z: 1, a: [1.5, null, 'ẹ̀ Ọ̀'], m: { y: true, b: 'x' }, n: null };
    eq(ctx.f.canonical(rec), I.canonical(rec));
    eq(ctx.f.sha256(ctx.f.utf8(I.canonical(rec))), I.sha256hex(I.canonical(rec)));
  });
  const devId = crypto.randomUUID();
  let seq = 0, lastHash: string | null = null;
  const wh = (await db.get<{ id: string }>(`SELECT id FROM warehouses WHERE code='WH-NI-MNA-02'`))!;
  const photo = (n: number) => { const d = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300), Buffer.from([n])]); return { sha: I.sha256hex(d), up: { filename: 'p.jpg', type: 'image/jpeg', data: d } }; };
  function makeRecord(clerk: A.Actor, o: Record<string, any> = {}, x: { chain?: boolean; seqOverride?: number } = {}) {
    const ps = [photo(1), photo(2), photo(3), photo(4)];
    const s = x.seqOverride ?? seq + 1;
    const rec: any = {
      v: 1, id: crypto.randomUUID(), device_id: devId, device_seq: s, prev_hash: lastHash, warehouse_id: wh.id, farmer_code: ada, commodity_code: 'MAZ',
      weighings: [{ bags: 10, gross_kg: 1005.5, photo: ps[0].sha }], tare_per_bag_kg: 0.5, moisture_pct: 12.5, moisture_photo: ps[1].sha, foreign_matter_pct: 1, damaged_pct: null,
      grade: 'A', stack_ref: 'B3', notes: null, bag_photos: [ps[2].sha], farmer_confirmation: 'paper_slip', slip_photo: ps[3].sha, confirm_token: null,
      captured_at: new Date(Date.now() - 600000).toISOString(), started_at: new Date(Date.now() - 1200000).toISOString(), gps: { lat: 9.6105, lng: 6.5502, acc: 12 }, gps_note: null, clerk_user_id: clerk.user.id, ...o,
    };
    rec.evidence_hash = I.recordHash(rec);
    const files: Record<string, any> = {}; for (const p of ps) files['p_' + p.sha] = p.up;
    if (x.chain !== false) { seq = s; lastHash = rec.evidence_hash; }
    return { rec, json: JSON.stringify(rec), files };
  }
  let firstRef = '';
  await t('a sealed delivery uploads, computes net weight, and re-upload is harmless', async () => {
    const b = await I.bootstrap(ops);
    ok(b.warehouses.some((w: any) => w.id === wh.id)); ok(b.farmers.length > 0); ok(!JSON.stringify(b.farmers).includes('+234'), 'no full phones on the device');
    const r1 = makeRecord(ops);
    const out = await I.ingest(ops, r1.json, r1.files, { deviceClock: new Date().toISOString() });
    eq(out.result, 'stored'); firstRef = out.ref;
    eq(out.flags.map((f) => f.code), [], 'clean delivery has no flags');
    const row = await db.get<any>('SELECT net_kg::float AS net, bags FROM intakes WHERE id=$1', r1.rec.id);
    eq(row.net, 1000.5); eq(row.bags, 10);
    eq((await I.ingest(ops, r1.json, r1.files)).result, 'duplicate');
    const changed = { ...r1.rec, notes: 'x' }; changed.evidence_hash = I.recordHash(changed);
    ok((await rejects(I.ingest(ops, JSON.stringify(changed), r1.files))) instanceof I.Conflict);
  });
  await t('changed numbers, swapped photos and another person’s records are refused', async () => {
    const r = makeRecord(ops, {}, { chain: false });
    const tampered = JSON.parse(r.json); tampered.weighings[0].gross_kg = 1500;
    await rejects(I.ingest(ops, JSON.stringify(tampered), r.files));
    const sha = r.rec.weighings[0].photo; const files = { ...r.files, ['p_' + sha]: photo(9).up };
    await rejects(I.ingest(ops, r.json, files));
    await rejects(I.ingest(compliance, r.json, r.files));
  });
  await t('rules flag the reviewer: moisture, distance, duplicate, unverified farmer, deleted records', async () => {
    const r = makeRecord(ops, { moisture_pct: 15.5, gps: { lat: 9.9, lng: 6.9, acc: 20 } });
    const flags = (await I.ingest(ops, r.json, r.files)).flags.map((f) => f.code);
    ok(flags.includes('moisture_over_limit') && flags.includes('far_from_warehouse') && flags.includes('possible_duplicate'), flags.join());
    const nobody = await R.createFarmer(ops, { full_name: 'Level Zero', state_code: 'NI' });
    seq += 2;   // two records "deleted" on the phone
    const r2 = makeRecord(ops, { farmer_code: nobody, weighings: [{ bags: 4, gross_kg: 402, photo: undefined }] }, { seqOverride: seq + 1 });
    r2.rec.weighings[0].photo = Object.keys(r2.files)[0].slice(2); r2.rec.evidence_hash = I.recordHash(r2.rec); lastHash = r2.rec.evidence_hash;
    const f2 = (await I.ingest(ops, JSON.stringify(r2.rec), r2.files)).flags.map((f) => f.code);
    ok(f2.includes('farmer_not_verified') && f2.includes('device_chain_gap'), f2.join());
  });
  await t('uploaded deliveries are sealed: facts cannot be edited or deleted', async () => {
    await rejects(db.run(`UPDATE intakes SET net_kg=5000 WHERE ref=$1`, firstRef));
    await rejects(db.run(`DELETE FROM intakes WHERE ref=$1`, firstRef));
    await rejects(db.run(`DELETE FROM intake_photos`));
  });
  await t('review: never by the clerk; serious flags need a reason to accept', async () => {
    await rejects(I.reviewIntake(ops, firstRef, 'accept', ''));
    await I.reviewIntake(admin, firstRef, 'accept', '');
    eq(await db.val('SELECT status FROM intakes WHERE ref=$1', firstRef), 'accepted');
    await rejects(I.reviewIntake(admin, firstRef, 'reject', 'x y z'));
    const held = await db.val<string>(`SELECT ref FROM intakes WHERE flags::text LIKE '%moisture_over_limit%'`);
    await rejects(I.reviewIntake(admin, held!, 'accept', ''));
    await I.reviewIntake(admin, held!, 'hold', 'Dry to 13% and re-test');
  });
  await t('farmer confirms by phone code at the gate', async () => {
    const r = makeRecord(ops, { farmer_confirmation: 'code', slip_photo: null, confirm_token: 'bad.token', weighings: [{ bags: 2, gross_kg: 201, photo: undefined }] }, { chain: false });
    await I.sendConfirmCode(ops, ada, 'sms');
    const token = await I.verifyConfirmCode(ops, ada, r.rec.id, lastCode()!);
    const sha = Object.keys(r.files)[0].slice(2);
    const good = { ...r.rec, confirm_token: token, weighings: [{ bags: 2, gross_kg: 201, photo: sha }], device_seq: seq + 1, prev_hash: lastHash };
    good.evidence_hash = I.recordHash(good);
    const badRec = { ...good, confirm_token: 'bad.token' }; badRec.evidence_hash = I.recordHash(badRec);
    await rejects(I.ingest(ops, JSON.stringify(badRec), r.files));
    eq((await I.ingest(ops, JSON.stringify(good), r.files)).result, 'stored');
    seq += 1; lastHash = good.evidence_hash;
  });
  await t('AI reading of the scale and moisture photos flags typed numbers that differ', async () => {
    const r = makeRecord(ops, { weighings: [{ bags: 3, gross_kg: 300, photo: undefined }] }, { chain: false });
    const sha = Object.keys(r.files)[0].slice(2);
    const rec = { ...r.rec, weighings: [{ bags: 3, gross_kg: 300, photo: sha }], device_seq: seq + 1, prev_hash: lastHash }; rec.evidence_hash = I.recordHash(rec);
    await I.ingest(ops, JSON.stringify(rec), r.files); seq += 1; lastHash = rec.evidence_hash;
    const says = (scale: number | null, moisture: number | null) => async () => ({ text: JSON.stringify({ readings: [{ photo: 1, value: scale, confident: scale !== null }, { photo: 2, value: moisture, confident: true }] }), tin: 1, tout: 1 });
    eq(await screenIntake(rec.id, says(300, 12.5)), 'match');
    eq(await screenIntake(rec.id, says(380, 12.5)), 'mismatch');
    const fl = await db.val<any>('SELECT flags FROM intakes WHERE id=$1', rec.id);
    ok(fl.some((f: any) => f.code === 'display_mismatch' && f.detail.includes('380')));
    eq(await screenIntake(rec.id, says(null, 12.5)), 'unreadable');
    eq(await screenIntake(rec.id, null), null);
  });
  await t('warehouse operators record only at their own warehouses', async () => {
    const opId = await db.val<string>(`SELECT id FROM organisations WHERE code='KITWH'`);
    const clerk = await makeUser(admin, 'clerk@kitwh.test', opId!, 'warehouse_clerk');
    eq((await I.bootstrap(clerk)).warehouses.map((w: any) => w.id), [wh.id]);
    await rejects(I.bootstrap(officer));
    const otherOp = await A.createOrg(admin, { code: 'OTHERWH', name: 'Other Stores', kind: 'warehouse_operator' });
    const clerk2 = await makeUser(admin, 'clerk@other.test', otherOp, 'warehouse_clerk');
    const r = makeRecord(clerk2, {}, { chain: false, seqOverride: 1 });
    const rec = { ...r.rec, device_id: crypto.randomUUID(), prev_hash: null }; rec.evidence_hash = I.recordHash(rec);
    await rejects(I.ingest(clerk2, JSON.stringify(rec), r.files));
  });

  console.log('\nPartner applications');
  await t('public application → approve creates the org and an admin invitation', async () => {
    eq(await P.submitApplication({ kind: 'lender', org_name: 'Bot Bank', contact_name: 'Bot', email: 'b@b.co', phone: '08011112222', agree: '1', website: 'http://spam' }, '9.9.9.9'), 'spam');
    await rejects(P.submitApplication({ kind: 'kitovu', org_name: 'X Org', contact_name: 'X Y', email: 'x@y.co', phone: '08011112222', agree: '1' }, '9.9.9.9'));
    eq(await P.submitApplication({ kind: 'lender', org_name: 'LAPO Microfinance Bank', contact_name: 'Grace Obi', email: 'grace@lapo.test', phone: '08011112222', state_code: 'ED', agree: '1', about: 'National MFB' }, '9.9.9.9'), 'ok');
    const [app] = await P.listApplications(admin);
    await rejects(P.approveApplication(ops, app.id, {}));
    const r = await P.approveApplication(admin, app.id, {});
    eq(r.code, 'LMB');
    const inv = await A.findInvite(r.link.split('/invite/')[1]);
    eq(inv?.role, 'lender_admin'); eq(inv?.email, 'grace@lapo.test');
    eq(await db.val(`SELECT status FROM organisations WHERE code='LMB'`), 'onboarding');
    await rejects(P.approveApplication(admin, app.id, {}));
  });

  console.log('\nSMS second step');
  await t('a low-risk role can use SMS codes; gaining a sensitive role turns them off', async () => {
    const { link } = await A.invite(admin, { email: 'grace.v@accion.test', fullName: 'Viewer', orgId: accionId, role: 'lender_viewer' });
    await A.acceptInvite(link.split('/invite/')[1], 'harmattan mornings in jos', '1.1.1.1');
    let u = await A.login('grace.v@accion.test', 'harmattan mornings in jos', '1.1.1.1');
    eq(u.factor, null);
    await A.sendLoginSms(u.id, '0807 000 1111');
    await rejects(A.confirmSmsEnrolment(u.id, '000000', sys), 'code');
    const codes = await A.confirmSmsEnrolment(u.id, lastCode()!, sys);
    eq(codes.length, 10);
    u = await A.login('grace.v@accion.test', 'harmattan mornings in jos', '1.1.1.1');
    eq(u.factor, 'sms'); eq(u.phone_e164, '+2348070001111');
    await A.sendLoginSms(u.id, '08099999999');   // codes go only to the enrolled number
    eq(sentForTests.at(-1)!.to, '+2348070001111');
    ok(!(await A.verifySecondFactor(u.id, '000000', sys)));
    await A.sendLoginSms(u.id);
    ok(await A.verifySecondFactor(u.id, lastCode()!, sys));
    await db.run(`UPDATE memberships SET role='credit_officer' WHERE user_id=$1`, u.id);
    eq((await A.login('grace.v@accion.test', 'harmattan mornings in jos', '1.1.1.1')).factor, null, 'must set up an authenticator now');
    await A.sendLoginSms(u.id).then(() => { throw new Error('sent'); }, (e) => eq(e.code, 'forbidden'));
    await rejects(A.sendLoginSms(ops.user.id, '08011110000'), 'forbidden');
  });

  console.log('\nHTTP');
  await db.run('DELETE FROM rate_limits');
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar: Record<string, string> = {};
  async function req(method: string, path: string, form?: Record<string, string>) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams({ _csrf: jar.sx_csrf ? decodeURIComponent(jar.sx_csrf) : '', ...form }).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v; }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }

  await t('health, security headers, and redirects to sign-in', async () => {
    eq((await req('GET', '/healthz')).status, 200);
    const r = await req('GET', '/app');
    eq(r.status, 303); ok(r.location?.startsWith('/login?next=%2Fapp'));
    ok(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    eq((await req('GET', '/nope')).status, 404);
  });
  await t('forms without the CSRF token are refused', async () => {
    await req('GET', '/login');
    const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `sx_csrf=${jar.sx_csrf}` }, body: 'email=a&password=b' });
    eq(res.status, 403);
  });
  await t('browser sign-in: password, then code, then home', async () => {
    const r1 = await req('POST', '/login?next=/admin/people', { email: 'admin@kitovu.com.ng', password: admin.password });
    eq(r1.status, 303); ok(r1.location?.startsWith('/login/2fa'));
    eq((await req('GET', '/admin/people')).status, 303, 'blocked until second step');
    const r2 = await req('POST', '/login/2fa?next=/admin/people', { code: totpCode(admin.secret) });
    eq(r2.status, 303); eq(r2.location, '/admin/people');
    const page = await req('GET', '/admin/people'); eq(page.status, 200); ok(page.text.includes('Invite someone'));
    eq((await req('GET', '/admin/audit')).status, 200);
  });
  await t('a lender admin cannot open Kitovu-only pages', async () => {
    await req('POST', '/logout', {});
    await req('POST', '/login', { email: 'officer2@accion.test', password: 'x' });
    const officer = await makeUser(accionAdmin, 'officer2@accion.test', accionId, 'credit_officer');
    await req('POST', '/login', { email: 'officer2@accion.test', password: officer.password });
    await req('POST', '/login/2fa', { code: totpCode(officer.secret) });
    eq((await req('GET', '/app')).status, 200);
    eq((await req('GET', '/admin/orgs')).status, 403);
    eq((await req('GET', '/admin/people')).status, 403);
  });

  await t('public apply form works signed out; honeypot is silent', async () => {
    await req('POST', '/logout', {});
    const g = await req('GET', '/apply'); eq(g.status, 200); ok(g.text.includes('Partner with StorageX'));
    const p = await req('POST', '/apply', { kind: 'warehouse_operator', org_name: 'Kebbi Stores Ltd', contact_name: 'Sani Bala', email: 'sani@kebbi.test', phone: '08033334444', agree: '1' });
    eq(p.status, 303); eq(p.location, '/apply/thanks');
    eq((await req('POST', '/apply', { kind: 'lender', org_name: '', contact_name: '', email: 'no', phone: '1', agree: '1' })).status, 400);
  });
  async function signInAs(u: A.Actor) {
    const tok = await A.completeSecondFactor(await A.createSession(u.user.id, '127.0.0.1', 'test'), sys);
    jar.sx_sid = tok;
  }
  await t('upload an ID check through the form; only compliance can open the photo', async () => {
    await signInAs(ops);
    const code = await R.createFarmer(ops, { full_name: 'Uche Form', phone: '08044445555', state_code: 'EN' });
    await K.sendPhoneCode(ops, code); await K.confirmPhone(ops, code, lastCode()!);
    const page = await req('GET', `/farmers/${code}`); eq(page.status, 200); ok(page.text.includes('Send for review'));
    const fd = new FormData();
    fd.set('_csrf', decodeURIComponent(jar.sx_csrf)); fd.set('id_type', 'drivers_licence'); fd.set('id_number', 'ABC12345XY');
    fd.set('id_doc', new Blob([jpeg(5).data], { type: 'image/jpeg' }), 'id.jpg'); fd.set('selfie', new Blob([jpeg(6).data], { type: 'image/jpeg' }), 'me.jpg');
    const up = await fetch(base + `/farmers/${code}/kyc`, { method: 'POST', redirect: 'manual', body: fd, headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    eq(up.status, 303);
    const k = await db.get<any>(`SELECT k.* FROM kyc_submissions k JOIN farmers f ON f.id=k.farmer_id WHERE f.code=$1`, code);
    ok(k, 'submission stored'); eq(k.id_last4, '45XY');
    eq((await req('GET', `/files/${k.id_doc_file_id}`)).status, 404, 'ops cannot open ID photos');
    await signInAs(compliance);
    const q = await req('GET', '/kyc/review'); ok(q.text.includes('Uche Form'));
    const img = await req('GET', `/files/${k.id_doc_file_id}`); eq(img.status, 200); eq(img.headers.get('content-type'), 'image/jpeg');
    ok(await db.val(`SELECT 1 FROM audit_log WHERE action='file.viewed'`), 'opening is logged');
    await signInAs(officer);
    eq((await req('GET', `/files/${k.id_doc_file_id}`)).status, 404);
    eq((await req('GET', `/farmers/${code}`)).status, 404, 'no consent, no record');
    eq((await req('GET', '/kyc/review')).status, 403);
    delete jar.sx_sid;
  });

  await t('gate app: shell is public, data needs sign-in, upload works over HTTP', async () => {
    const shell = await req('GET', '/intake/'); eq(shell.status, 200); ok(shell.text.includes('/intake/app.js'));
    eq((await req('GET', '/intake/sw.js')).status, 200);
    eq((await req('GET', '/api/intake/bootstrap')).status, 303, 'signed out → sign-in');
    await signInAs(ops);
    const boot = await fetch(base + '/api/intake/bootstrap', { headers: { accept: 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    const bj: any = await boot.json(); ok(bj.csrf && bj.warehouses.length);
    const r = makeRecord(ops);
    const fd = new FormData(); fd.set('_csrf', bj.csrf); fd.set('record', r.json); fd.set('device_clock', new Date().toISOString());
    for (const [k, v] of Object.entries(r.files) as any) fd.set(k, new Blob([v.data], { type: 'image/jpeg' }), 'p.jpg');
    const up = await fetch(base + '/api/intake', { method: 'POST', body: fd, headers: { accept: 'application/json', 'x-csrf-token': bj.csrf, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    const uj: any = await up.json(); eq(up.status, 200, JSON.stringify(uj)); eq(uj.result, 'stored');
    const bad = await fetch(base + '/api/intake', { method: 'POST', body: (() => { const f = new FormData(); f.set('_csrf', bj.csrf); f.set('record', '{}'); return f; })(), headers: { accept: 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    eq(bad.status, 400); ok(((await bad.json()) as any).error);
    const page = await req('GET', `/intakes/${uj.ref}`); eq(page.status, 200); ok(page.text.includes('Weighings'));
    delete jar.sx_sid;
  });
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await closePool();
  if (fail) process.exitCode = 1;
}

async function totpNowFor(userId: string) { return totpNow(userId); }

main().catch(async (e) => { console.error(e); await closePool(); process.exitCode = 1; });
