// Kitovu's business dashboard: what StorageX earns, how fast the farmer base grows, how much flows through it,
// and the health of every warehouse's WareGuard sensors (blank until Titan is connected). Kitovu only.
import { db } from './db';
import type { Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { LIVE } from './stock';
import { referencePrice } from './valuation';
import { health } from './wareguard';
import { book, summarise } from './tower';
import { csvCell } from './util';

export function mayView(a: Actor) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'reports.view')) throw new UserError('The business dashboard is for Kitovu management.');
}

/** The last n calendar months (Lagos time), oldest first, as YYYY-MM. */
export function months(n = 12, now = new Date()) {
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)); return d.toISOString().slice(0, 7); });
}
export const monthLabel = (ym: string) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
const fee = (label: string) => (label.startsWith('Storage') ? 'Storage' : label.startsWith('Handling') ? 'Handling' : label.startsWith('Sale commission') ? 'Commission' : 'Other');

export async function revenue(n = 12) {
  const ms = months(n);
  const rows = await db.all<{ ym: string; label: string; kobo: number }>(`SELECT to_char(st.settled_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, sl.label, sum(sl.amount_kobo)::float AS kobo
    FROM settlement_lines sl JOIN settlements st ON st.id=sl.settlement_id WHERE sl.party='kitovu' AND st.settled_at >= $1::date GROUP BY 1,2`, ms[0] + '-01');
  // Interest and fees on loans Kitovu made from its own balance sheet.
  const own = await db.all<{ ym: string; kobo: number }>(`SELECT to_char(e.on_date,'YYYY-MM') AS ym, sum(e.amount_kobo)::float AS kobo FROM loan_entries e JOIN loans ln ON ln.id=e.loan_id
    JOIN organisations o ON o.id=ln.lender_org_id WHERE o.kind='kitovu' AND e.kind='fee' AND e.on_date >= $1::date GROUP BY 1`, ms[0] + '-01');
  return ms.map((ym) => {
    const parts: Record<string, number> = { Storage: 0, Handling: 0, Commission: 0, 'Own-book loan fees': 0 };
    for (const r of rows.filter((x) => x.ym === ym)) parts[fee(r.label)] = (parts[fee(r.label)] ?? 0) + r.kobo;
    parts['Own-book loan fees'] += own.find((x) => x.ym === ym)?.kobo ?? 0;
    return { ym, parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
  });
}

export async function farmerGrowth(n = 12) {
  const ms = months(n);
  const before = Number(await db.val(`SELECT count(*) FROM farmers WHERE status <> 'merged' AND created_at < $1::date`, ms[0] + '-01'));
  const rows = await db.all<any>(`SELECT to_char(created_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, count(*)::int AS n, count(*) FILTER (WHERE sex='female')::int AS women
    FROM farmers WHERE status <> 'merged' AND created_at >= $1::date GROUP BY 1`, ms[0] + '-01');
  const active = await db.all<any>(`SELECT to_char(captured_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, count(DISTINCT farmer_id)::int AS n FROM intakes WHERE captured_at >= $1::date GROUP BY 1`, ms[0] + '-01');
  let cum = before;
  return ms.map((ym) => { const r = rows.find((x) => x.ym === ym); cum += r?.n ?? 0; return { ym, added: r?.n ?? 0, women: r?.women ?? 0, total: cum, delivering: active.find((x) => x.ym === ym)?.n ?? 0 }; });
}

export async function flows(n = 12) {
  const ms = months(n), from = ms[0] + '-01';
  const q = (sql: string) => db.all<{ ym: string; v: number }>(sql, from);
  const [kg, rcpt, lent, sold] = await Promise.all([
    q(`SELECT to_char(captured_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, sum(net_kg)::float AS v FROM intakes WHERE status='accepted' AND captured_at >= $1::date GROUP BY 1`),
    q(`SELECT to_char(issued_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, count(*)::float AS v FROM receipts WHERE source='app' AND status <> 'cancelled' AND issued_at >= $1::date GROUP BY 1`),
    q(`SELECT to_char(disbursed_on,'YYYY-MM') AS ym, sum(principal_kobo)::float AS v FROM loans WHERE disbursed_on >= $1::date AND status IN ('disbursed','repaid','written_off') GROUP BY 1`),
    q(`SELECT to_char(st.settled_at AT TIME ZONE 'Africa/Lagos','YYYY-MM') AS ym, sum(x.gross_kobo)::float AS v FROM settlements st JOIN sale_items x ON x.sale_id=st.sale_id WHERE st.settled_at >= $1::date GROUP BY 1`),
  ]);
  const at = (rows: { ym: string; v: number }[], ym: string) => rows.find((r) => r.ym === ym)?.v ?? 0;
  return ms.map((ym) => ({ ym, kg: at(kg, ym), receipts: at(rcpt, ym), lent: at(lent, ym), sold: at(sold, ym) }));
}

export async function snapshot() {
  const f = (await db.get<any>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE kyc_level >= 1)::int AS verified, count(*) FILTER (WHERE sex='female')::int AS women,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id WHERE r.owner_farmer_id=farmers.id AND r.status::text = ANY($1) AND b.remaining_kg > 0))::int AS with_stock
    FROM farmers WHERE status='active'`, LIVE))!;
  const stock = await db.all<any>(`SELECT r.commodity_code, c.name AS crop, w.state_code, sum(b.remaining_kg)::float AS kg FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id JOIN commodities c ON c.code=r.commodity_code
    JOIN warehouses w ON w.id=r.warehouse_id WHERE r.status::text = ANY($1) AND b.remaining_kg > 0 GROUP BY 1,2,3`, LIVE);
  let stockValue = 0, stockKg = 0; const byCrop: Record<string, { kg: number; value: number }> = {};
  for (const s of stock) {
    const p = (await referencePrice(s.commodity_code, s.state_code)).kobo_per_kg ?? 0;
    stockKg += s.kg; stockValue += s.kg * p;
    byCrop[s.crop] = { kg: (byCrop[s.crop]?.kg ?? 0) + s.kg, value: (byCrop[s.crop]?.value ?? 0) + s.kg * p };
  }
  const b = summarise(await book(null));
  const orgs = (await db.get<any>(`SELECT count(*) FILTER (WHERE kind='lender' AND status='active')::int AS lenders, (SELECT count(*)::int FROM warehouses WHERE status IN ('certified','active')) AS warehouses FROM organisations`))!;
  const whs = await db.all<any>(`SELECT w.id, w.code, w.name, s.name AS state FROM warehouses w JOIN states s ON s.code=w.state_code WHERE w.status IN ('certified','active') ORDER BY w.name`);
  const wg = await health(whs.map((w) => w.id), 24);
  return { farmers: f, stockKg, stockValue, byCrop, book: b, orgs, wareguard: whs.map((w) => ({ ...w, h: wg.find((x) => x.warehouse_id === w.id) })) };
}

export async function revenueCsv(a: Actor) {
  mayView(a);
  const r = await revenue(24);
  const head = ['Month', 'Storage (NGN)', 'Handling (NGN)', 'Commission (NGN)', 'Own-book loan fees (NGN)', 'Total (NGN)'];
  return [head, ...r.map((m) => [m.ym, ...['Storage', 'Handling', 'Commission', 'Own-book loan fees'].map((k) => (m.parts[k] / 100).toFixed(2)), (m.total / 100).toFixed(2)])]
    .map((row) => row.map((x) => csvCell(String(x))).join(',')).join('\r\n') + '\r\n';
}
