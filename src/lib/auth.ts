// Accounts and access: sign-in with lockout, mandatory two-step codes, sessions, invitations, password resets
// and membership administration. No HTTP here, so every rule is testable directly.
import { db, tx } from './db';
import { config } from './config';
import { audit, type AuditActor } from './audit';
import { randomToken, sha256, hashPassword, verifyPassword, passwordProblem, encrypt, decrypt, minutesFromNow, hoursFromNow } from './util';
import { newTotpSecret, verifyTotp } from './totp';
import { can, canGrant, roleDef, validRole, type Membership, type OrgKind } from './rbac';

export class AuthError extends Error { constructor(public code: string, message: string) { super(message); } }

export interface User { id: string; email: string; full_name: string; status: 'invited' | 'active' | 'suspended'; totp_enabled: boolean; phone_e164: string | null }
export interface Session { id: string; user: User; twofaOk: boolean; memberships: Membership[]; active: Membership | null; expiresAt: Date }
export interface Actor { user: User; membership: Membership | null; ip?: string | null }

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = hashPassword('timing-equaliser-not-a-real-password');
export const actorOf = (a: Actor): AuditActor => ({ userId: a.user.id, label: `user:${a.user.email}`, ip: a.ip });

// ---------- rate limits ----------
/** Counts a hit on `key`; true while the count in the current window is within `max`. */
export async function rateLimit(key: string, max: number, windowSeconds: number) {
  const n = await db.val<number>(
    `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`, key, windowSeconds);
  return (n ?? 0) <= max;
}

// ---------- sign-in ----------
export async function login(emailIn: string, password: string, ip: string): Promise<User> {
  const email = String(emailIn || '').trim().toLowerCase();
  if (!(await rateLimit(`login-ip:${ip}`, 30, 15 * 60))) throw new AuthError('rate', 'Too many attempts from this network. Wait 15 minutes and try again.');
  const u = await db.get<User & { password_hash: string | null; locked_until: Date | null; failed_logins: number }>('SELECT * FROM users WHERE email=$1', email);
  const actor: AuditActor = { userId: u?.id ?? null, label: `user:${email}`, ip };
  if (!u || u.status !== 'active' || !u.password_hash) {
    verifyPassword(password, DUMMY_HASH);
    await audit(actor, 'auth.login.failed', { data: { reason: u ? `status:${u.status}` : 'unknown_email' } });
    throw new AuthError('invalid', 'That email and password do not match.');
  }
  if (u.locked_until && u.locked_until > new Date()) {
    await audit(actor, 'auth.login.blocked', { data: { locked_until: u.locked_until } });
    throw new AuthError('locked', `This account is locked after too many attempts. Try again after ${u.locked_until.toISOString().slice(11, 16)} UTC, or ask an administrator.`);
  }
  if (!verifyPassword(password, u.password_hash)) {
    const fails = u.failed_logins + 1;
    if (fails >= MAX_FAILS) {
      await db.run('UPDATE users SET failed_logins=0, locked_until=$2 WHERE id=$1', u.id, minutesFromNow(LOCK_MINUTES));
      await audit(actor, 'auth.account.locked', { data: { minutes: LOCK_MINUTES } });
    } else await db.run('UPDATE users SET failed_logins=$2 WHERE id=$1', u.id, fails);
    await audit(actor, 'auth.login.failed', { data: { reason: 'password', attempt: fails } });
    throw new AuthError('invalid', 'That email and password do not match.');
  }
  await db.run('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', u.id);
  await audit(actor, 'auth.login.password_ok');
  return publicUser(u);
}

const publicUser = (u: any): User => ({ id: u.id, email: u.email, full_name: u.full_name, status: u.status, totp_enabled: u.totp_enabled, phone_e164: u.phone_e164 });

// ---------- sessions ----------
export async function createSession(userId: string, ip: string, ua: string) {
  const token = randomToken(32);
  const first = (await memberships(userId))[0];
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, active_org_id, twofa_ok, ip, user_agent, expires_at) VALUES ($1,$2,$3,false,$4,$5,$6)`,
    sha256(token), userId, first?.org_id ?? null, ip, ua.slice(0, 300), hoursFromNow(config.sessionMaxHours));
  return token;
}

/** After the second factor: issue a fresh token (blocks session fixation) and mark the session fully signed in. */
export async function completeSecondFactor(oldToken: string, actor: AuditActor) {
  const token = randomToken(32);
  const n = await db.run('UPDATE sessions SET token_hash=$2, twofa_ok=true, last_seen_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', sha256(oldToken), sha256(token));
  if (!n) throw new AuthError('session', 'Your sign-in expired. Start again.');
  await audit(actor, 'auth.login.completed');
  return token;
}

export async function loadSession(token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const s = await db.get<any>(
    `SELECT s.*, u.email, u.full_name, u.status, u.totp_enabled, u.phone_e164 FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL`, sha256(token));
  if (!s) return null;
  const now = Date.now();
  const idleLimit = new Date(s.last_seen_at).getTime() + config.sessionIdleMinutes * 60_000;
  if (s.expires_at.getTime() < now || idleLimit < now || s.status !== 'active') {
    await db.run('UPDATE sessions SET revoked_at=now() WHERE id=$1', s.id);
    return null;
  }
  if (now - new Date(s.last_seen_at).getTime() > 60_000) await db.run('UPDATE sessions SET last_seen_at=now() WHERE id=$1', s.id);
  const ms = await memberships(s.user_id);
  const active = ms.find((m) => m.org_id === s.active_org_id) || ms[0] || null;
  return { id: s.id, twofaOk: s.twofa_ok, memberships: ms, active, expiresAt: s.expires_at, user: publicUser({ ...s, id: s.user_id }) };
}

export async function revokeSession(sessionId: string) { await db.run('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', sessionId); }
export async function revokeAllSessions(userId: string) { await db.run('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', userId); }

export async function memberships(userId: string): Promise<Membership[]> {
  return db.all<Membership>(
    `SELECT m.org_id, o.kind::text AS org_kind, o.name AS org_name, m.role FROM memberships m JOIN organisations o ON o.id=m.org_id
     WHERE m.user_id=$1 AND m.status='active' AND o.status IN ('active','onboarding')
     ORDER BY (o.kind='kitovu') DESC, o.name`, userId);
}

export async function switchOrg(session: Session, orgId: string) {
  if (!session.memberships.some((m) => m.org_id === orgId)) throw new AuthError('forbidden', 'You are not a member of that organisation.');
  await db.run('UPDATE sessions SET active_org_id=$2 WHERE id=$1', session.id, orgId);
}

// ---------- two-step codes ----------
export async function beginTotpSetup(userId: string) {
  const u = await db.get<{ totp_enabled: boolean }>('SELECT totp_enabled FROM users WHERE id=$1', userId);
  if (u?.totp_enabled) throw new AuthError('exists', 'Two-step sign-in is already on.');
  const secret = newTotpSecret();
  await db.run('UPDATE users SET totp_secret_enc=$2, updated_at=now() WHERE id=$1', userId, encrypt(secret));
  return secret;
}

export async function pendingTotpSecret(userId: string) {
  const enc = await db.val<string | null>('SELECT totp_secret_enc FROM users WHERE id=$1 AND NOT totp_enabled', userId);
  return enc ? decrypt(enc) : null;
}

/** Confirms the authenticator, turns two-step sign-in on and returns 10 one-time recovery codes (shown once). */
export async function confirmTotp(userId: string, code: string, actor: AuditActor) {
  const secret = await pendingTotpSecret(userId);
  if (!secret || !verifyTotp(secret, code)) throw new AuthError('code', 'That code did not match. Check the time on your phone and try the newest code.');
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toLowerCase());
  await tx(async () => {
    await db.run('UPDATE users SET totp_enabled=true, updated_at=now() WHERE id=$1', userId);
    await db.run('DELETE FROM recovery_codes WHERE user_id=$1', userId);
    for (const c of codes) await db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)', userId, sha256(c));
    await audit(actor, 'auth.2fa.enabled', { entity: 'user', entityId: userId });
  });
  return codes;
}

export async function verifySecondFactor(userId: string, codeIn: string, actor: AuditActor) {
  if (!(await rateLimit(`2fa:${userId}`, 10, 15 * 60))) throw new AuthError('rate', 'Too many codes tried. Wait 15 minutes.');
  const code = String(codeIn || '').trim().toLowerCase().replace(/\s/g, '');
  const enc = await db.val<string | null>('SELECT totp_secret_enc FROM users WHERE id=$1 AND totp_enabled', userId);
  if (enc && /^\d{6}$/.test(code) && verifyTotp(decrypt(enc), code)) return true;
  if (/^[a-z0-9]{8}$/.test(code)) {
    const n = await db.run('UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL', userId, sha256(code));
    if (n) { await audit(actor, 'auth.2fa.recovery_code_used', { entity: 'user', entityId: userId }); return true; }
  }
  await audit(actor, 'auth.2fa.failed', { entity: 'user', entityId: userId });
  return false;
}

// ---------- organisations ----------
export interface Org { id: string; code: string; name: string; kind: OrgKind; status: string }
export const orgById = (id: string) => db.get<Org>('SELECT id, code, name, kind::text AS kind, status FROM organisations WHERE id=$1', id);

export async function createOrg(a: Actor, o: { code: string; name: string; kind: OrgKind }) {
  if (!can(a.membership, 'orgs.manage')) throw new AuthError('forbidden', 'You cannot add organisations.');
  const code = o.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new AuthError('input', 'Code: 2–20 letters, digits, - or _.');
  if (o.kind === 'kitovu') throw new AuthError('input', 'There is only one Kitovu organisation.');
  if (!o.name.trim()) throw new AuthError('input', 'Name is required.');
  if (await db.val('SELECT 1 FROM organisations WHERE code=$1', code)) throw new AuthError('exists', 'That code is already used.');
  const id = await db.val<string>(`INSERT INTO organisations (code, name, kind, status) VALUES ($1,$2,$3,'onboarding') RETURNING id`, code, o.name.trim(), o.kind);
  await audit(actorOf(a), 'org.created', { orgId: id, entity: 'organisation', entityId: id!, data: { code, kind: o.kind } });
  return id!;
}

export async function setOrgStatus(a: Actor, orgId: string, status: 'onboarding' | 'active' | 'suspended' | 'closed') {
  if (!can(a.membership, 'orgs.manage')) throw new AuthError('forbidden', 'You cannot change organisations.');
  const org = await orgById(orgId);
  if (!org || org.kind === 'kitovu') throw new AuthError('input', 'That organisation cannot be changed here.');
  await db.run('UPDATE organisations SET status=$2 WHERE id=$1', orgId, status);
  await audit(actorOf(a), 'org.status_changed', { orgId, entity: 'organisation', entityId: orgId, data: { from: org.status, to: status } });
}

// ---------- invitations ----------
export async function invite(a: Actor, i: { email: string; fullName: string; orgId: string; role: string }) {
  const email = i.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new AuthError('input', 'Enter a valid email address.');
  if (!i.fullName.trim()) throw new AuthError('input', 'Enter the person’s name.');
  const org = await orgById(i.orgId);
  if (!org) throw new AuthError('input', 'Unknown organisation.');
  if (!validRole(org.kind, i.role)) throw new AuthError('input', `“${i.role}” is not a role for a ${org.kind.replace(/_/g, ' ')}.`);
  if (!canGrant(a.membership, org.kind, org.id, i.role)) throw new AuthError('forbidden', 'You cannot give that role in that organisation.');
  const existing = await db.val('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.org_id=$2 AND m.status=$3', email, org.id, 'active');
  if (existing) throw new AuthError('exists', 'That person is already a member of this organisation.');
  const token = randomToken(32);
  await tx(async () => {
    await db.run('UPDATE invitations SET revoked_at=now() WHERE email=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL', email, org.id);
    const id = await db.val<string>(
      'INSERT INTO invitations (token_hash, email, full_name, org_id, role, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      sha256(token), email, i.fullName.trim(), org.id, i.role, a.user.id, hoursFromNow(72));
    await audit(actorOf(a), 'user.invited', { orgId: org.id, entity: 'invitation', entityId: id!, data: { email, role: i.role } });
  });
  return { link: `${config.baseUrl}/invite/${token}`, expiresInHours: 72 };
}

export async function findInvite(token: string) {
  return db.get<{ id: string; email: string; full_name: string; org_id: string; role: string; org_name: string; user_exists: boolean }>(
    `SELECT i.id, i.email, i.full_name, i.org_id, i.role, o.name AS org_name,
            EXISTS (SELECT 1 FROM users u WHERE u.email=i.email AND u.status='active') AS user_exists
     FROM invitations i JOIN organisations o ON o.id=i.org_id
     WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, sha256(token));
}

/** New people set a password; people who already have an account just gain the membership. */
export async function acceptInvite(token: string, password: string | null, ip: string) {
  const inv = await findInvite(token);
  if (!inv) throw new AuthError('invalid', 'This invitation link is not valid any more. Ask for a new one.');
  return tx(async () => {
    let user = await db.get<{ id: string; status: string }>('SELECT id, status FROM users WHERE email=$1', inv.email);
    if (user?.status === 'suspended') throw new AuthError('suspended', 'This account is suspended. Ask a Kitovu administrator.');
    if (!user || user.status !== 'active') {
      const problem = passwordProblem(password || '', inv.email);
      if (problem) throw new AuthError('password', problem);
      if (user) await db.run(`UPDATE users SET password_hash=$2, status='active', updated_at=now() WHERE id=$1`, user.id, hashPassword(password!));
      else user = { id: (await db.val<string>(`INSERT INTO users (email, full_name, password_hash, status) VALUES ($1,$2,$3,'active') RETURNING id`, inv.email, inv.full_name, hashPassword(password!)))!, status: 'active' };
    }
    await db.run(
      `INSERT INTO memberships (user_id, org_id, role, created_by) SELECT $1, $2, $3, invited_by FROM invitations WHERE id=$4
       ON CONFLICT (user_id, org_id) DO UPDATE SET role=EXCLUDED.role, status='active', revoked_at=NULL, created_by=EXCLUDED.created_by`,
      user.id, inv.org_id, inv.role, inv.id);
    await db.run('UPDATE invitations SET accepted_at=now() WHERE id=$1', inv.id);
    await audit({ userId: user.id, label: `user:${inv.email}`, ip }, 'invite.accepted', { orgId: inv.org_id, entity: 'invitation', entityId: inv.id, data: { role: inv.role } });
    return user.id;
  });
}

// ---------- people administration ----------
/** Does the actor have authority over every active membership the target holds? (Needed to act on the whole account.) */
async function authorityOver(a: Actor, userId: string) {
  const ms = await memberships(userId);
  if (!ms.length) return can(a.membership, 'users.manage') && a.membership?.org_kind === 'kitovu';
  return ms.every((m) => canGrant(a.membership, m.org_kind, m.org_id, m.role));
}

export async function listPeople(a: Actor) {
  if (!a.membership || !can(a.membership, 'users.manage')) throw new AuthError('forbidden', 'You cannot manage people.');
  const scope = a.membership.org_kind === 'kitovu' ? null : a.membership.org_id;
  const members = await db.all<any>(
    `SELECT m.id AS membership_id, m.role, m.created_at, u.id AS user_id, u.email, u.full_name, u.status, u.totp_enabled, u.last_login_at,
            o.id AS org_id, o.name AS org_name, o.kind::text AS org_kind
     FROM memberships m JOIN users u ON u.id=m.user_id JOIN organisations o ON o.id=m.org_id
     WHERE m.status='active' AND ($1::uuid IS NULL OR m.org_id=$1) ORDER BY o.name, u.full_name`, scope);
  const invites = await db.all<any>(
    `SELECT i.id, i.email, i.full_name, i.role, i.expires_at, o.name AS org_name FROM invitations i JOIN organisations o ON o.id=i.org_id
     WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND ($1::uuid IS NULL OR i.org_id=$1) ORDER BY i.created_at DESC`, scope);
  return { members, invites };
}

export async function revokeMembership(a: Actor, membershipId: string) {
  const m = await db.get<any>(`SELECT m.*, o.kind::text AS org_kind FROM memberships m JOIN organisations o ON o.id=m.org_id WHERE m.id=$1 AND m.status='active'`, membershipId);
  if (!m) throw new AuthError('input', 'That membership does not exist.');
  if (m.user_id === a.user.id) throw new AuthError('input', 'You cannot remove yourself.');
  if (!canGrant(a.membership, m.org_kind, m.org_id, m.role)) throw new AuthError('forbidden', 'You cannot remove that person.');
  await tx(async () => {
    await db.run(`UPDATE memberships SET status='revoked', revoked_at=now() WHERE id=$1`, membershipId);
    await audit(actorOf(a), 'membership.revoked', { orgId: m.org_id, entity: 'user', entityId: m.user_id, data: { role: m.role } });
  });
  await revokeAllSessions(m.user_id);
}

export async function setUserStatus(a: Actor, userId: string, status: 'active' | 'suspended') {
  if (userId === a.user.id) throw new AuthError('input', 'You cannot change your own status.');
  if (a.membership?.org_kind !== 'kitovu' || !(await authorityOver(a, userId))) throw new AuthError('forbidden', 'Only Kitovu administrators can suspend accounts.');
  await db.run('UPDATE users SET status=$2, updated_at=now() WHERE id=$1 AND status<>\'invited\'', userId, status);
  if (status === 'suspended') await revokeAllSessions(userId);
  await audit(actorOf(a), `user.${status === 'suspended' ? 'suspended' : 'reactivated'}`, { entity: 'user', entityId: userId });
}

export async function reset2fa(a: Actor, userId: string) {
  if (userId === a.user.id || !(await authorityOver(a, userId))) throw new AuthError('forbidden', 'You cannot reset that person’s two-step sign-in.');
  await tx(async () => {
    await db.run('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL, updated_at=now() WHERE id=$1', userId);
    await db.run('DELETE FROM recovery_codes WHERE user_id=$1', userId);
    await audit(actorOf(a), 'auth.2fa.reset', { entity: 'user', entityId: userId });
  });
  await revokeAllSessions(userId);
}

export async function issuePasswordReset(a: Actor | null, userId: string, auditActor?: AuditActor) {
  if (a && (userId === a.user.id || !(await authorityOver(a, userId)))) throw new AuthError('forbidden', 'You cannot reset that person’s password.');
  const token = randomToken(32);
  await db.run('INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES ($1,$2,$3,$4)', sha256(token), userId, a?.user.id ?? null, hoursFromNow(2));
  await audit(a ? actorOf(a) : auditActor!, 'auth.password.reset_issued', { entity: 'user', entityId: userId });
  return { link: `${config.baseUrl}/reset/${token}`, expiresInHours: 2 };
}

export async function resetPassword(token: string, password: string, ip: string) {
  const r = await db.get<{ id: string; user_id: string; email: string }>(
    `SELECT pr.id, pr.user_id, u.email FROM password_resets pr JOIN users u ON u.id=pr.user_id
     WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > now()`, sha256(token));
  if (!r) throw new AuthError('invalid', 'This reset link is not valid any more. Ask an administrator for a new one.');
  const problem = passwordProblem(password, r.email);
  if (problem) throw new AuthError('password', problem);
  await tx(async () => {
    await db.run(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, status=CASE WHEN status='invited' THEN 'active'::user_status ELSE status END, updated_at=now() WHERE id=$1`, r.user_id, hashPassword(password));
    await db.run('UPDATE password_resets SET used_at=now() WHERE id=$1', r.id);
    await audit({ userId: r.user_id, label: `user:${r.email}`, ip }, 'auth.password.reset');
  });
  await revokeAllSessions(r.user_id);
}

export async function changePassword(a: Actor, current: string, next: string) {
  const hash = await db.val<string>('SELECT password_hash FROM users WHERE id=$1', a.user.id);
  if (!verifyPassword(current, hash)) throw new AuthError('invalid', 'Your current password is not right.');
  const problem = passwordProblem(next, a.user.email);
  if (problem) throw new AuthError('password', problem);
  await db.run('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', a.user.id, hashPassword(next));
  await audit(actorOf(a), 'auth.password.changed');
}

/** First Kitovu super admin, from the command line (no one exists yet to send the invitation). */
export async function bootstrapSuperAdmin(email: string, fullName: string) {
  const kitovu = await db.val<string>(`SELECT id FROM organisations WHERE code='KITOVU'`);
  if (!kitovu) throw new Error('Run "npm run seed" first: the Kitovu organisation is missing.');
  const token = randomToken(32);
  await db.run('INSERT INTO invitations (token_hash, email, full_name, org_id, role, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    sha256(token), email.trim().toLowerCase(), fullName.trim(), kitovu, 'super_admin', hoursFromNow(72));
  await audit({ label: 'cli' }, 'user.invited', { orgId: kitovu, data: { email: email.trim().toLowerCase(), role: 'super_admin', via: 'cli' } });
  return `${config.baseUrl}/invite/${token}`;
}

export const roleLabel = (kind: OrgKind, role: string) => roleDef(kind, role)?.label ?? role;
