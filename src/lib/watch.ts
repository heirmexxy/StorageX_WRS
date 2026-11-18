// Stock watch: the live view of the stock behind a lender's loans, warehouse by warehouse. Conditions from
// WareGuard (once Titan is connected), the receipts there with their value at storage and today, the insurance,
// and the last count. Lenders see the warehouses holding their pledged stock; warehouse operators their own
// warehouses; Kitovu every warehouse holding stock.
import { db } from './db';
import type { Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { LIVE, reconcile } from './stock';
import { referencePrice } from './valuation';
import { health } from './wareguard';

function who(a: Actor) {
  const m = a.membership;
  if (!m || !can(m, 'warehouses.view') || !['kitovu', 'lender', 'warehouse_operator'].includes(m.org_kind)) throw new UserError('Stock watch is for lenders, warehouse operators and Kitovu.');
  return m;
}

export async function sites(a: Actor) {
  const m = who(a);
  const where = m.org_kind === 'kitovu' ? `EXISTS (SELECT 1 FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id WHERE r.warehouse_id=w.id AND r.status::text = ANY($2) AND b.remaining_kg > 0) AND $1::uuid IS NULL`
    : m.org_kind === 'lender' ? `EXISTS (SELECT 1 FROM liens li JOIN receipts r ON r.id=li.receipt_id WHERE r.warehouse_id=w.id AND li.lender_org_id=$1 AND li.released_at IS NULL) AND $2::text[] IS NOT NULL`
    : `w.operator_org_id=$1 AND $2::text[] IS NOT NULL`;
  const ws = await db.all<any>(`SELECT w.id, w.code, w.name, w.tier, w.status, s.name AS state FROM warehouses w JOIN states s ON s.code=w.state_code WHERE ${where} ORDER BY w.name`,
    m.org_kind === 'kitovu' ? null : m.org_id, LIVE);
  const h = await health(ws.map((w) => w.id), 24);
  const out = [];
  for (const w of ws) {
    const mine = await stockAt(a, w.id);
    out.push({ ...w, wg: h.find((x) => x.warehouse_id === w.id), kg: mine.reduce((n, r) => n + r.kg, 0), value_now: mine.reduce((n, r) => n + (r.value_now ?? 0), 0),
      value_storage: mine.reduce((n, r) => n + (r.value_storage ?? 0), 0), receipts: mine.length });
  }
  return out;
}

/** The receipts at a warehouse that this viewer may watch (lenders: those pledged to them). */
export async function stockAt(a: Actor, whId: string) {
  const m = who(a);
  const lender = m.org_kind === 'lender';
  const rs = await db.all<any>(`SELECT r.id, r.receipt_no, r.status::text AS status, r.commodity_code, c.name AS crop, r.grade, b.remaining_kg::float AS kg, r.issue_value_kobo::float AS value_storage,
      r.issue_kobo_per_kg::float AS per_kg_storage, r.issued_at, w.state_code, ln.loan_no, ip.insurer_name, ip.policy_number, ip.cover_to, f.full_name AS farmer_name
    FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id JOIN farmers f ON f.id=r.owner_farmer_id
    LEFT JOIN liens li ON li.receipt_id=r.id AND li.released_at IS NULL LEFT JOIN loans ln ON ln.id=li.loan_id LEFT JOIN insurance_policies ip ON ip.id=r.insurance_policy_id
    WHERE r.warehouse_id=$1 AND r.status::text = ANY($2) AND b.remaining_kg > 0 AND ($3::uuid IS NULL OR li.lender_org_id=$3) ORDER BY r.issued_at`, whId, LIVE, lender ? m.org_id : null);
  const prices = new Map<string, number | null>();
  for (const r of rs) {
    const k = `${r.commodity_code}:${r.state_code}`;
    if (!prices.has(k)) prices.set(k, (await referencePrice(r.commodity_code, r.state_code)).kobo_per_kg);
    const p = prices.get(k);
    r.per_kg_now = p; r.value_now = p == null ? null : Math.round(r.kg * p);
  }
  return rs;
}

export async function site(a: Actor, code: string) {
  const m = who(a);
  const w = await db.get<any>(`SELECT w.*, s.name AS state, o.name AS operator,
      (SELECT max(counted_at) FROM stock_counts k WHERE k.warehouse_id=w.id) AS last_count,
      (SELECT row_to_json(p) FROM (SELECT insurer_name, policy_number, cover_to, sum_insured_kobo::float AS sum_insured FROM insurance_policies ip WHERE ip.warehouse_id=w.id AND ip.status='active' AND ip.cover_to >= current_date ORDER BY cover_to DESC LIMIT 1) p) AS policy
    FROM warehouses w JOIN states s ON s.code=w.state_code JOIN organisations o ON o.id=w.operator_org_id WHERE w.code=upper($1)`, String(code).slice(0, 30));
  if (!w) return null;
  if (m.org_kind === 'warehouse_operator' && w.operator_org_id !== m.org_id) return null;
  const stock = await stockAt(a, w.id);
  if (m.org_kind === 'lender' && !stock.length) return null;
  const [wg] = await health([w.id], 48);
  const rec = await reconcile(w.id);
  return { w, stock, wg, flags: rec.flatMap((r: any) => r.flags.map((f: any) => ({ ...f, commodity: r.commodity }))) };
}
