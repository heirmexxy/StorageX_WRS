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
import * as Rc from '../src/lib/receipts';
import * as St from '../src/lib/stock';
import * as V from '../src/lib/valuation';
import * as F from '../src/lib/finance';
import * as SL from '../src/lib/settlement';
import * as Tw from '../src/lib/tower';
import * as N from '../src/lib/notify';
import * as U from '../src/lib/ussd';
import * as INS from '../src/lib/agents/intake-inspector';
import * as DS from '../src/lib/agents/data-steward';
import { reviewLine } from '../src/lib/agents/batch-review';
import { verify as sigVerify } from '../src/lib/sign';
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
    eq(out.flags.map((f) => f.code).filter((c) => !['night_capture', 'clerk_burst'].includes(c)), [], 'clean delivery has no flags (apart from ones that depend on the time the tests run)');
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


  console.log('\nReceipts and the Receipt Passport');
  await t('splitting a delivery into lots keeps every kilo and bag', () => {
    eq(Rc.lotsFor(1000.5, 10, ''), [{ kg: 1000.5, bags: 10 }]);
    const two = Rc.lotsFor(1000.5, 10, '2'); eq(two.map((l) => l.kg), [500.25, 500.25]); eq(two[0].bags + two[1].bags, 10);
    const three = Rc.lotsFor(1000, 7, '3'); eq(Math.round(three.reduce((s, l) => s + l.kg, 0) * 100) / 100, 1000); eq(three.reduce((s, l) => s + l.bags, 0), 7);
    eq(Rc.lotsFor(1000.5, 10, '600, 400.5').map((l) => l.kg), [600, 400.5]);
    let threw = false; try { Rc.lotsFor(1000.5, 10, '600, 400'); } catch { threw = true; } ok(threw, 'weights must add up');
    threw = false; try { Rc.lotsFor(100, 2, '3'); } catch { threw = true; } ok(threw, 'not more receipts than bags');
  });
  const accepted = (await db.get<{ id: string }>('SELECT id FROM intakes WHERE ref=$1', firstRef))!;
  let rno = '', rno2 = '';
  await t('issue: never by the clerk, only from accepted deliveries, once', async () => {
    await rejects(Rc.issueFromIntake(ops, accepted.id));
    const heldId = await db.val<string>(`SELECT id FROM intakes WHERE status='held' LIMIT 1`);
    await rejects(Rc.issueFromIntake(admin, heldId!));
    await rejects(Rc.issueFromIntake(officer, accepted.id));
    const r = await Rc.issueFromIntake(admin, accepted.id, '2');
    eq(r.receipts.length, 2); rno = r.receipts[0].no; rno2 = r.receipts[1].no;
    ok(/^SX-NI-MNA-\d{6}-0001$/.test(rno), rno); ok(rno2.endsWith('-0002'));
    eq(Number(await db.val(`SELECT sum(net_weight_kg) FROM receipts WHERE intake_id=$1`, accepted.id)), 1000.5);
    await rejects(Rc.issueFromIntake(admin, accepted.id));
  });
  await t('receipt facts are signed, frozen, and the history chain verifies', async () => {
    const r = (await Rc.receiptByNo(admin, rno))!;
    ok(sigVerify(Rc.signedFacts(r), r.signature!));
    ok(!sigVerify(Rc.signedFacts({ ...r, net_weight_kg: '9999' }), r.signature!), 'changed weight breaks the signature');
    await rejects(db.run(`UPDATE receipts SET net_weight_kg=9999 WHERE id=$1`, r.id));
    await rejects(db.run(`DELETE FROM receipts WHERE id=$1`, r.id));
    await rejects(db.run(`UPDATE receipt_events SET data='{}' WHERE receipt_id=$1`, r.id));
    ok(await Rc.chainOk(r.id));
    // Someone with database owner rights bypasses the guard: the chain check still catches it.
    await db.run('ALTER TABLE receipt_events DISABLE TRIGGER receipt_events_append_only');
    await db.run(`UPDATE receipt_events SET data = data || '{"net_kg": 5000}' WHERE receipt_id=$1`, r.id);
    ok(!(await Rc.chainOk(r.id)), 'tampering detected');
    const p = await Rc.passport(r.verify_token, undefined, '7.7.7.7');
    eq(p!.chain_ok, false);
    await db.run(`UPDATE receipt_events SET data = data - 'net_kg' WHERE receipt_id=$1`, r.id);
    await db.run(`UPDATE receipt_events SET data = data || jsonb_build_object('net_kg', 500.25) WHERE receipt_id=$1`, r.id);
    await db.run('ALTER TABLE receipt_events ENABLE TRIGGER receipt_events_append_only');
    ok(await Rc.chainOk(r.id), 'restored');
  });
  await t('Receipt Passport: public facts, QR signature check, no personal details', async () => {
    const r = (await Rc.receiptByNo(admin, rno))!;
    const p = (await Rc.passport(r.verify_token, r.signature!, '7.7.7.7'))!;
    eq(p.view.label, 'Valid'); eq(p.qr_sig, 'match'); eq(p.signature_ok, true); eq(p.lot, '1 of 2');
    ok(p.owner.startsWith('A. O.'), p.owner); ok(!JSON.stringify(p).includes('+234'));
    eq((await Rc.passport(r.verify_token, r.signature!.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')), '7.7.7.7'))!.qr_sig, 'mismatch');
    eq(await Rc.passport('0'.repeat(32), undefined, '7.7.7.7'), null);
  });
  await t('cancel: by someone other than the issuer; the public page says Cancelled', async () => {
    await rejects(Rc.cancelReceipt(admin, rno2, 'Issued in error during testing'));
    await rejects(Rc.cancelReceipt(ops, rno2, 'short'));
    await Rc.cancelReceipt(ops, rno2, 'Issued in error during testing');
    const r = (await Rc.receiptByNo(admin, rno2))!;
    eq((await Rc.passport(r.verify_token, undefined, '7.7.7.7'))!.view.label, 'Cancelled');
    eq((await Rc.eventsOf(r.id)).map((e) => e.event_type), ['issued', 'cancelled']);
    ok(await Rc.chainOk(r.id));
  });
  await t('who sees receipts: Kitovu all, lenders only with the farmer’s consent', async () => {
    ok((await Rc.listReceipts(admin)).some((r) => r.receipt_no === rno));
    eq((await Rc.listReceipts(officer)).length, 0);
    await K.sendConsentCode(ops, ada, accionId); await K.recordConsent(ops, ada, { org_id: accionId, method: 'sms_code', otp: lastCode(), read_aloud: '1' });
    ok((await Rc.listReceipts(officer)).some((r) => r.receipt_no === rno));
  });
  await t('printable PDF', async () => {
    const { pdf } = await Rc.receiptPdf(admin, rno);
    ok(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.includes(Buffer.from(rno)) && pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
  });

  console.log('\nStock control');
  const whRow = (await db.get<{ id: string }>(`SELECT id FROM warehouses WHERE code='WH-NI-MNA-02'`))!;
  const kitwh = (await db.val<string>(`SELECT id FROM organisations WHERE code='KITWH'`))!;
  const gateClerk = await makeUser(admin, 'gate@kitwh.test', kitwh, 'warehouse_clerk');
  const stackId = async (code: string) => (await db.val<string>('SELECT id FROM stacks WHERE warehouse_id=$1 AND code=$2', whRow.id, code))!;
  await t('accepted deliveries enter the ledger on the stack the clerk named', async () => {
    const b3 = (await St.stacksOf(whRow.id)).find((s) => s.code === 'B3');
    ok(b3, 'stack B3 created from the delivery'); eq(b3.kg, 1000.5); eq(b3.bags, 10);
    const r = (await St.reconcile(whRow.id)).find((x) => x.commodity_code === 'MAZ')!;
    eq(r.owed_kg, 500.25, 'one live receipt (the other was cancelled)');
    ok(r.flags.some((f: any) => f.text.includes('not counted')));
    await rejects(db.run('UPDATE stock_moves SET kg = 1 WHERE warehouse_id=$1', whRow.id));
  });
  await t('counts estimate weight from a weighed sample and flag shortfalls against receipts', async () => {
    const b3 = await stackId('B3');
    const c1 = await St.recordCount(gateClerk, whRow.id, { stack: b3, bags: '10', sample_bags: '5', sample_kg: '500' });
    eq(c1.est, 1000); eq(c1.diff, -0.5);
    ok(!(await St.reconcile(whRow.id)).find((x) => x.commodity_code === 'MAZ')!.flags.some((f: any) => f.severity === 'hold'));
    await St.recordCount(gateClerk, whRow.id, { stack: b3, bags: '4', sample_bags: '4', sample_kg: '400' });
    const fl = (await St.reconcile(whRow.id)).find((x) => x.commodity_code === 'MAZ')!.flags;
    ok(fl.some((f: any) => f.severity === 'hold' && f.text.includes('short')), JSON.stringify(fl));
    await St.recordCount(gateClerk, whRow.id, { stack: b3, bags: '10', sample_bags: '5', sample_kg: '500' });
    await rejects(St.recordCount(officer, whRow.id, { stack: b3, bags: '1' }));
  });
  await t('moving stock between stacks keeps the total', async () => {
    await St.createStack(gateClerk, whRow.id, 'b4', 'MAZ');
    await rejects(St.createStack(gateClerk, whRow.id, 'B4', 'MAZ'));
    await St.transfer(gateClerk, whRow.id, { from: await stackId('B3'), to: await stackId('B4'), kg: '200', bags: '2' });
    await rejects(St.transfer(gateClerk, whRow.id, { from: await stackId('B4'), to: await stackId('B3'), kg: '5000' }));
    const st = await St.stacksOf(whRow.id);
    eq(st.find((s) => s.code === 'B3').kg, 800.5); eq(st.find((s) => s.code === 'B4').kg, 200);
  });
  await t('losses post only after a different Kitovu person approves', async () => {
    await St.proposeAdjustment(gateClerk, whRow.id, { stack: await stackId('B4'), kg: '-10', reason: 'moisture_loss', note: 'Dried down in the harmattan, reweighed 5 bags' });
    await rejects(St.proposeAdjustment(gateClerk, whRow.id, { stack: await stackId('B4'), kg: '50', reason: 'other', note: 'Found some extra maize' }));
    const [x] = await St.pendingAdjustments(whRow.id);
    eq((await St.stacksOf(whRow.id)).find((s) => s.code === 'B4').kg, 200, 'not yet posted');
    await rejects(St.decideAdjustment(gateClerk, x.id, true, ''));
    await St.decideAdjustment(ops, x.id, true, 'Checked the sample weights');
    eq((await St.stacksOf(whRow.id)).find((s) => s.code === 'B4').kg, 190);
  });
  await t('release: ordered by Kitovu, loaded by someone else, receipt reduced then closed', async () => {
    const r = (await Rc.receiptByNo(admin, rno))!;
    await rejects(St.orderRelease(officer, rno, { kg: '100', reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
    await rejects(St.orderRelease(ops, rno, { kg: '600', reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
    const o = await St.orderRelease(ops, rno, { kg: '300', reason: 'owner_withdrawal', collector_name: 'Ada Okafor', collector_phone: '08031234567' });
    ok(/^REL-\d{6}-\d{3}$/.test(o.ref));
    await rejects(Rc.cancelReceipt(admin, rno, 'Trying to cancel with a release pending'));
    const files = { scale: photo(31).up, slip: photo(32).up };
    await rejects(St.confirmLoading(ops, o.ref, { stack: await stackId('B3'), kg: '300', bags: '3' }, files));
    await rejects(St.confirmLoading(gateClerk, o.ref, { stack: await stackId('B3'), kg: '330', bags: '3' }, files));
    const done = await St.confirmLoading(gateClerk, o.ref, { stack: await stackId('B3'), kg: '300.5', bags: '3' }, files);
    eq(done.closed, false); eq(done.remaining, 199.75, 'reduced by what was actually weighed out');
    eq((await Rc.receiptByNo(admin, rno))!.status, 'partially_released');
    const p = (await Rc.passport(r.verify_token, undefined, '8.8.8.8'))!;
    eq(p.view.label, 'Partly withdrawn'); eq(p.held_kg, 199.75);
    const o2 = await St.orderRelease(ops, rno, { reason: 'owner_withdrawal', collector_name: 'Ada Okafor' });
    const d2 = await St.confirmLoading(gateClerk, o2.ref, { stack: await stackId('B3'), kg: '199.75', bags: '2' }, { scale: photo(33).up, slip: photo(34).up });
    eq(d2.closed, true);
    eq((await Rc.receiptByNo(admin, rno))!.status, 'closed');
    eq((await Rc.eventsOf(r.id)).map((e) => e.event_type), ['issued', 'released', 'closed']);
    ok(await Rc.chainOk(r.id));
    eq((await St.stacksOf(whRow.id)).find((s) => s.code === 'B3').kg, 300.25);
    await rejects(St.orderRelease(ops, rno, { kg: '1', reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
  });
  await t('stock in doubt: put receipts under review, then restore them', async () => {
    const codeIntake = (await db.get<{ id: string; ref: string }>(`SELECT id, ref FROM intakes WHERE farmer_confirmation='code' LIMIT 1`))!;
    await I.reviewIntake(admin, codeIntake.ref, 'accept', 'ok');
    const iss = await Rc.issueFromIntake(admin, codeIntake.id);
    const no = iss.receipts[0].no;
    eq(await St.setUnderReview(ops, whRow.id, 'MAZ', true, 'Count came up short on stack B3, investigating'), 1);
    const r = (await Rc.receiptByNo(admin, no))!;
    eq(r.status, 'under_exception');
    eq((await Rc.passport(r.verify_token, undefined, '8.8.8.8'))!.view.label, 'Under review');
    await rejects(St.orderRelease(ops, no, { reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
    eq(await St.setUnderReview(ops, whRow.id, 'MAZ', false, 'Recount matched, stock confirmed'), 1);
    eq((await Rc.receiptByNo(admin, no))!.status, 'issued');
    ok(await Rc.chainOk(r.id));
  });

  const withPhoto = (r: { rec: any; files: Record<string, any> }, from: { files: Record<string, any> }, sha: string) => {
    r.rec.weighings[0].photo = sha; r.rec.evidence_hash = I.recordHash(r.rec);
    if (lastHash !== null && seq === r.rec.device_seq) lastHash = r.rec.evidence_hash;
    r.files['p_' + sha] = from.files['p_' + sha];
    const used = JSON.stringify(r.rec);
    for (const k of Object.keys(r.files)) if (!used.includes(k.slice(2))) delete r.files[k];
    return JSON.stringify(r.rec);
  };
  let insRef = '';
  await t('intake inspector: a photo used twice holds the delivery; compliance clears it, then operations accept', async () => {
    const a = makeRecord(ops, { weighings: [{ bags: 12, gross_kg: 1302.5, photo: '' }] });
    const aSha = Object.keys(a.files)[0].slice(2);
    const aJson = withPhoto(a, a, aSha);
    eq((await I.ingest(ops, aJson, a.files)).result, 'stored');
    const b = makeRecord(ops, { stack_ref: 'INS-1', weighings: [{ bags: 15, gross_kg: 1777.5, photo: '' }] });
    const out = await I.ingest(ops, withPhoto(b, a, aSha), b.files);
    ok(out.flags.some((f) => f.code === 'photo_reused' && f.severity === 'hold'), JSON.stringify(out.flags));
    eq(out.status, 'held');
    insRef = out.ref;
    const i = (await I.intakeByRef(admin, insRef))!;
    ok(i.inspection.version === INS.VERSION && i.inspection.checks.includes('farmer_two_places'));
    ok(String(i.review_note).includes('intake inspector'));
    await rejects(I.reviewIntake(admin, insRef, 'accept', 'looks fine to me'));
    await rejects(I.clearHold(admin, insRef, 'short'));
    await rejects(I.clearHold(ops, insRef, 'I recorded it and it is fine, honestly'));
    await rejects(db.run(`UPDATE intakes SET status='accepted', reviewed_by=$2, reviewed_at=now() WHERE ref=$1`, insRef, admin.user.id));
    await rejects(db.run(`UPDATE intakes SET net_kg=1 WHERE ref=$1`, insRef));
    await I.clearHold(compliance, insRef, 'Called the farmer: two deliveries that day, clerk reused the scale photo by mistake.');
    await rejects(I.clearHold(compliance, insRef, 'Called the farmer again and it is still fine.'));
    eq((await I.intakeByRef(admin, insRef))!.status, 'submitted');
    await I.reviewIntake(admin, insRef, 'accept', 'Compliance cleared it; stock seen in B3');
    eq((await I.intakeByRef(admin, insRef))!.status, 'accepted');
    await rejects(db.run(`UPDATE intakes SET hold_cleared_by=NULL WHERE ref=$1`, insRef));
  });
  await t('intake inspector: more stock than the warehouse holds is held; copied weights are flagged', async () => {
    const cap = await db.val(`SELECT capacity_kg FROM warehouses WHERE id=$1`, wh.id);
    await db.run(`UPDATE warehouses SET capacity_kg=2000 WHERE id=$1`, wh.id);
    try {
      const r = makeRecord(ops, { weighings: [{ bags: 20, gross_kg: 2310.5, photo: '' }] });
      const out = await I.ingest(ops, withPhoto(r, r, Object.keys(r.files)[0].slice(2)), r.files);
      ok(out.flags.some((f) => f.code === 'over_capacity'), JSON.stringify(out.flags)); eq(out.status, 'held');
    } finally { await db.run(`UPDATE warehouses SET capacity_kg=$2 WHERE id=$1`, wh.id, cap); }
    const other = (await db.val<string>(`SELECT code FROM farmers WHERE code<>$1 AND status='active' ORDER BY code LIMIT 1`, ada))!;
    const r2 = makeRecord(ops, { farmer_code: other, weighings: [{ bags: 15, gross_kg: 1777.5, photo: '' }] });
    const out2 = await I.ingest(ops, withPhoto(r2, r2, Object.keys(r2.files)[0].slice(2)), r2.files);
    ok(out2.flags.some((f) => f.code === 'repeated_weights' && f.severity === 'review'), JSON.stringify(out2.flags));
  });


  console.log('\nValuation');
  await t('median, unit conversion and rounding never over-lend', () => {
    eq(V.median([3, 1, 2]), 2); eq(V.median([1, 2, 3, 4]), 3); eq(V.median([]), null);
    const ref: any = { kobo_per_kg: 45000 };
    const v = V.compute(201, ref, { haircut_bp: 1500, max_ltv_bp: 7000 });
    eq(v.market, 9045000); eq(v.lending, 7688250); eq(v.maxLoan, 5381775);
    eq(V.compute(1, { kobo_per_kg: 3 } as any, { haircut_bp: 1500, max_ltv_bp: 7000 }).lending, 2, 'haircut rounds up');
  });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const src = (await V.sources())[0].id;
  const enter = (who: A.Actor, state: string, naira: string, extra: Record<string, string> = {}) =>
    V.addObservation(who, { commodity: 'MAZ', state, market: `Market ${state}`, source: src, price: naira, unit: 'bag_100kg', observed_on: today, ...extra });
  await t('prices: entered by one person, approved by another; enough of them before a value', async () => {
    await rejects(enter(officer, 'NI', '45000'));
    const p1 = await enter(ops, 'NI', '45000');
    eq(p1.perKg, 45000);
    await rejects(V.decideObservation(ops, p1.id, true, ''));
    await V.decideObservation(admin, p1.id, true, '');
    eq((await V.referencePrice('MAZ', 'NI')).scope, 'none', 'one price is not enough');
    const p2 = await enter(ops, 'KD', '43000'); await V.decideObservation(admin, p2.id, true, '');
    const nat = await V.referencePrice('MAZ', 'NI'); eq(nat.scope, 'national'); eq(nat.kobo_per_kg, 44000);
    const p3 = await enter(ops, 'NI', '46000'); await V.decideObservation(admin, p3.id, true, '');
    const st = await V.referencePrice('MAZ', 'NI'); eq(st.scope, 'state'); eq(st.kobo_per_kg, 45500);
    await rejects(enter(ops, 'NI', '90000'));
    ok((await enter(ops, 'NI', '90000', { note: 'Quoted for a premium cleaned grade at a city market' })).outlier! > 25);
  });
  let liveNo = '';
  await t('daily valuation snapshots every live receipt once, and flags price falls', async () => {
    const r1 = await V.revalueAll();
    ok(r1.valued >= 1, JSON.stringify(r1));
    liveNo = (await db.val<string>(`SELECT r.receipt_no FROM receipts r JOIN receipt_valuations v ON v.receipt_id=r.id WHERE v.kobo_per_kg IS NOT NULL LIMIT 1`))!;
    const again = await V.revalueAll(); eq(again.valued, 0, 'already valued today');
    await rejects(db.run('UPDATE receipt_valuations SET kobo_per_kg=1'));
    for (const n of ['30000', '31000', '32000', '30500']) { const p = await enter(ops, 'NI', n, { note: 'Harvest glut, prices falling fast' }); await V.decideObservation(admin, p.id, true, ''); }
    const r2 = await V.revalueAll(new Date(Date.now() + 86_400_000));
    ok(r2.drops.some((d) => d.receipt_no === liveNo), JSON.stringify(r2));
    const r = (await db.get<any>(`SELECT value_kobo, unit_price_kobo FROM receipts WHERE receipt_no=$1`, liveNo))!;
    ok(Number(r.unit_price_kobo) < 45000);
  });
  await t('lenders may set their own haircut and loan-to-value', async () => {
    const lAdmin = await makeUser(admin, 'finance@accion.test', accionId, 'lender_admin');
    await rejects(V.setPolicy(officer, 'MAZ', '20', '60'));
    await rejects(V.setPolicy(lAdmin, 'MAZ', '95', '60'));
    await V.setPolicy(lAdmin, 'MAZ', '25', '50');
    const r = (await Rc.receiptByNo(admin, liveNo))!;
    const mine = (await V.valuationFor(officer, r))!; eq(mine.policy.own, true); eq(mine.policy.max_ltv_bp, 5000);
    const kit = (await V.valuationFor(admin, r))!; eq(kit.policy.own, false); eq(kit.policy.max_ltv_bp, 7000);
    ok(mine.maxLoan! < kit.maxLoan!);
    eq(await V.valuationFor(gateClerk, r), null, 'warehouse staff do not see values');
  });

  console.log('\nLoans');
  await t('interest: simple, daily, on principal outstanding; payments go to fees, interest, then principal', () => {
    const ln = { interest_bp_month: 300, disbursed_on: '2026-01-01', due_on: '2026-04-01' };
    const e = [{ kind: 'disbursement', amount_kobo: 10_000_000, on_date: '2026-01-01' }, { kind: 'fee', amount_kobo: 100_000, on_date: '2026-01-01' }];
    const p30 = F.position(ln, e, new Date('2026-01-31T12:00:00Z'));
    eq(p30.interest, 300_000); eq(p30.outstanding, 10_400_000);
    const p = F.position(ln, [...e, { kind: 'repayment', amount_kobo: 5_400_000, on_date: '2026-01-31' }], new Date('2026-03-02T12:00:00Z'));
    eq(p.principalOut, 5_000_000); eq(p.interest, 450_000, 'second month on half the principal'); eq(p.outstanding, 5_150_000);
    eq(F.position(ln, e, new Date('2026-04-11T12:00:00Z')).overdueDays, 10);
  });
  const lfin = await makeUser(admin, 'fin2@accion.test', accionId, 'lender_admin');
  const officer2 = await makeUser(admin, 'credit2@accion.test', accionId, 'credit_officer');
  let batchRef = '', loanNo = '';
  await t('lenders define products; Kitovu prepares a batch; amounts capped by the lender’s policy', async () => {
    await rejects(F.createProduct(officer, { name: 'X', interest_pct_month: '2', tenor_days: '90', max_naira: '1000000' }));
    await rejects(F.createProduct(lfin, { name: 'Bad', interest_pct_month: '20', tenor_days: '90', max_naira: '1000000' }));
    await F.createProduct(lfin, { name: 'Harvest 90', interest_pct_month: '3', fee_pct: '1', tenor_days: '90', min_naira: '10000', max_naira: '2000000', commodities: 'MAZ' });
    const prod = (await F.productsOf(accionId))[0];
    await rejects(F.createBatch(officer, prod.id));
    const b = await F.createBatch(ops, prod.id); batchRef = b.ref;
    await rejects(F.addLine(ops, b.id, { farmer: ada, receipts: liveNo, amount: '99999999' }));
    const r = await F.addLine(ops, b.id, { farmer: ada, receipts: liveNo });
    ok(r.amount > 0 && r.amount <= r.max);
    const b2 = await F.createBatch(ops, prod.id);
    await rejects(F.addLine(ops, b2.id, { farmer: ada, receipts: liveNo }));
  });
  await t('the batch reviewer adds checks (and an AI note when switched on); it never decides', async () => {
    const b = (await F.batchView(ops, batchRef))!;
    await F.submitBatch(ops, b.id, (id) => reviewLine(id, null));
    const line = (await F.batchView(officer, batchRef))!.lines[0];
    ok(line.review.checks.some((k: any) => k.code === 'identity' && k.result === 'warn'), 'level 1 < product level 2');
    ok(line.review.checks.some((k: any) => k.code === 'consent' && k.result === 'ok'));
    eq(line.review.note, null);
    let saw = '';
    const r = await reviewLine(line.id, async (_s, content: any) => { saw = content[0].text; return { text: 'Stock and prices look consistent; confirm the account before paying out.', tin: 1, tout: 1 }; });
    ok(saw.includes('identity') && r.note!.startsWith('Stock')); eq(line.status, 'pending');
    eq((await F.batchView(lfin, batchRef))!.status, 'submitted');
  });
  await t('approval pledges the receipts; a receipt can never carry two liens', async () => {
    const line = (await F.batchView(officer, batchRef))!.lines[0];
    await rejects(F.decideLine(ops, line.id, true, {}));
    await rejects(F.decideLine(other, line.id, true, {}));
    await F.decideLine(officer, line.id, true, {});
    loanNo = (await F.batchView(officer, batchRef))!.lines[0].loan_no;
    const r = (await Rc.receiptByNo(admin, liveNo))!;
    eq(r.status, 'pledged');
    await rejects(db.run(`INSERT INTO liens (receipt_id, loan_id, lender_org_id, previous_status) SELECT receipt_id, loan_id, lender_org_id, 'issued' FROM liens WHERE receipt_id=$1`, r.id));
    await rejects(St.orderRelease(ops, liveNo, { reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
    ok((await Rc.listReceipts(officer)).some((x) => x.receipt_no === liveNo));
    eq((await Rc.passport(r.verify_token, undefined, '9.9.9.9'))!.view.label, 'Valid — pledged to a lender');
  });
  await t('disbursement: by a different lender person, only once the farmer is at the product’s identity level', async () => {
    await rejects(F.disburse(officer, loanNo, { reference: 'TRF-001122' }));
    await rejects(F.disburse(officer2, loanNo, { reference: 'TRF-001122' }));
    await K.lenderVerify(officer, ada, 'ACC-CIF-77001');
    await rejects(F.disburse(officer2, loanNo, { reference: '0123456789' }));
    await F.disburse(officer2, loanNo, { reference: 'TRF-001122' });
    eq((await Rc.receiptByNo(admin, liveNo))!.status, 'financed');
    const csv = await F.ncrCsv(lfin);
    ok(csv.includes(loanNo) && csv.includes(liveNo) && csv.includes('ACC-CIF-77001'));
    await rejects(F.ncrCsv(gateClerk));
  });
  await t('due-date reminders go once, a set number of days before and the day after', async () => {
    const ln = await db.get<any>(`SELECT loan_no, to_char(due_on,'YYYY-MM-DD') AS due, farmer_id FROM loans WHERE status='disbursed' ORDER BY disbursed_on, loan_no LIMIT 1`);
    ok(ln, 'a disbursed loan to remind about');
    const due = new Date(ln.due + 'T10:00:00+01:00');
    const before = new Date(due.getTime() - 7 * 86_400_000), after = new Date(due.getTime() + 86_400_000);
    eq((await N.sendReminders(before)).soon, 1);
    eq((await N.sendReminders(before)).soon, 0, 'not twice');
    eq((await N.sendReminders(after)).overdue, 1);
    ok(sentForTests.at(-1)!.text.includes(ln.loan_no) && sentForTests.at(-1)!.text.includes('was due'));
    eq((await N.sendReminders(new Date(due.getTime() - 3 * 86_400_000))).soon, 0);
  });
  await t('control tower: the lender sees its book, the stock behind it, and what to do next', async () => {
    eq(Tw.towerOrg(officer), accionId); eq(Tw.towerOrg(admin), null);
    let refused = false; try { Tw.towerOrg(gateClerk); } catch { refused = true; } ok(refused, 'warehouse clerks have no tower');
    const b = await Tw.book(accionId);
    const l = b.find((x) => x.loan_no === loanNo)!;
    ok(l && l.outstanding > l.principal && l.receipts[0].receipt_no === liveNo);
    ok(l.market! > 0 && l.ltv_bp! > 0 && l.ltv_bp! < 10_000, `ltv ${l.ltv_bp}`);
    const s = Tw.summarise(b);
    eq(s.loans, b.length); eq(s.byCrop[0].share > 0, true);
    ok((await Tw.book(admin.membership!.org_id)).length === 0, 'Kitovu’s own book is separate');
    ok((await Tw.book(null)).some((x) => x.loan_no === loanNo), 'Kitovu sees all lenders');
    const sites = await Tw.collateralSites(b); ok(sites.length >= 1 && sites[0].kg > 0);
    const ck = await Tw.checklist(accionId);
    ok(ck.items.find((i: any) => i.text.includes('disbursement'))?.done, JSON.stringify(ck.items));
    ok(!ck.items.find((i: any) => i.text.toLowerCase().includes('repayment'))?.done);
    const csv = await Tw.loanBookCsv(officer); ok(csv.includes(loanNo) && csv.includes(liveNo));
    await rejects(Tw.loanBookCsv(gateClerk));
  });
  await t('repayment closes the loan and releases the receipts with their history intact', async () => {
    const ln = (await F.loanView(officer, loanNo))!;
    ok(ln.pos!.outstanding > ln.principal, 'fee added');
    await rejects(F.repay(officer, loanNo, { amount: '1000', reference: 'R1', kind: 'waiver' }));
    const part = await F.repay(officer, loanNo, { amount: '1000', reference: 'PAY-1' });
    eq(part.closed, false);
    const owed = (await F.loanView(officer, loanNo))!.pos!.outstanding;
    await rejects(F.repay(officer, loanNo, { amount: String(owed / 100 + 5000), reference: 'PAY-2' }));
    const done = await F.repay(ops.membership!.org_kind === 'kitovu' ? admin : officer, loanNo, { amount: (owed / 100).toFixed(2), reference: 'PAY-2' });
    eq(done.closed, true);
    const r = (await Rc.receiptByNo(admin, liveNo))!;
    eq(r.status, 'issued');
    ok((await Rc.eventsOf(r.id)).map((e) => e.event_type).join(',').endsWith('pledged,financed,lien_released'));
    ok(await Rc.chainOk(r.id));
    await rejects(db.run('UPDATE loan_entries SET amount_kobo=1'));
  });
  await t('Kitovu can lend from its own balance sheet with the same controls', async () => {
    await F.createProduct(admin, { name: 'Kitovu bridge 60', interest_pct_month: '2.5', tenor_days: '60', max_naira: '500000', min_kyc_level: '1' });
    ok((await F.activeProducts()).some((p) => p.lender_code === 'KITOVU'));
  });

  console.log('\nSettlement: sale to farmer paid');
  const kfin = await makeUser(admin, 'finance@kitovu.com.ng', admin.membership!.org_id, 'finance');
  let saleRef = '', saleIdv = '', loan2 = '';
  await t('setup: a fresh loan against the receipt', async () => {
    const prod = (await F.productsOf(accionId)).find((p) => p.name === 'Harvest 90');
    const b = await F.createBatch(ops, prod.id);
    await F.addLine(ops, b.id, { farmer: ada, receipts: liveNo });
    await F.submitBatch(ops, b.id, (id) => reviewLine(id, null));
    const line = (await F.batchView(officer, b.ref))!.lines[0];
    await F.decideLine(officer, line.id, true, {});
    loan2 = (await F.batchView(officer, b.ref))!.lines[0].loan_no;
    await F.disburse(officer2, loan2, { reference: 'TRF-009988' });
    eq((await Rc.receiptByNo(admin, liveNo))!.status, 'financed');
  });
  await t('a sale needs the farmer’s agreement and the lender’s approval before the receipt is committed', async () => {
    await rejects(SL.proposeSale(officer, { buyer: 'Test Mills Ltd', price: '500', receipts: liveNo }));
    const s1 = await SL.proposeSale(ops, { buyer: 'Test Mills Ltd', price: '500', receipts: liveNo }); saleRef = s1.ref; saleIdv = s1.id;
    await rejects(SL.proposeSale(ops, { buyer: 'Other Buyer', price: '510', receipts: liveNo }));
    const sv = (await SL.saleView(admin, saleRef))!;
    const it = sv.items[0];
    await SL.sendAgreementCode(ops, it.id, 'sms');
    ok(sentForTests.at(-1)!.text.includes('Test Mills'));
    await rejects(SL.recordAgreement(ops, it.id, { method: 'code', otp: '000000' }));
    await SL.recordAgreement(ops, it.id, { method: 'code', otp: lastCode() });
    eq((await SL.saleView(admin, saleRef))!.status, 'proposed', 'lender still to approve');
    await rejects(SL.lenderApprove(other, it.id));
    await SL.lenderApprove(officer, it.id);
    eq((await SL.saleView(admin, saleRef))!.status, 'approved');
    const r = (await Rc.receiptByNo(admin, liveNo))!;
    eq(r.status, 'sale_approved'); eq((await Rc.passport(r.verify_token, undefined, '9.9.9.1'))!.view.label, 'Being sold');
    await rejects(St.orderRelease(ops, liveNo, { reason: 'owner_withdrawal', collector_name: 'Ada Okafor' }));
  });
  await t('delivery to the buyer and the buyer’s payment are both required to settle', async () => {
    const refs = await SL.orderDelivery(ops, saleIdv, 'Musa Driver', '08070000000');
    eq(refs.length, 1);
    await rejects(SL.settle(kfin, saleIdv));
    const x = (await St.releaseByRef(gateClerk, refs[0]))!;
    const stack = (await St.stacksOf(x.warehouse_id)).find((st) => st.commodity_code === 'MAZ' && st.kg >= x.ordered);
    await St.confirmLoading(gateClerk, refs[0], { stack: stack.id, kg: String(x.ordered), bags: '2' }, { scale: photo(41).up, slip: photo(42).up });
    eq((await Rc.receiptByNo(admin, liveNo))!.status, 'sale_approved', 'stays being sold until settled');
    const money = await SL.saleMoney(saleIdv);
    await rejects(SL.settle(kfin, saleIdv));
    await rejects(SL.recordCollection(ops, { amount: '1000', reference: 'x', payer: 'y' }));
    const c1 = await SL.recordCollection(kfin, { amount: String(money.gross / 100), reference: `NIP/TEST MILLS/${saleRef}`, payer: 'Test Mills Ltd' });
    eq(c1.matched, true);
  });
  await t('settlement waterfall: Kitovu fees, then the loan, then the farmer; liens released, receipt settled', async () => {
    await rejects(SL.settle(ops, saleIdv));
    const preview = await SL.previewWaterfall(saleIdv);
    const it = preview[0];
    eq(it.lines.reduce((n, l) => n + l.amount, 0), it.gross, 'every kobo accounted for');
    ok(it.toLender > 0 && it.shortfall === 0);
    const totals = await SL.settle(kfin, saleIdv);
    eq(totals.kitovu + totals.lender + totals.farmer, totals.gross);
    eq((await F.loanView(officer, loan2))!.status, 'repaid');
    const r = (await Rc.receiptByNo(admin, liveNo))!;
    eq(r.status, 'settled');
    ok((await Rc.eventsOf(r.id)).map((e) => e.event_type).includes('settled'));
    ok(await Rc.chainOk(r.id));
    eq(await db.val('SELECT count(*)::int FROM liens WHERE receipt_id=$1 AND released_at IS NULL', r.id), 0);
    await rejects(SL.settle(kfin, saleIdv));
  });
  await t('payouts are recorded by someone other than the settler; the farmer statement shows the money', async () => {
    const sv = (await SL.saleView(admin, saleRef))!;
    const farmerLine = sv.settlement.lines.find((l: any) => l.party === 'farmer');
    await rejects(SL.markPaid(kfin, farmerLine.id, 'TRF-PAYOUT-1'));
    await rejects(SL.markPaid(admin, farmerLine.id, '0123456789'));
    await SL.markPaid(admin, farmerLine.id, 'TRF-PAYOUT-1');
    ok(sentForTests.at(-1)!.text.includes('TRF-PAYOUT-1'));
    const f = (await R.farmerByCode(ops, ada))!;
    const st = await SL.farmerStatement(f.id);
    eq(st.paid, farmerLine.amount); ok(st.sales.some((x: any) => x.ref === saleRef));
    const lenderView = (await SL.saleView(officer, saleRef))!;
    ok(lenderView.settlement.lines.every((l: any) => l.org_id === accionId || l.party !== 'lender'));
  });

  console.log('\nFarmer messages and USSD');
  const adaRow = (await db.get<any>('SELECT id, phone_e164 FROM farmers WHERE code=$1', ada))!;
  await t('every farmer text is logged once, from approved wording', async () => {
    const log = await N.messagesOf(adaRow.id);
    for (const ev of ['loan_disbursed', 'loan_repayment', 'loan_closed', 'sale_paid']) ok(log.some((m) => m.event === ev && m.status === 'sent'), `${ev} missing: ${log.map((m) => m.event)}`);
    const again = log.find((m) => m.event === 'loan_disbursed')!;
    eq((await N.notifyFarmer(adaRow.id, 'loan_disbursed', again.ref, { lender: 'x', loan: 'x', amount: 'x', due: 'x' })).status, 'duplicate');
    ok(N.render('Hi {name}, {gone}.', { name: 'Ada' }) === 'Hi Ada, .');
    eq(N.smsParts('a'.repeat(160)), 1); eq(N.smsParts('a'.repeat(161)), 2); eq(N.smsParts('ọ'.repeat(71)), 2);
  });
  await t('translations go live only after a second Kitovu person approves them', async () => {
    await rejects(N.proposeTemplate(officer, 'loan_disbursed', 'pcm', 'StorageX: {lender} don send {amount} for loan {loan}. Pay by {due}.'));
    await rejects(N.proposeTemplate(ops, 'loan_disbursed', 'pcm', 'StorageX: {lender} don send {amount} for loan {loan} to {bvn}.'));
    await rejects(N.proposeTemplate(ops, 'loan_disbursed', 'pcm', 'StorageX: {lender} don send your loan {loan}. Pay by {due}.'));
    await rejects(N.proposeTemplate(ops, 'loan_disbursed', 'pcm', '{lender} don send {amount} for loan {loan}. Pay by {due}.'));
    const id = await N.proposeTemplate(ops, 'loan_disbursed', 'pcm', 'StorageX: {lender} don send {amount} for your loan {loan}. Pay am back by {due}.');
    const f = (await R.farmerByCode(ops, ada))!;
    await N.setFarmerMessaging(ops, f.id, { language: 'pcm', reminders: '0' });
    eq((await N.notifyFarmer(f.id, 'loan_disbursed', 'T-1', { lender: 'Accion', loan: 'L1', amount: 'N5', due: 'today' })).body!.startsWith('StorageX: Accion has sent'), true, 'English until approved');
    await rejects(N.decideTemplate(ops, id, true));
    await N.decideTemplate(admin, id, true);
    ok(sentForTests.length > 0);
    const r = await N.notifyFarmer(f.id, 'loan_disbursed', 'T-2', { lender: 'Accion', loan: 'L1', amount: 'N5', due: 'today' });
    eq(r.body, 'StorageX: Accion don send N5 for your loan L1. Pay am back by today.');
    eq((await N.notifyFarmer(f.id, 'loan_due_soon', 'T-3', { lender: 'Accion', loan: 'L1', due: 'today', owed: 'N5' })).status, 'skipped', 'reminders off for this farmer');
    const table = await N.templateTable();
    ok(table.find((e) => e.event === 'loan_disbursed')!.langs.find((l: any) => l.language === 'pcm')!.live);
    await N.setFarmerMessaging(ops, f.id, { language: 'en', reminders: '1' });
  });
  await t('USSD: the farmer chooses a PIN, then sees produce, loans, sales and prices', async () => {
    const at = (text: string, phone = adaRow.phone_e164) => U.ussd({ sessionId: 'S1', phoneNumber: phone, text });
    { const o = await at('', '+2349011112222'); ok(o.includes('not registered'), o); }
    { const o = await at(''); ok(o.startsWith('CON Welcome to StorageX'), o); }
    { const o = await at('1111'); ok(o.includes('too easy'), o); }
    { const o = await at('5831'); ok(o.startsWith('CON Enter the same PIN'), o); }
    { const o = await at('5831*5830'); ok(o.includes('different'), o); }
    { const o = await at('5831*5831'); ok(o.includes('PIN saved'), o); }
    { const o = await at(''); ok(o.includes('Enter your PIN'), o); }
    eq(await at('5831'), U.MENU);
    const screens = [await at('5831*1'), await at('5831*2'), await at('5831*3'), await at('5831*4')];
    for (const x of screens) ok(x.startsWith('END ') && x.length <= 182, `${x.length}: ${x}`);
    ok(screens[2].includes('SL-') || screens[2].includes('No sales'), screens[2]);
    { const o = await at('5831*5'); ok(o.startsWith('CON Kitovu will call you'), o); }
    { const o = await at('5831*5*2'); ok(o.includes('within 2 working days'), o); }
    ok((await at('5831*5*2')).includes('within 2 working days'), 'asking twice is fine');
    eq((await U.openCallbacks()).filter((x) => x.code === ada).length, 1);
    const logged = await db.all<any>(`SELECT * FROM ussd_log WHERE farmer_id=$1`, adaRow.id);
    ok(logged.length >= 8 && logged.every((r) => !JSON.stringify(r).includes('5831') && !JSON.stringify(r).includes(adaRow.phone_e164.slice(4))), 'no PIN or number in the log');
  });
  await t('USSD: three wrong PINs lock it; Kitovu resets with a reason and the farmer is told', async () => {
    const at = (text: string) => U.ussd({ sessionId: 'S2', phoneNumber: adaRow.phone_e164, text });
    { const o = await at('0000'); ok(o.includes('2 tries left'), o); }
    { const o = await at('0001'); ok(o.includes('1 try left'), o); }
    { const o = await at('0002'); ok(o.includes('locked'), o); }
    ok((await at('5831')).includes('Too many wrong PINs'), 'right PIN refused while locked');
    await rejects(U.resetPin(officer, adaRow.id, 'called back on their number'));
    await rejects(U.resetPin(ops, adaRow.id, 'ok'));
    await U.resetPin(ops, adaRow.id, 'called back on their number');
    ok(sentForTests.at(-1)!.text.includes('PIN was reset'));
    { const o = await at(''); ok(o.startsWith('CON Welcome'), o); }
    const cb = (await U.openCallbacks()).find((x) => x.code === ada)!;
    await rejects(U.handleCallback(ops, cb.id, ''));
    await U.handleCallback(ops, cb.id, 'Called, explained the loan balance');
    eq((await U.openCallbacks()).filter((x) => x.code === ada).length, 0);
  });

  console.log('\nAgents: data steward');
  await t('data steward opens one item per problem, closes it when fixed, and respects a person’s judgement', async () => {
    const madu = await R.createFarmer(ops, { full_name: 'Madu Okafor', phone: '08055550123', state_code: 'NI' });
    await db.run(`UPDATE farmers SET full_name='Madu' WHERE code=$1`, madu);   // as some legacy records are
    const first = await DS.runSteward('test');
    ok(first.opened > 0, JSON.stringify(first));
    eq((await DS.runSteward('test')).opened, 0, 'running again changes nothing');
    const maduId = (await R.farmerByCode(ops, madu))!.id;
    const mine = () => db.all<any>(`SELECT * FROM data_issues WHERE source='steward' AND entity_id=$1 AND resolved_at IS NULL`, maduId);
    ok((await mine()).some((x) => x.code === 'farmer_single_name'));
    ok((await R.farmerByCode(ops, madu))!.needs_review);
    await db.run(`UPDATE farmers SET full_name='Madu Okafor' WHERE id=$1`, maduId);
    const r = await DS.runSteward('test');
    ok(r.closed >= 1); eq((await mine()).length, 0);
    ok(!(await R.farmerByCode(ops, madu))!.needs_review, 'review flag cleared once nothing is left');
    // An agent registering farmers on their own phone.
    const fp = (await db.get<any>(`SELECT id FROM field_partners WHERE status='active' LIMIT 1`))!;
    await db.run(`UPDATE field_partners SET phone_e164='+2348055550123' WHERE id=$1`, fp.id);
    await DS.runSteward('test');
    const shared = (await db.get<any>(`SELECT * FROM data_issues WHERE source='steward' AND entity_id=$1 AND code='field_partner_shares_farmer_phone' AND resolved_at IS NULL`, fp.id))!;
    eq(shared.severity, 'blocker');
    // A person says it is fine; the same finding is not raised again.
    await R.resolveIssue(ops, String(shared.id), 'Agent is the farmer’s son; phone confirmed in person');
    await DS.runSteward('test');
    ok(!(await db.get(`SELECT 1 FROM data_issues WHERE source='steward' AND entity_id=$1 AND code='field_partner_shares_farmer_phone' AND resolved_at IS NULL`, fp.id)), 'not reopened');
    const issues = await R.openIssues(ops, { includeInfo: true });
    ok(issues.some((x: any) => x.source === 'steward'));
    eq((await DS.lastRun())!.started_by, 'test');
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
  await t('partners without an account type are approved for follow-up, with no organisation or invitation', async () => {
    eq(await P.submitApplication({ type: 'logistics', org_name: 'Sahel Haulage Ltd', contact_name: 'Bala Isa', email: 'bala@sahel.test', phone: '08012223333', agree: '1', about: '12 trucks, Kano to Lagos' }, '9.9.9.8'), 'ok');
    const app = (await P.listApplications(admin)).find((x: any) => x.partner_type === 'logistics');
    const r = await P.approveApplication(admin, app.id, {});
    eq(r.link, null);
    eq(await db.val('SELECT org_id FROM partner_applications WHERE id=$1', app.id), null);
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
    eq((await req('GET', '/app')).location, '/tower');
    eq((await req('GET', '/loans/ncr.csv')).status, 200, 'download sends once');
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

  await t('landing page and sample receipt are public; signed-in staff go to their home', async () => {
    const lp = await req('GET', '/'); eq(lp.status, 200); ok(lp.text.includes('Lend against grain you can check') && lp.text.includes('/apply'));
    const sm = await req('GET', '/sample-receipt'); eq(sm.status, 200); ok(sm.text.includes('not a real receipt'));
    await signInAs(ops); eq((await req('GET', '/')).location, '/app'); delete jar.sx_sid;
  });
  await t('USSD gateway posts form fields without a session; farmer messages page is Kitovu-only', async () => {
    const r = await fetch(`${base}/ussd/at`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ sessionId: 'H1', phoneNumber: '+2349011112222', serviceCode: '*347*1#', text: '' }) });
    eq(r.status, 200); ok((await r.text()).startsWith('END This number is not registered'));
    await signInAs(ops); eq((await req('GET', '/admin/messages')).status, 200); delete jar.sx_sid;
    await signInAs(officer); eq((await req('GET', '/admin/messages')).status, 403); delete jar.sx_sid;
  });
  await t('lenders land in their control tower; the loan book downloads', async () => {
    await signInAs(officer);
    eq((await req('GET', '/app')).location, '/tower');
    const pg = await req('GET', '/tower'); eq(pg.status, 200); ok(pg.text.includes('Where the stock is') && pg.text.includes('Loan book'), pg.text.slice(0, 300));
    const dl = await req('GET', '/tower/loan-book.csv'); eq(dl.status, 200); ok(dl.text.split('\n')[0].includes('loan_no'), dl.text.slice(0, 200));
    delete jar.sx_sid;
    await signInAs(gateClerk); eq((await req('GET', '/tower')).status, 403); delete jar.sx_sid;
  });
  await t('Receipt Passport and signing key are public', async () => {
    const r = (await Rc.receiptByNo(admin, rno))!;
    const pg = await req('GET', `/r/${r.verify_token}?s=${r.signature}`); eq(pg.status, 200); ok(pg.text.includes('Closed') && pg.text.includes(rno));
    eq((await req('GET', `/r/${'f'.repeat(32)}`)).status, 404);
    await signInAs(admin);
    eq((await req('POST', '/prices/revalue', {})).status, 303, 'revalue route is not taken for a price id');
    delete jar.sx_sid;
    const k = await req('GET', '/.well-known/storagex-receipt-key.json'); eq(k.status, 200); ok(JSON.parse(k.text).keys[0].crv === 'Ed25519');
  });
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await closePool();
  if (fail) process.exitCode = 1;
}

async function totpNowFor(userId: string) { return totpNow(userId); }

main().catch(async (e) => { console.error(e); await closePool(); process.exitCode = 1; });
