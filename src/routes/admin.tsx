import { get, post } from '../lib/router';
import type { Ctx } from '../lib/http';
import { db } from '../lib/db';
import * as A from '../lib/auth';
import { verifyAuditChain } from '../lib/audit';
import { render } from '../views/layout';
import { HomePage, PeoplePage, OrgsPage, AuditPage, AccountPage } from '../views/admin';
import type { OrgKind } from '../lib/rbac';

import { UserError } from '../lib/errors';
import { can } from '../lib/rbac';

/** Runs an admin action; AuthErrors become a message on the page the person came from. */
export async function act(c: Ctx, fallback: string, fn: () => Promise<string | void>) {
  try {
    const msg = await fn();
    c.back(fallback, ['ok', msg || 'Done.']);
  } catch (e) {
    if (e instanceof UserError) return c.back(fallback, ['error', e.message]);
    throw e;
  }
}

get('/app', 'auth', async (c) => {
  // Lenders start in their control tower.
  if (c.membership?.org_kind === 'lender' && can(c.membership, 'finance.view')) return c.redirect('/tower');
  const counts = await db.get<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM farmers WHERE status='active') AS farmers,
    (SELECT count(*)::int FROM warehouses) AS warehouses,
    (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM organisations) AS orgs`);
  c.html(render(<HomePage c={c} counts={counts ?? {}} />));
});

post('/app/switch-org', 'auth', async (c) => {
  try { await A.switchOrg(c.session!, c.body.org_id); } catch (e) { if (!(e instanceof A.AuthError)) throw e; }
  c.redirect('/app');
});

get('/account', 'auth', (c) => c.html(render(<AccountPage c={c} />)));
post('/account/password', 'auth', (c) => act(c, '/account', async () => { await A.changePassword(c.actor, c.body.current, c.body.next); return 'Password changed.'; }));

// ---------- people ----------
async function invitableOrgs(c: Ctx) {
  const m = c.membership!;
  if (m.org_kind === 'kitovu') return db.all<A.Org>(`SELECT id, code, name, kind::text AS kind, status FROM organisations WHERE status <> 'closed' ORDER BY (kind='kitovu') DESC, name`);
  return db.all<A.Org>('SELECT id, code, name, kind::text AS kind, status FROM organisations WHERE id=$1', m.org_id);
}
async function peoplePage(c: Ctx, link?: string, status = 200) {
  const { members, invites } = await A.listPeople(c.actor);
  c.html(render(<PeoplePage c={c} members={members} invites={invites} orgs={await invitableOrgs(c)} link={link} />), status);
}

get('/admin/people', 'perm:users.manage', (c) => peoplePage(c));

post('/admin/people/invite', 'perm:users.manage', async (c) => {
  try {
    const r = await A.invite(c.actor, { email: c.body.email, fullName: c.body.full_name, orgId: c.body.org_id, role: c.body.role });
    await peoplePage(c, r.link);
  } catch (e) {
    if (!(e instanceof A.AuthError)) throw e;
    c.setFlash('error', e.message);
    c.redirect('/admin/people');
  }
});

post('/admin/people/:id/remove', 'perm:users.manage', (c) => act(c, '/admin/people', async () => { await A.revokeMembership(c.actor, c.params.id); return 'Removed. Their sessions were signed out.'; }));
post('/admin/users/:id/reset-2fa', 'perm:users.manage', (c) => act(c, '/admin/people', async () => { await A.reset2fa(c.actor, c.params.id); return 'Two-step sign-in reset. They will set it up again at their next sign-in.'; }));
post('/admin/users/:id/suspend', 'perm:users.manage', (c) => act(c, '/admin/people', async () => { await A.setUserStatus(c.actor, c.params.id, 'suspended'); return 'Account suspended and signed out everywhere.'; }));
post('/admin/users/:id/reactivate', 'perm:users.manage', (c) => act(c, '/admin/people', async () => { await A.setUserStatus(c.actor, c.params.id, 'active'); return 'Account reactivated.'; }));
post('/admin/users/:id/reset-password', 'perm:users.manage', async (c) => {
  try { await peoplePage(c, (await A.issuePasswordReset(c.actor, c.params.id)).link); }
  catch (e) { if (!(e instanceof A.AuthError)) throw e; c.back('/admin/people', ['error', e.message]); }
});

// ---------- organisations ----------
get('/admin/orgs', 'perm:orgs.manage', async (c) => {
  const orgs = await db.all<A.Org & { members: number }>(`SELECT o.id, o.code, o.name, o.kind::text AS kind, o.status,
    (SELECT count(*)::int FROM memberships m WHERE m.org_id=o.id AND m.status='active') AS members
    FROM organisations o ORDER BY (o.kind='kitovu') DESC, o.name`);
  c.html(render(<OrgsPage c={c} orgs={orgs} />));
});
post('/admin/orgs', 'perm:orgs.manage', (c) => act(c, '/admin/orgs', async () => { await A.createOrg(c.actor, { code: c.body.code, name: c.body.name, kind: c.body.kind as OrgKind }); return 'Organisation added (status: onboarding). Invite its first admin from People.'; }));
post('/admin/orgs/:id/status', 'perm:orgs.manage', (c) => act(c, '/admin/orgs', async () => { await A.setOrgStatus(c.actor, c.params.id, c.body.status as 'active' | 'suspended'); }));

// ---------- audit ----------
get('/admin/audit', 'perm:audit.view', async (c) => {
  const m = c.membership!;
  const scope = m.org_kind === 'kitovu' ? null : m.org_id;
  const q = { action: String(c.query.action || '').trim(), who: String(c.query.who || '').trim() };
  const rows = await db.all(
    `SELECT id, at, actor_label, action, entity, entity_id, ip, data FROM audit_log
     WHERE ($1::uuid IS NULL OR org_id=$1) AND ($2 = '' OR action LIKE $2 || '%') AND ($3 = '' OR actor_label ILIKE '%' || $3 || '%')
     ORDER BY id DESC LIMIT 200`, scope, q.action, q.who);
  const broken = scope ? null : await verifyAuditChain();
  c.html(render(<AuditPage c={c} rows={rows} chainBrokenAt={broken} q={q} />));
});
