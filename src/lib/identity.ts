// Identity lookups through a licensed provider (Dojah). Used two ways:
//   - during the identity review, a NIN is looked up and the names compared (kyc.ts calls lookupNin);
//   - Kitovu compliance can check a farmer's BVN against their name (bvnCheck).
// Only the outcome is kept: match or not, the provider's reference, a keyed hash and the last four digits.
// The number itself and the record the provider returns (names, date of birth, photo) are never stored.
//
// Endpoints follow Dojah's KYC API (GET /api/v1/kyc/nin and /api/v1/kyc/bvn/full with AppId and Authorization
// headers). Confirm them against the contract and sandbox when the account is opened.
import { db } from './db';
import { config } from './config';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { hashIdNumber } from './util';
import { farmerByCode } from './registry';

export type Outcome = 'match' | 'partial' | 'no_match' | 'not_found' | 'error';
export const connected = () => !!(config.dojahAppId && config.dojahSecret);

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1);
/** Compare the farmer's registered name with the names the provider holds. */
export function compareNames(farmerName: string, got: { first?: string; last?: string; middle?: string }): Outcome {
  const mine = new Set(words(farmerName));
  const first = words(got.first ?? ''), last = words(got.last ?? '');
  if (!first.length && !last.length) return 'not_found';
  const f = first.some((w) => mine.has(w)), l = last.some((w) => mine.has(w));
  return f && l ? 'match' : f || l ? 'partial' : 'no_match';
}

type Fetch = (url: string, init: any) => Promise<{ status: number; json(): Promise<any> }>;
async function dojah(path: string, send: Fetch) {
  const r = await send(`${config.dojahBase.replace(/\/$/, '')}${path}`, { headers: { AppId: config.dojahAppId, Authorization: config.dojahSecret, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 404 || r.status === 400) return { status: 'not_found' as const };
  if (r.status !== 200) return { status: 'error' as const, code: r.status };
  const j = await r.json().catch(() => ({}));
  const e = j?.entity ?? {};
  return { status: 'ok' as const, first: e.first_name ?? e.firstname, last: e.last_name ?? e.surname ?? e.lastname, middle: e.middle_name, ref: j?.reference_id ?? j?.reference ?? null };
}

export async function lookupNin(nin: string, farmerName: string, send: Fetch = fetch as any) {
  if (!connected()) return null;
  const r = await dojah(`/api/v1/kyc/nin?nin=${encodeURIComponent(nin)}`, send).catch(() => ({ status: 'error' as const }));
  const outcome: Outcome = r.status === 'ok' ? compareNames(farmerName, r) : r.status;
  return { provider: 'dojah', ref: (r as any).ref ?? '', match: outcome === 'error' ? 'not_found' as const : outcome, detail: { outcome } };
}

/** Kitovu compliance checks a farmer's BVN against their registered name. */
export async function bvnCheck(a: Actor, code: string, bvnRaw: string, send: Fetch = fetch as any) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'kyc.review')) throw new UserError('Only Kitovu compliance checks a BVN.');
  if (!connected()) throw new UserError('The identity provider is not connected yet (see Settings → Connections).');
  const bvn = String(bvnRaw ?? '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(bvn)) throw new UserError('A BVN has 11 digits.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  const recent = Number(await db.val(`SELECT count(*) FROM identity_checks WHERE farmer_id=$1 AND checked_at > now() - interval '1 day'`, f.id));
  if (recent >= 3) throw new UserError('Three checks today already for this farmer. Try again tomorrow, or review by hand.');
  const r = await dojah(`/api/v1/kyc/bvn/full?bvn=${bvn}`, send).catch(() => ({ status: 'error' as const }));
  const outcome: Outcome = r.status === 'ok' ? compareNames(f.full_name, r) : r.status;
  await db.run(`INSERT INTO identity_checks (farmer_id, kind, number_hash, last4, provider, provider_ref, result, detail, checked_by) VALUES ($1,'bvn',$2,$3,'dojah',$4,$5,$6,$7)`,
    f.id, hashIdNumber('bvn', bvn), bvn.slice(-4), (r as any).ref ?? null, outcome, JSON.stringify({ http: (r as any).code ?? null }), a.user.id);
  await audit(actorOf(a), 'kyc.bvn_checked', { entity: 'farmer', entityId: f.id, data: { result: outcome, last4: bvn.slice(-4) } });
  return outcome;
}
export const checksFor = (farmerId: string) => db.all<any>(`SELECT c.kind, c.last4, c.result, c.provider, c.checked_at, u.full_name AS checked_by FROM identity_checks c JOIN users u ON u.id=c.checked_by
  WHERE c.farmer_id=$1 ORDER BY c.checked_at DESC LIMIT 10`, farmerId);
