// Lender control tower (Build 9): everything a lender needs to run its StorageX book without calling Kitovu.
// The same views serve Kitovu across all lenders (orgId = null).
import { db } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { position, entriesOf } from './finance';
import { reconcile } from './stock';
import { referencePrice } from './valuation';

const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
export function towerOrg(a: Actor) {
  if (!can(a.membership, 'finance.view') || !['lender', 'kitovu'].includes(a.membership!.org_kind)) throw new UserError('The control tower is for lenders and Kitovu.');
  return a.membership!.org_kind === 'kitovu' ? null : a.membership!.org_id;
}

interface BookLoan { id: string; loan_no: string; lender: string; farmer_name: string; farmer_code: string; state: string | null; principal: number; outstanding: number; interestOut: number;
  market: number | null; ltv_bp: number | null; margin_call_ltv_bp: number; liquidation_ltv_bp: number; due_on: string; days_to_due: number; overdue_days: number; receipts: { receipt_no: string; kg: number; commodity: string; warehouse: string; wh_id: string; commodity_code: string }[] }

/** Every disbursed loan with what is owed today and what the stock behind it is worth. */
export async function book(orgId: string | null): Promise<BookLoan[]> {
  const ls = await db.all<any>(`SELECT ln.*, o.name AS lender, f.full_name AS farmer_name, f.code AS farmer_code, s.name AS state, p.margin_call_ltv_bp, p.liquidation_ltv_bp
    FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id JOIN farmers f ON f.id=ln.farmer_id LEFT JOIN states s ON s.code=f.state_code JOIN loan_products p ON p.id=ln.product_id
    WHERE ln.status='disbursed' AND ($1::uuid IS NULL OR ln.lender_org_id=$1) ORDER BY ln.due_on`, orgId);
  const prices = new Map<string, number | null>();
  const out: BookLoan[] = [];
  for (const ln of ls) {
    const pos = position(ln, await entriesOf(ln.id));
    const rs = await db.all<any>(`SELECT r.receipt_no, b.remaining_kg::float AS kg, c.name AS commodity, r.commodity_code, w.name AS warehouse, w.id AS wh_id, w.state_code
      FROM liens li JOIN receipts r ON r.id=li.receipt_id JOIN receipt_balances b ON b.receipt_id=r.id JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id
      WHERE li.loan_id=$1 AND li.released_at IS NULL`, ln.id);
    let market: number | null = 0;
    for (const r of rs) {
      const key = `${r.commodity_code}:${r.state_code}`;
      if (!prices.has(key)) prices.set(key, (await referencePrice(r.commodity_code, r.state_code)).kobo_per_kg);
      const p = prices.get(key);
      if (p == null) { market = null; break; }
      market += Math.round(r.kg * p);
    }
    const due = ymd(new Date(ln.due_on));
    out.push({ id: ln.id, loan_no: ln.loan_no, lender: ln.lender, farmer_name: ln.farmer_name, farmer_code: ln.farmer_code, state: ln.state, principal: Number(ln.principal_kobo),
      outstanding: pos.outstanding, interestOut: pos.interestOut, market, ltv_bp: market ? Math.round((pos.outstanding / market) * 10_000) : null,
      margin_call_ltv_bp: ln.margin_call_ltv_bp, liquidation_ltv_bp: ln.liquidation_ltv_bp, due_on: due,
      days_to_due: Math.round((new Date(due + 'T00:00:00Z').getTime() - new Date(ymd(new Date()) + 'T00:00:00Z').getTime()) / 86_400_000), overdue_days: pos.overdueDays, receipts: rs });
  }
  return out;
}

export function summarise(b: BookLoan[]) {
  const sum = (f: (l: BookLoan) => number) => b.reduce((n, l) => n + f(l), 0);
  const outstanding = sum((l) => l.outstanding), market = sum((l) => l.market ?? 0);
  const group = (key: (l: BookLoan) => string[]) => {
    const m = new Map<string, number>();
    for (const l of b) { const ks = key(l); for (const k of ks) m.set(k, (m.get(k) ?? 0) + l.outstanding / ks.length); }
    return [...m.entries()].map(([k, v]) => ({ k, kobo: Math.round(v), share: outstanding ? v / outstanding : 0 })).sort((x, y) => y.kobo - x.kobo);
  };
  return {
    loans: b.length, principal: sum((l) => l.principal), outstanding, interest: sum((l) => l.interestOut), market,
    ltv_bp: market ? Math.round((outstanding / market) * 10_000) : null,
    margin: b.filter((l) => l.ltv_bp !== null && l.ltv_bp >= l.margin_call_ltv_bp && l.ltv_bp < l.liquidation_ltv_bp),
    liquidation: b.filter((l) => l.ltv_bp !== null && l.ltv_bp >= l.liquidation_ltv_bp),
    unpriced: b.filter((l) => l.market === null),
    overdue: b.filter((l) => l.overdue_days > 0),
    due14: b.filter((l) => l.overdue_days === 0 && l.days_to_due <= 14),
    byWarehouse: group((l) => [...new Set(l.receipts.map((r) => r.warehouse))]),
    byCrop: group((l) => [...new Set(l.receipts.map((r) => r.commodity))]),
    byState: group((l) => [l.state ?? 'Unknown']),
  };
}

/** The warehouses holding a lender's collateral, with how sure we are the stock is there. */
export async function collateralSites(b: BookLoan[]) {
  const ids = [...new Set(b.flatMap((l) => l.receipts.map((r) => r.wh_id)))];
  const out = [];
  for (const id of ids) {
    const w = (await db.get<any>(`SELECT w.id, w.name, w.code, w.status, w.tier, s.name AS state,
        EXISTS (SELECT 1 FROM insurance_policies ip WHERE ip.warehouse_id=w.id AND ip.status='active' AND current_date BETWEEN ip.cover_from AND ip.cover_to) AS insured,
        (SELECT max(counted_at) FROM stock_counts k WHERE k.warehouse_id=w.id) AS last_count
      FROM warehouses w JOIN states s ON s.code=w.state_code WHERE w.id=$1`, id))!;
    const rec = await reconcile(id);
    const kg = b.flatMap((l) => l.receipts).filter((r) => r.wh_id === id).reduce((n, r) => n + r.kg, 0);
    const under = Number(await db.val(`SELECT count(*) FROM receipts r JOIN liens li ON li.receipt_id=r.id AND li.released_at IS NULL WHERE r.warehouse_id=$1 AND r.status='under_exception'`, id));
    out.push({ ...w, kg, holds: rec.flatMap((r) => r.flags.filter((f: any) => f.severity === 'hold').map((f: any) => `${r.commodity}: ${f.text}`)),
      reviews: rec.flatMap((r) => r.flags.filter((f: any) => f.severity === 'review').map((f: any) => `${r.commodity}: ${f.text}`)), under_review: under });
  }
  return out;
}

/** What is waiting on this lender's people. */
export async function work(a: Actor, orgId: string | null) {
  const batches = await db.all<any>(`SELECT b.ref, o.name AS lender, count(l.*)::int AS lines, COALESCE(sum(l.requested_kobo),0)::float AS requested FROM loan_batches b JOIN organisations o ON o.id=b.lender_org_id
    JOIN loan_lines l ON l.batch_id=b.id AND l.status='pending' WHERE b.status='submitted' AND ($1::uuid IS NULL OR b.lender_org_id=$1) GROUP BY b.ref, o.name ORDER BY b.ref`, orgId);
  const disburse = await db.all<any>(`SELECT ln.loan_no, ln.principal_kobo::float AS principal, f.full_name AS farmer_name, f.kyc_level, p.min_kyc_level, ln.approved_by FROM loans ln JOIN farmers f ON f.id=ln.farmer_id
    JOIN loan_products p ON p.id=ln.product_id WHERE ln.status='approved' AND ($1::uuid IS NULL OR ln.lender_org_id=$1) ORDER BY ln.approved_at`, orgId);
  const sales = await db.all<any>(`SELECT DISTINCT s.ref, s.buyer_name, s.kobo_per_kg::float AS perkg FROM sale_items x JOIN sales s ON s.id=x.sale_id
    WHERE s.status='proposed' AND x.lender_org_id IS NOT NULL AND x.lender_approved_at IS NULL AND ($1::uuid IS NULL OR x.lender_org_id=$1)`, orgId);
  const accounts = orgId ? await db.all<any>(`SELECT DISTINCT f.code, f.full_name FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id JOIN farmers f ON f.id=l.farmer_id JOIN loan_products p ON p.id=b.product_id
    WHERE b.lender_org_id=$1 AND l.status IN ('pending','approved') AND f.kyc_level < p.min_kyc_level`, orgId) : [];
  return { batches, disburse: disburse.map((d) => ({ ...d, mine: d.approved_by === a.user.id })), sales, accounts };
}

/** Readiness for a lender's dry run, worked out from what is actually set up. */
export async function checklist(orgId: string) {
  const v = async (sql: string) => Number(await db.val(sql, orgId));
  const items = [
    { done: (await v(`SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND u.status='active' AND m.role IN ('lender_admin','credit_officer')`)) >= 2,
      text: 'Two people who can approve and disburse (approval and payout must be different people)', link: '/admin/people' },
    { done: (await v(`SELECT count(*) FROM valuation_policies WHERE org_id=$1`)) > 0, text: 'Your haircut and loan-to-value set for at least one crop', link: '/valuation/policy' },
    { done: (await v(`SELECT count(*) FROM loan_products WHERE org_id=$1 AND active`)) > 0, text: 'A loan product (rate, fee, tenor, limits)', link: '/loans' },
    { done: (await v(`SELECT count(*) FROM lender_verifications WHERE org_id=$1 AND revoked_at IS NULL`)) > 0, text: 'At least one farmer’s account confirmed with your reference', link: '/farmers' },
    { done: (await v(`SELECT count(*) FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id WHERE b.lender_org_id=$1 AND l.status IN ('approved','rejected')`)) > 0, text: 'A loan request decided', link: '/loans' },
    { done: (await v(`SELECT count(*) FROM loans WHERE lender_org_id=$1 AND disbursed_on IS NOT NULL`)) > 0, text: 'A disbursement recorded', link: '/loans' },
    { done: (await v(`SELECT count(*) FROM loan_entries e JOIN loans ln ON ln.id=e.loan_id WHERE ln.lender_org_id=$1 AND e.kind='repayment'`)) > 0, text: 'A repayment recorded (by you or from a sale)', link: '/loans' },
    { done: (await v(`SELECT count(*) FROM audit_log WHERE org_id=$1 AND action='loan.ncr_export'`)) > 0, text: 'The collateral registry file downloaded', link: '/loans/ncr.csv' },
  ];
  return { items, done: items.filter((i) => i.done).length };
}

// ---------- exports ----------
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const naira = (k: number | null) => (k == null ? '' : (k / 100).toFixed(2));
export async function loanBookCsv(a: Actor) {
  const org = towerOrg(a);
  const b = await book(org);
  const head = ['loan_no', 'lender', 'farmer', 'farmer_code', 'state', 'principal_ngn', 'owed_today_ngn', 'interest_unpaid_ngn', 'stock_value_ngn', 'loan_to_stock_value_pct', 'warning_pct', 'liquidation_pct', 'due_on', 'days_overdue', 'receipts'];
  const rows = b.map((l) => [l.loan_no, l.lender, l.farmer_name, l.farmer_code, l.state, naira(l.principal), naira(l.outstanding), naira(l.interestOut), naira(l.market), l.ltv_bp == null ? '' : (l.ltv_bp / 100).toFixed(1),
    (l.margin_call_ltv_bp / 100).toFixed(0), (l.liquidation_ltv_bp / 100).toFixed(0), l.due_on, l.overdue_days, l.receipts.map((r) => `${r.receipt_no} (${r.kg} kg ${r.commodity}, ${r.warehouse})`).join('; ')].map(q).join(','));
  await audit(actorOf(a), 'tower.loan_book_export', { orgId: org ?? undefined, data: { rows: b.length } });
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}
