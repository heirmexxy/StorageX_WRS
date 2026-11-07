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
    ok(!can(l, 'farmers.view'), 'lender has no farmer access in Build 1');
    ok(!canGrant(k, 'kitovu', 'K', 'super_admin'), 'only super admin makes super admin');
    ok(!canGrant(k, 'kitovu', 'K', 'finance'), 'ops cannot grant finance.approve it lacks');
    ok(canGrant(k, 'warehouse_operator', 'W1', 'warehouse_clerk'));
    ok(canGrant(l, 'lender', 'L1', 'credit_officer')); ok(!canGrant(l, 'lender', 'L2', 'credit_officer')); ok(!canGrant(l, 'kitovu', 'K', 'viewer'));
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
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await closePool();
  if (fail) process.exitCode = 1;
}

async function totpNowFor(userId: string) { return totpNow(userId); }

main().catch(async (e) => { console.error(e); await closePool(); process.exitCode = 1; });
