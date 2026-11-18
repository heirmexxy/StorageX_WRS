// Buyer offer sorter. Buyers do not bid on StorageX: their written offers come in to Kitovu and are entered as
// prices from the "Buyer offer" source, and agreed sales are proposed by Kitovu. For every lot of pledged stock
// (one crop at one warehouse) this lines up the recent offers, best first, and says for each one what it would
// bring, whether it would repay the loans behind the stock, and what to check. Ranking and wording are rules in
// code; it never proposes or accepts a sale. People do that.
import { db } from '../db';
import type { Actor } from '../auth';
import { can } from '../rbac';
import { UserError } from '../errors';
import { getSettings } from '../settings';
import { referencePrice } from '../valuation';
import { position, entriesOf } from '../finance';
import { fmtNGN } from '../money';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
export interface Offer { id: string; source: 'offer' | 'sale'; buyer: string; state: string | null; on: string; per_kg: number; note: string | null; ref?: string;
  gross: number; fees: number; vs_ref_pct: number | null; vs_storage_pct: number | null; covers: number | null; flags: string[]; score: number }

export async function sortOffers(a: Actor, days = 30) {
  const m = a.membership;
  if (!m || !can(m, 'finance.view') || !['kitovu', 'lender'].includes(m.org_kind)) throw new UserError('Buyer offers are for lenders and Kitovu.');
  const lender = m.org_kind === 'lender' ? m.org_id : null;
  const st = await getSettings();
  const lots = await db.all<any>(`SELECT r.warehouse_id, w.name AS wh_name, w.code AS wh_code, w.state_code, s.name AS state, r.commodity_code, c.name AS crop,
      sum(b.remaining_kg)::float AS kg, (sum(r.issue_kobo_per_kg * r.net_weight_kg) FILTER (WHERE r.issue_kobo_per_kg IS NOT NULL) / NULLIF(sum(r.net_weight_kg) FILTER (WHERE r.issue_kobo_per_kg IS NOT NULL), 0))::float AS storage_per_kg_avg, min(r.issued_at) AS first_issued, array_agg(DISTINCT li.loan_id) AS loan_ids, count(*)::int AS receipts
    FROM liens li JOIN receipts r ON r.id=li.receipt_id JOIN receipt_balances b ON b.receipt_id=r.id JOIN warehouses w ON w.id=r.warehouse_id JOIN states s ON s.code=w.state_code
    JOIN commodities c ON c.code=r.commodity_code
    WHERE li.released_at IS NULL AND b.remaining_kg > 0 AND ($1::uuid IS NULL OR li.lender_org_id=$1)
    GROUP BY r.warehouse_id, w.name, w.code, w.state_code, s.name, r.commodity_code, c.name ORDER BY w.name, c.name`, lender);
  const out = [];
  for (const lot of lots) {
    let owed = 0;
    for (const id of lot.loan_ids) { const ln = await db.get<any>('SELECT * FROM loans WHERE id=$1', id); if (ln && ln.status === 'disbursed') owed += position(ln, await entriesOf(id)).outstanding; }
    const ref = await referencePrice(lot.commodity_code, lot.state_code);
    const months = Math.max(1, Math.ceil((Date.now() - new Date(lot.first_issued).getTime()) / (30 * 86_400_000)));
    const feesPerKg = st['fees.handling_kobo_per_kg'] + st['fees.storage_kobo_per_kg_month'] * months;
    const rows = await db.all<any>(`SELECT o.id, o.market AS buyer, o.state_code, st.name AS state, o.observed_on, o.kobo_per_kg::float AS per_kg, o.note FROM price_observations o JOIN price_sources ps ON ps.id=o.source_id
      LEFT JOIN states st ON st.code=o.state_code WHERE ps.kind='buyer_offer' AND o.status='approved' AND o.commodity_code=$1 AND o.observed_on >= current_date - $2::int ORDER BY o.kobo_per_kg DESC`, lot.commodity_code, days);
    const sales = await db.all<any>(`SELECT s.id, s.ref, s.buyer_name, s.created_at, s.kobo_per_kg::float AS per_kg, s.status FROM sales s WHERE s.warehouse_id=$1 AND s.commodity_code=$2 AND s.status IN ('proposed','approved')`, lot.warehouse_id, lot.commodity_code);
    const storagePerKg: number | null = lot.storage_per_kg_avg ?? null;
    const shape = (o: { id: string; source: 'offer' | 'sale'; buyer: string; state_code: string | null; state: string | null; on: string; per_kg: number; note: string | null; ref?: string }): Offer => {
      const gross = Math.round(lot.kg * o.per_kg);
      const fees = Math.round(gross * st['fees.sale_commission_bp'] / 10_000 + lot.kg * feesPerKg);
      const vsRef = ref.kobo_per_kg ? ((o.per_kg - ref.kobo_per_kg) / ref.kobo_per_kg) * 100 : null;
      const vsSto = storagePerKg ? ((o.per_kg - storagePerKg) / storagePerKg) * 100 : null;
      const covers = owed > 0 ? (gross - fees) / owed : null;
      const age = Math.round((Date.now() - new Date(o.on + 'T12:00:00Z').getTime()) / 86_400_000);
      const flags: string[] = [];
      if (o.source === 'sale') flags.push(`Sale ${o.ref} already proposed at this price`);
      if (o.state_code && o.state_code !== lot.state_code) flags.push(`Buyer is in ${o.state ?? 'another state'}: confirm who pays transport`);
      if (age > 14) flags.push(`Offer is ${age} days old: confirm it still stands`);
      if (vsRef !== null && vsRef < -10) flags.push('More than 10% below today’s reference price');
      if (covers !== null && covers < 1) flags.push(`Would repay only ${Math.round(covers * 100)}% of what is owed`);
      // Higher price first; small penalties for stale offers and long hauls, so a fresh local offer wins a near tie.
      const score = o.per_kg * (1 - Math.min(0.1, Math.max(0, age - 7) * 0.005)) * (o.state_code && o.state_code !== lot.state_code ? 0.97 : 1);
      return { id: o.id, source: o.source, buyer: o.buyer, state: o.state, on: o.on, per_kg: o.per_kg, note: o.note, ref: o.ref, gross, fees, vs_ref_pct: vsRef, vs_storage_pct: vsSto, covers, flags, score };
    };
    const offers = [
      ...rows.map((r) => shape({ id: r.id, source: 'offer', buyer: r.buyer, state_code: r.state_code, state: r.state, on: new Date(r.observed_on).toISOString().slice(0, 10), per_kg: r.per_kg, note: r.note })),
      ...sales.map((s) => shape({ id: s.id, source: 'sale', buyer: s.buyer_name, state_code: lot.state_code, state: lot.state, on: new Date(s.created_at).toISOString().slice(0, 10), per_kg: s.per_kg, note: `Sale ${s.status}`, ref: s.ref })),
    ].sort((x, y) => y.score - x.score);
    const best = offers[0];
    const advice = !offers.length ? 'No buyer offers in the last 30 days. Kitovu can ask buyers for this crop and enter their written offers as prices.'
      : `Best: ${best.buyer} at ${fmtNGN(best.per_kg)}/kg${best.vs_ref_pct !== null ? ` (${best.vs_ref_pct >= 0 ? '+' : ''}${best.vs_ref_pct.toFixed(1)}% on today’s reference price)` : ''}. For ${Math.round(lot.kg).toLocaleString('en-NG')} kg it brings ${N(best.gross)}; about ${N(best.fees)} goes to storage, handling and commission first. `
        + (best.covers === null ? '' : best.covers >= 1 ? `That repays what is owed (${N(owed)}) in full and leaves about ${N(best.gross - best.fees - owed)} for the farmers.` : `That would repay about ${Math.round(best.covers * 100)}% of the ${N(owed)} owed; the rest stays a debt of the farmers.`)
        + (best.flags.length ? ` Check first: ${best.flags.join('; ').toLowerCase()}.` : '');
    out.push({ ...lot, owed, ref_per_kg: ref.kobo_per_kg, storage_per_kg: storagePerKg, offers, advice });
  }
  return out;
}
