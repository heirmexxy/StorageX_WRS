// Value over time. A receipt starts at its value at storage (the price on the day of issue) and is then valued
// every day by the valuation job. Lenders see this for the receipts they can see; Kitovu sees all of it.
// Loans and whole books add up their receipts day by day, carrying each receipt's last known value forward,
// and show what was owed on each of those days beside it.
import { db } from './db';
import { can } from './rbac';
import type { Actor } from './auth';
import { UserError } from './errors';
import { position, entriesOf } from './finance';

const ymd = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
export interface Point { on: string; kobo: number; per_kg: number | null; kg: number }

/** One receipt: value at storage, then each daily valuation that had a price. */
export async function receiptSeries(receiptId: string, days = 365): Promise<Point[]> {
  const r = await db.get<any>(`SELECT issued_at, issue_value_kobo::float AS v, issue_kobo_per_kg::float AS p, net_weight_kg::float AS kg FROM receipts WHERE id=$1`, receiptId);
  if (!r) return [];
  const rows = await db.all<any>(`SELECT valued_on, market_value_kobo::float AS v, kobo_per_kg::float AS p, held_kg::float AS kg FROM receipt_valuations
    WHERE receipt_id=$1 AND kobo_per_kg IS NOT NULL AND valued_on >= current_date - $2::int ORDER BY valued_on`, receiptId, days);
  const out: Point[] = [];
  if (r.v != null && r.issued_at) out.push({ on: ymd(r.issued_at), kobo: r.v, per_kg: r.p, kg: r.kg });
  const issueDay = out[0]?.on;
  for (const x of rows) {
    const on = ymd(x.valued_on);
    if (on === issueDay) continue;   // the issue day keeps the value at storage: it is the lender's baseline
    const i = out.findIndex((p) => p.on === on);
    const pt = { on, kobo: x.v, per_kg: x.p, kg: x.kg };
    if (i >= 0) out[i] = pt; else out.push(pt);
  }
  return out.sort((a, b) => (a.on < b.on ? -1 : 1));
}

/** Several receipts added up per day, each carried forward from its last value until it is valued again. */
export function addUp(seriesList: Point[][]): { on: string; kobo: number }[] {
  const days = [...new Set(seriesList.flat().map((p) => p.on))].sort();
  return days.map((on) => ({
    on,
    kobo: seriesList.reduce((n, s) => { let last: Point | undefined; for (const p of s) { if (p.on <= on) last = p; else break; } return n + (last?.kobo ?? 0); }, 0),
  }));
}

/** A loan: the value of the receipts behind it and what was owed, day by day since it was paid out. */
export async function loanSeries(loanId: string) {
  const ln = await db.get<any>('SELECT * FROM loans WHERE id=$1', loanId);
  if (!ln) return null;
  const rids = (await db.all<{ receipt_id: string }>('SELECT DISTINCT receipt_id FROM liens WHERE loan_id=$1', loanId)).map((r) => r.receipt_id);
  const value = addUp(await Promise.all(rids.map((id) => receiptSeries(id))));
  const entries = await entriesOf(loanId);
  const from = ln.disbursed_on ? ymd(ln.disbursed_on) : null;
  const shown = from ? value.filter((p) => p.on >= from) : value;
  const owed = from ? shown.map((p) => ({ on: p.on, kobo: position(ln, entries, new Date(p.on + 'T23:00:00+01:00')).outstanding })) : [];
  return { value: shown.length ? shown : value, owed, base: value[0] ?? null };
}

/** A lender's book (or every lender's, for Kitovu): stock behind running loans and what is owed, per day. */
export async function bookSeries(orgId: string | null, days = 180) {
  const loans = await db.all<any>(`SELECT id FROM loans WHERE status='disbursed' AND ($1::uuid IS NULL OR lender_org_id=$1)`, orgId);
  const valueParts: { on: string; kobo: number }[][] = [], owedParts: { on: string; kobo: number }[][] = [];
  for (const l of loans) {
    const s = await loanSeries(l.id);
    if (!s) continue;
    valueParts.push(s.value); owedParts.push(s.owed);
  }
  const sum = (parts: { on: string; kobo: number }[][]) => addUp(parts.map((p) => p.map((x) => ({ ...x, per_kg: null, kg: 0 }))));
  const cut = ymd(new Date(Date.now() - days * 86_400_000));
  return { value: sum(valueParts).filter((p) => p.on >= cut), owed: sum(owedParts).filter((p) => p.on >= cut), loans: loans.length };
}

/** Who may see value history: anyone with finance rights who can see the receipt (lenders) or Kitovu. */
export function mayView(a: Actor) {
  if (!can(a.membership, 'finance.view')) throw new UserError('Value history is for lenders and Kitovu.');
}
