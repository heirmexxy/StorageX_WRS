// The StorageX partner API (v1). Keys belong to an organisation and act as the person who created them: that
// person's role limits what the key can do, and the key's scopes limit it further. So every rule that holds in
// the web app holds here too: a lender sees only its own requests and loans, and the person who approves a loan
// cannot also record its disbursement (a funding partner uses two keys, made by two people).
//
// Funding partners (fintechs) lend through StorageX as the lender of record. They may split a loan among their
// own users by an opaque user reference; StorageX never receives a user's name, phone, email or account number.
import crypto from 'node:crypto';
import { db } from './db';
import { audit } from './audit';
import { actorOf, rateLimit, type Actor } from './auth';
import { can, type Membership } from './rbac';
import { UserError } from './errors';
import { HttpError, type Ctx } from './http';
import { clean, encrypt, randomToken, safeEqual } from './util';
import { emit } from './webhooks';

export const SCOPES = {
  'receipts:read': 'Read receipts you can see: status, value at storage, value today, issuer, insurance',
  'loans:read': 'Read loan requests, loans, positions, value history and funding allocations',
  'loans:decide': 'Approve or reject loan requests',
  'loans:disburse': 'Record that a loan was paid out',
  'allocations:write': 'Split a loan among your own users by your reference',
  'sales:approve': 'Approve sales of stock pledged to you',
  'alerts:read': 'Read your alerts',
  'issuers:read': 'Read receipt issuers and their scorecards',
  'wareguard:write': 'Send WareGuard devices and readings (Titan only)',
} as const;
export type Scope = keyof typeof SCOPES;
const BY_KIND: Record<string, Scope[]> = {
  lender: ['receipts:read', 'loans:read', 'loans:decide', 'loans:disburse', 'allocations:write', 'sales:approve', 'alerts:read', 'issuers:read'],
  issuer: ['receipts:read', 'alerts:read'],
  kitovu: ['receipts:read', 'wareguard:write', 'issuers:read'],
};
export const scopesFor = (kind: string) => BY_KIND[kind] ?? [];

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- keys ----------
// Administrators manage every key of their organisation; lender staff who approve loans may make keys for
// themselves (so the loan approver and the payout recorder can be two different people, as in the web app).
function keyAdmin(a: Actor) {
  const m = a.membership;
  if (!m || !BY_KIND[m.org_kind] || !(can(m, 'users.manage') || can(m, 'finance.approve'))) throw new UserError('Only administrators, or lender staff who approve loans, manage API keys.');
  return m;
}
const allKeys = (a: Actor) => can(a.membership, 'users.manage');
export async function createKey(a: Actor, i: { name?: string; scopes?: string | string[]; webhook_url?: string }) {
  const m = keyAdmin(a);
  const name = clean(i.name, 80);
  if (name.length < 3) throw new UserError('Name the key after what uses it, e.g. "Loan approvals service".');
  const want = (Array.isArray(i.scopes) ? i.scopes : String(i.scopes ?? '').split(/[,\s]+/)).filter(Boolean) as Scope[];
  const allowed = scopesFor(m.org_kind);
  if (!want.length) throw new UserError('Choose at least one permission for the key.');
  for (const s of want) if (!allowed.includes(s)) throw new UserError(`A ${m.org_kind} key cannot have ${s}.`);
  const url = await checkWebhookUrl(i.webhook_url);
  const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12);
  const secret = crypto.randomBytes(24).toString('hex');
  const key = `sxk_${prefix}_${secret}`;
  const whSecret = url ? `whsec_${crypto.randomBytes(24).toString('hex')}` : null;
  const id = (await db.val<string>(`INSERT INTO api_clients (org_id, user_id, name, key_prefix, key_hash, scopes, webhook_url, webhook_secret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    m.org_id, a.user.id, name, prefix, hash(key), [...new Set(want)], url, whSecret ? encrypt(whSecret) : null))!;
  await audit(actorOf(a), 'api.key_created', { orgId: m.org_id, entity: 'api_client', entityId: id, data: { name, prefix, scopes: want, webhook: !!url } });
  return { id, key, webhook_secret: whSecret };   // shown once; only a hash of the key is kept
}
async function checkWebhookUrl(u?: string) {
  const url = clean(u, 300);
  if (!url) return null;
  let p: URL;
  try { p = new URL(url); } catch { throw new UserError('Webhook address: a full https:// address.'); }
  if (p.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && p.protocol === 'http:')) throw new UserError('Webhook address must start with https://.');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(p.hostname) && process.env.NODE_ENV !== 'test') throw new UserError('Webhook address must be a public address.');
  return url;
}
export async function setWebhook(a: Actor, id: string, url?: string) {
  const m = keyAdmin(a);
  const u = await checkWebhookUrl(url);
  const whSecret = u ? `whsec_${crypto.randomBytes(24).toString('hex')}` : null;
  const n = await db.run(`UPDATE api_clients SET webhook_url=$3, webhook_secret=$4 WHERE id=$1 AND org_id=$2 AND status='active' AND ($5 OR user_id=$6)`, id, m.org_id, u, whSecret ? encrypt(whSecret) : null, allKeys(a), a.user.id);
  if (!n) throw new UserError('Key not found.');
  await audit(actorOf(a), 'api.webhook_set', { orgId: m.org_id, entity: 'api_client', entityId: id, data: { webhook: !!u } });
  return whSecret;
}
export async function revokeKey(a: Actor, id: string) {
  const m = keyAdmin(a);
  const n = await db.run(`UPDATE api_clients SET status='revoked', revoked_at=now(), revoked_by=$3 WHERE id=$1 AND org_id=$2 AND status='active' AND ($4 OR user_id=$3)`, id, m.org_id, a.user.id, allKeys(a));
  if (!n) throw new UserError('Key not found or already revoked.');
  await audit(actorOf(a), 'api.key_revoked', { orgId: m.org_id, entity: 'api_client', entityId: id });
}
export async function keysOf(a: Actor) {
  const m = keyAdmin(a);
  return db.all<any>(`SELECT k.id, k.name, k.key_prefix, k.scopes, k.status, k.webhook_url, k.created_at, k.last_used_at, k.revoked_at, u.full_name AS owner,
      (SELECT count(*)::int FROM webhook_events e WHERE e.client_id=k.id AND e.delivered_at IS NULL AND e.attempts > 0) AS failing
    FROM api_clients k JOIN users u ON u.id=k.user_id WHERE k.org_id=$1 AND ($2 OR k.user_id=$3) ORDER BY k.status, k.created_at DESC`, m.org_id, allKeys(a), a.user.id);
}
export async function testWebhook(a: Actor, id: string) {
  const m = keyAdmin(a);
  const k = await db.get<{ id: string; webhook_url: string | null }>(`SELECT id, webhook_url FROM api_clients WHERE id=$1 AND org_id=$2 AND status='active' AND ($3 OR user_id=$4)`, id, m.org_id, allKeys(a), a.user.id);
  if (!k?.webhook_url) throw new UserError('Set a webhook address on this key first.');
  await emit(m.org_id, 'test.ping', { message: 'Hello from StorageX', key: id }, `ping:${Date.now()}`);
}

// ---------- requests ----------
export interface ApiCtx { actor: Actor; client: { id: string; org_id: string; scopes: string[]; name: string }; }

/** Authenticate a request: Bearer key, active key, its owner still active in the organisation. */
export async function authenticate(c: Ctx): Promise<ApiCtx> {
  const h = String(c.req.headers.authorization ?? '');
  const m = /^Bearer (sxk_([A-Za-z0-9]{12})_[0-9a-f]{48})$/.exec(h);
  if (!m) throw new HttpError(401, 'Send your API key as: Authorization: Bearer sxk_…');
  const k = await db.get<any>(`SELECT k.*, o.kind::text AS org_kind, o.name AS org_name, o.status AS org_status FROM api_clients k JOIN organisations o ON o.id=k.org_id WHERE k.key_prefix=$1`, m[2]);
  if (!k || !safeEqual(hash(m[1]), k.key_hash) || k.status !== 'active') throw new HttpError(401, 'This API key is not valid or has been revoked.');
  if (!['active', 'onboarding'].includes(k.org_status)) throw new HttpError(403, 'Your organisation is not active on StorageX.');
  const mem = await db.get<{ role: string }>(`SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.org_id=$2 AND m.status='active' AND u.status='active'`, k.user_id, k.org_id);
  if (!mem) throw new HttpError(403, 'The person who created this key no longer has access. Create a new key.');
  if (!(await rateLimit(`api:${k.key_prefix}`, 600, 60))) throw new HttpError(429, 'Too many requests: at most 600 a minute per key.');
  const user = (await db.get<any>('SELECT id, email, full_name FROM users WHERE id=$1', k.user_id))!;
  const membership: Membership = { org_id: k.org_id, org_kind: k.org_kind, org_name: k.org_name, role: mem.role };
  await db.run('UPDATE api_clients SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', k.id);
  return { actor: { user, membership, ip: c.ip, via: `api:${k.key_prefix}` } as Actor, client: { id: k.id, org_id: k.org_id, scopes: k.scopes, name: k.name } };
}
export function need(x: ApiCtx, scope: Scope) {
  if (!x.client.scopes.includes(scope)) throw new HttpError(403, `This key does not have the ${scope} permission.`);
}

/** Run a write once per Idempotency-Key: a retry with the same key returns the first answer. */
export async function idempotent(c: Ctx, x: ApiCtx, run: () => Promise<{ status: number; body: unknown }>) {
  const key = String(c.req.headers['idempotency-key'] ?? '').slice(0, 100);
  if (!key) { const r = await run(); return c.json(r.body, r.status); }
  if (!/^[\w.:-]{8,100}$/.test(key)) throw new HttpError(400, 'Idempotency-Key: 8 to 100 letters, digits, dots, dashes, colons or underscores.');
  const reqHash = hash(`${c.method} ${c.path} ${JSON.stringify(c.body)}`);
  const prior = await db.get<any>('SELECT * FROM api_idempotency WHERE client_id=$1 AND key=$2', x.client.id, key);
  if (prior) {
    if (prior.request_hash !== reqHash) throw new HttpError(422, 'This Idempotency-Key was used for a different request.');
    c.res.setHeader('Idempotent-Replayed', 'true');
    return c.json(prior.response, prior.status);
  }
  let r: { status: number; body: unknown };
  try { r = await run(); }
  catch (e: any) {
    if (e instanceof UserError) r = { status: 400, body: { error: e.message } }; else throw e;
  }
  await db.run('INSERT INTO api_idempotency (client_id, key, request_hash, status, response) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', x.client.id, key, reqHash, r.status, JSON.stringify(r.body));
  return c.json(r.body, r.status);
}

// ---------- funding allocations ----------
const REF = /^[A-Za-z0-9_.:-]{3,64}$/;
/** A partner's own reference for its user. Refuse anything that looks like personal data. */
export function checkUserRef(ref: unknown) {
  const s = String(ref ?? '');
  if (!REF.test(s)) throw new UserError('user_ref: 3 to 64 letters, digits, dots, dashes, colons or underscores.');
  if (/^\+?\d{10,15}$/.test(s.replace(/[-.]/g, ''))) throw new UserError('user_ref looks like a phone or account number. Send your own opaque reference for the user instead.');
  return s;
}
export async function setAllocations(x: ApiCtx, loanNo: string, list: unknown) {
  const ln = await db.get<any>('SELECT id, loan_no, lender_org_id, status, principal_kobo::float AS principal FROM loans WHERE loan_no=upper($1)', clean(loanNo, 30));
  if (!ln || ln.lender_org_id !== x.client.org_id) throw new HttpError(404, 'Loan not found.');
  if (!Array.isArray(list) || !list.length || list.length > 5000) throw new UserError('allocations: a list of 1 to 5,000 { user_ref, amount_kobo }.');
  const rows = list.map((r: any) => ({ ref: checkUserRef(r?.user_ref), kobo: Number(r?.amount_kobo) }));
  if (rows.some((r) => !Number.isInteger(r.kobo) || r.kobo <= 0)) throw new UserError('amount_kobo: a whole number of kobo above 0.');
  if (new Set(rows.map((r) => r.ref)).size !== rows.length) throw new UserError('Each user_ref may appear once.');
  const total = rows.reduce((n, r) => n + r.kobo, 0);
  if (total > ln.principal) throw new UserError(`Allocations add up to more than the loan (${ln.principal} kobo).`);
  const existing = Number(await db.val('SELECT count(*) FROM funding_allocations WHERE loan_id=$1', ln.id));
  if (!['approved', 'disbursed'].includes(ln.status)) throw new UserError(`This loan is ${ln.status}.`);
  if (ln.status === 'disbursed' && existing) throw new UserError('Allocations are fixed once a loan is paid out and allocated.');
  await db.run('DELETE FROM funding_allocations WHERE loan_id=$1', ln.id);
  for (const r of rows) await db.run('INSERT INTO funding_allocations (loan_id, user_ref, amount_kobo, created_by) VALUES ($1,$2,$3,$4)', ln.id, r.ref, r.kobo, x.actor.user.id);
  await audit(actorOf(x.actor), 'api.allocations_set', { orgId: ln.lender_org_id, entity: 'loan', entityId: ln.id, data: { loan_no: ln.loan_no, users: rows.length, kobo: total } });
  return { loan_no: ln.loan_no, users: rows.length, allocated_kobo: total, unallocated_kobo: ln.principal - total };
}
/** Each user's share of the loan and of what has been repaid to the lender so far (pro rata to their share). */
export async function allocationsOf(loanId: string, principal: number, repaid: number) {
  const rows = await db.all<{ user_ref: string; amount_kobo: string }>('SELECT user_ref, amount_kobo FROM funding_allocations WHERE loan_id=$1 ORDER BY user_ref', loanId);
  return rows.map((r) => { const amt = Number(r.amount_kobo); const share = principal ? amt / principal : 0; return { user_ref: r.user_ref, amount_kobo: amt, share: Math.round(share * 1e6) / 1e6, repaid_kobo: Math.floor(repaid * share) }; });
}
