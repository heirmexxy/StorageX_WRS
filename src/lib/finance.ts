// Finance engine (Build 7). Any lender, Kitovu included, lends against receipts:
//   Kitovu prepares a batch of requests (farmer + receipts + amount) for a lender's product and submits it;
//   the batch reviewer agent adds checks and a note; a lender credit officer approves or rejects each line
//   (never the person who prepared it); approval pledges the receipts (one active lien per receipt, enforced by the
//   database); a different lender person records the disbursement; repayments clear the loan and release the liens.
// Interest is simple, daily, on principal outstanding. Repayments go to fees, then interest, then principal.
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { toKobo, fmtNGN, bpOf } from './money';
import { notifyFarmer as notify } from './notify';
import { getSettings } from './settings';
import { clean } from './util';
import { policyFor, referencePrice, compute } from './valuation';
import { receiptBalance } from './stock';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';
const lendingOrg = (a: Actor) => ['lender', 'kitovu'].includes(a.membership?.org_kind ?? '');
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const naira = (s: string, label: string) => { try { const k = toKobo(s); if (k <= 0) throw 0; return k; } catch { throw new UserError(`${label}: enter an amount in naira, e.g. 150000.`); } };
const FREE = ['issued', 'partially_released'];

// ---------- products ----------
export async function createProduct(a: Actor, i: Record<string, string>) {
  if (!lendingOrg(a) || !can(a.membership, 'finance.configure')) throw new UserError('Only a lender’s finance administrator creates loan products.');
  const name = clean(i.name, 80);
  if (name.length < 3) throw new UserError('Name the product.');
  const rate = Math.round(Number(i.interest_pct_month) * 100), fee = Math.round(Number(i.fee_pct || 0) * 100), tenor = Number(i.tenor_days);
  if (!(rate >= 0 && rate <= 1000)) throw new UserError('Interest must be between 0% and 10% a month.');
  if (!(fee >= 0 && fee <= 1000)) throw new UserError('Fee must be between 0% and 10%.');
  if (!(Number.isInteger(tenor) && tenor >= 7 && tenor <= 365)) throw new UserError('Tenor must be 7 to 365 days.');
  const min = i.min_naira ? naira(i.min_naira, 'Minimum') : 0, max = naira(i.max_naira, 'Maximum');
  if (min > max) throw new UserError('The minimum is above the maximum.');
  const mc = Math.round(Number(i.margin_call_pct || 80) * 100), liq = Math.round(Number(i.liquidation_pct || 90) * 100);
  if (!(mc > 0 && mc < liq && liq <= 15000)) throw new UserError('The warning level must be below the liquidation level.');
  const coms = String(i.commodities ?? '').split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const kyc = i.min_kyc_level === '1' ? 1 : 2;
  if (await db.val('SELECT 1 FROM loan_products WHERE org_id=$1 AND name=$2', a.membership!.org_id, name)) throw new UserError('You already have a product with that name.');
  const id = await db.val<string>(
    `INSERT INTO loan_products (org_id, name, commodity_codes, interest_bp_month, fee_bp, tenor_days, min_kobo, max_kobo, min_kyc_level, margin_call_ltv_bp, liquidation_ltv_bp, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, a.membership!.org_id, name, coms, rate, fee, tenor, min, max, kyc, mc, liq, a.user.id);
  await audit(actorOf(a), 'loan.product_created', { orgId: a.membership!.org_id, entity: 'loan_product', entityId: id!, data: { name, rate, fee, tenor } });
}
export const productsOf = (orgId: string) => db.all<any>('SELECT * FROM loan_products WHERE org_id=$1 ORDER BY active DESC, name', orgId);
export const activeProducts = () => db.all<any>(`SELECT p.*, o.name AS lender, o.code AS lender_code FROM loan_products p JOIN organisations o ON o.id=p.org_id WHERE p.active AND o.status IN ('active','onboarding') ORDER BY o.name, p.name`);

// ---------- batches ----------
async function batch(id: string) {
  return db.get<any>(`SELECT b.*, p.name AS product, p.commodity_codes, p.min_kobo, p.max_kobo, p.min_kyc_level, p.interest_bp_month, p.fee_bp, p.tenor_days, o.name AS lender, o.code AS lender_code, o.kind AS lender_kind
    FROM loan_batches b JOIN loan_products p ON p.id=b.product_id JOIN organisations o ON o.id=b.lender_org_id WHERE b.id=$1`, id);
}
function canSeeBatch(a: Actor, b: any) { return isKitovu(a) || b.lender_org_id === a.membership?.org_id; }

export async function createBatch(a: Actor, productId: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Kitovu operations prepare loan requests.');
  const p = await db.get<{ id: string; org_id: string; active: boolean }>('SELECT id, org_id, active FROM loan_products WHERE id=$1', productId);
  if (!p?.active) throw new UserError('Choose an active loan product.');
  return tx(async () => {
    const day = ymd(new Date()).slice(2).replace(/-/g, '');
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'lb:' + day);
    const ref = `LB-${day}-${String(Number(await db.val(`SELECT count(*) FROM loan_batches WHERE ref LIKE $1`, `LB-${day}-%`)) + 1).padStart(3, '0')}`;
    const id = (await db.val<string>(`INSERT INTO loan_batches (ref, lender_org_id, product_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, ref, p.org_id, p.id, a.user.id))!;
    await audit(actorOf(a), 'loan.batch_created', { orgId: p.org_id, entity: 'loan_batch', entityId: id, data: { ref } });
    return { id, ref };
  });
}

/** What a set of receipts supports under the lender's policy today. */
export async function capacity(lenderOrgId: string, receiptIds: string[]) {
  let market = 0, maxLoan = 0; const missing: string[] = [];
  for (const id of receiptIds) {
    const r = (await db.get<{ receipt_no: string; commodity_code: string; state_code: string }>(`SELECT r.receipt_no, r.commodity_code, w.state_code FROM receipts r JOIN warehouses w ON w.id=r.warehouse_id WHERE r.id=$1`, id))!;
    const held = (await receiptBalance(id))!.remaining_kg;
    const ref = await referencePrice(r.commodity_code, r.state_code);
    const v = compute(held, ref, await policyFor(lenderOrgId, r.commodity_code));
    if (v.market === null) { missing.push(r.receipt_no); continue; }
    market += v.market; maxLoan += v.maxLoan!;
  }
  return { market, maxLoan, missing };
}

async function eligibleReceipts(b: any, farmerId: string, receiptNos: string[], exceptLine?: string) {
  const ids: string[] = [];
  for (const no of receiptNos) {
    const r = await db.get<{ id: string; status: string; owner_farmer_id: string; commodity_code: string; receipt_no: string }>(
      'SELECT id, status::text, owner_farmer_id, commodity_code, receipt_no FROM receipts WHERE receipt_no=upper($1)', clean(no, 40));
    if (!r) throw new UserError(`Receipt ${no} not found.`);
    if (r.owner_farmer_id !== farmerId) throw new UserError(`Receipt ${r.receipt_no} is not owned by this farmer.`);
    if (!FREE.includes(r.status)) throw new UserError(`Receipt ${r.receipt_no} is ${r.status.replace(/_/g, ' ')} and cannot be pledged.`);
    if (b.commodity_codes.length && !b.commodity_codes.includes(r.commodity_code)) throw new UserError(`This product does not lend against ${r.commodity_code}.`);
    if (await db.val('SELECT 1 FROM liens WHERE receipt_id=$1 AND released_at IS NULL', r.id)) throw new UserError(`Receipt ${r.receipt_no} is already pledged.`);
    const other = await db.val<string>(`SELECT b.ref FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id WHERE $1 = ANY(l.receipt_ids) AND l.status='pending' AND b.status IN ('draft','submitted') AND ($2::uuid IS NULL OR l.id <> $2)`, r.id, exceptLine ?? null);
    if (other) throw new UserError(`Receipt ${r.receipt_no} is already in loan request ${other}.`);
    ids.push(r.id);
  }
  if (!ids.length) throw new UserError('Add at least one receipt.');
  return [...new Set(ids)];
}

export async function addLine(a: Actor, batchId: string, i: { farmer?: string; receipts?: string; amount?: string }) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Kitovu operations prepare loan requests.');
  const b = await batch(batchId);
  if (!b || b.status !== 'draft') throw new UserError('Lines can be added only to a draft batch.');
  const f = await db.get<{ id: string; code: string; kyc_level: number; status: string }>('SELECT id, code, kyc_level, status FROM farmers WHERE code=upper($1)', clean(i.farmer, 12));
  if (!f || f.status !== 'active') throw new UserError('Farmer not found.');
  if (f.kyc_level < 1) throw new UserError('The farmer’s identity must be checked (level 1) before a loan request.');
  if (b.lender_kind === 'lender' && !(await db.val('SELECT 1 FROM farmer_consents WHERE farmer_id=$1 AND org_id=$2 AND withdrawn_at IS NULL', f.id, b.lender_org_id)))
    throw new UserError(`The farmer has not agreed to share their record with ${b.lender}. Record consent first.`);
  if (await db.val(`SELECT 1 FROM loan_lines WHERE batch_id=$1 AND farmer_id=$2`, b.id, f.id)) throw new UserError('This farmer is already in the batch. Remove the line and add it again to change it.');
  const ids = await eligibleReceipts(b, f.id, String(i.receipts ?? '').split(/[,\s]+/).filter(Boolean));
  const cap = await capacity(b.lender_org_id, ids);
  if (cap.missing.length) throw new UserError(`No usable price yet for ${cap.missing.join(', ')}. Approve market prices first.`);
  const amount = i.amount ? naira(i.amount, 'Amount') : cap.maxLoan - (cap.maxLoan % 100);
  if (amount > cap.maxLoan) throw new UserError(`At most ${fmtNGN(cap.maxLoan)} under ${b.lender}’s policy for these receipts.`);
  if (amount < Number(b.min_kobo) || amount > Number(b.max_kobo)) throw new UserError(`${b.product} lends between ${fmtNGN(b.min_kobo)} and ${fmtNGN(b.max_kobo)}.`);
  await db.run(`INSERT INTO loan_lines (batch_id, farmer_id, receipt_ids, requested_kobo, max_loan_kobo, market_value_kobo) VALUES ($1,$2,$3,$4,$5,$6)`, b.id, f.id, ids, amount, cap.maxLoan, cap.market);
  return { amount, max: cap.maxLoan };
}

export async function removeLine(a: Actor, lineId: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Kitovu operations prepare loan requests.');
  const n = await db.run(`DELETE FROM loan_lines l USING loan_batches b WHERE l.id=$1 AND b.id=l.batch_id AND b.status='draft'`, lineId);
  if (!n) throw new UserError('Only lines in a draft batch can be removed.');
}

export async function submitBatch(a: Actor, batchId: string, review: (lineId: string) => Promise<unknown>) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Kitovu operations submit loan requests.');
  const b = await batch(batchId);
  if (!b || b.status !== 'draft') throw new UserError('Only a draft batch can be submitted.');
  const lines = await db.all<{ id: string; receipt_ids: string[]; farmer_id: string; requested_kobo: string }>('SELECT id, receipt_ids, farmer_id, requested_kobo FROM loan_lines WHERE batch_id=$1', b.id);
  if (!lines.length) throw new UserError('Add at least one farmer to the batch.');
  for (const l of lines) {   // values can move between drafting and submitting
    const cap = await capacity(b.lender_org_id, l.receipt_ids);
    if (cap.missing.length || Number(l.requested_kobo) > cap.maxLoan) throw new UserError(`A line now asks for more than its receipts support (${fmtNGN(cap.maxLoan)}). Remove it and add it again.`);
    await db.run('UPDATE loan_lines SET max_loan_kobo=$2, market_value_kobo=$3 WHERE id=$1', l.id, cap.maxLoan, cap.market);
  }
  await db.run(`UPDATE loan_batches SET status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$1`, b.id, a.user.id);
  for (const l of lines) await review(l.id);
  await audit(actorOf(a), 'loan.batch_submitted', { orgId: b.lender_org_id, entity: 'loan_batch', entityId: b.id, data: { ref: b.ref, lines: lines.length } });
}

export async function batchesFor(a: Actor) {
  if (!can(a.membership, 'finance.view') && !can(a.membership, 'receipts.issue')) throw new UserError('Not allowed.');
  return db.all<any>(
    `SELECT b.*, o.name AS lender, p.name AS product, (SELECT count(*)::int FROM loan_lines l WHERE l.batch_id=b.id) AS lines,
       (SELECT COALESCE(sum(requested_kobo),0)::float FROM loan_lines l WHERE l.batch_id=b.id AND l.status <> 'removed') AS requested,
       (SELECT count(*)::int FROM loan_lines l WHERE l.batch_id=b.id AND l.status='pending') AS pending
     FROM loan_batches b JOIN organisations o ON o.id=b.lender_org_id JOIN loan_products p ON p.id=b.product_id
     WHERE ($1::uuid IS NULL OR (b.lender_org_id=$1 AND b.status <> 'draft')) ORDER BY b.created_at DESC LIMIT 100`, isKitovu(a) ? null : a.membership!.org_id);
}
export async function batchView(a: Actor, ref: string) {
  const id = await db.val<string>('SELECT id FROM loan_batches WHERE ref=upper($1)', clean(ref, 20));
  const b = id ? await batch(id) : undefined;
  if (!b || !canSeeBatch(a, b) || (!isKitovu(a) && b.status === 'draft')) return undefined;
  b.lines = await db.all<any>(
    `SELECT l.*, l.requested_kobo::float AS requested, l.max_loan_kobo::float AS max_loan, l.market_value_kobo::float AS market, l.approved_kobo::float AS approved,
       f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, f.community, u.full_name AS decider, ln.loan_no,
       (SELECT string_agg(r.receipt_no, ', ' ORDER BY r.receipt_no) FROM receipts r WHERE r.id = ANY(l.receipt_ids)) AS receipt_nos
     FROM loan_lines l JOIN farmers f ON f.id=l.farmer_id LEFT JOIN users u ON u.id=l.decided_by LEFT JOIN loans ln ON ln.id=l.loan_id WHERE l.batch_id=$1 ORDER BY f.full_name`, b.id);
  return b;
}

// ---------- decisions, liens, disbursement ----------
async function pledge(loanId: string, lenderOrgId: string, receiptIds: string[], userId: string, loanNo: string, lender: string) {
  for (const rid of receiptIds) {
    const r = (await db.get<{ status: string }>('SELECT status::text FROM receipts WHERE id=$1 FOR UPDATE', rid))!;
    if (!FREE.includes(r.status)) throw new UserError('A receipt in this request is no longer free to pledge.');
    await db.run(`INSERT INTO liens (receipt_id, loan_id, lender_org_id, previous_status) VALUES ($1,$2,$3,$4)`, rid, loanId, lenderOrgId, r.status);
    await db.run(`UPDATE receipts SET status='pledged', distribution_enabled=false WHERE id=$1`, rid);
    await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'pledged',now(),$2,$3)`, rid, `user:${userId}`, JSON.stringify({ loan_no: loanNo, lender }));
  }
}
async function releaseLiens(loanId: string, userId: string, reason: string) {
  const ls = await db.all<{ id: string; receipt_id: string; previous_status: string }>('SELECT id, receipt_id, previous_status FROM liens WHERE loan_id=$1 AND released_at IS NULL', loanId);
  for (const l of ls) {
    await db.run('UPDATE liens SET released_at=now(), release_reason=$2 WHERE id=$1', l.id, reason);
    const cur = await db.val<string>('SELECT status::text FROM receipts WHERE id=$1 FOR UPDATE', l.receipt_id);
    if (cur === 'pledged' || cur === 'financed') await db.run(`UPDATE receipts SET status=$2 WHERE id=$1`, l.receipt_id, l.previous_status);
    await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'lien_released',now(),$2,$3)`, l.receipt_id, `user:${userId}`, JSON.stringify({ reason }));
  }
}

export async function decideLine(a: Actor, lineId: string, approve: boolean, i: { amount?: string; note?: string }) {
  const l = await db.get<any>('SELECT l.*, b.created_by, b.submitted_by, b.lender_org_id, b.status AS batch_status, b.id AS bid FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id WHERE l.id=$1', lineId);
  if (!l || l.batch_status !== 'submitted' || l.status !== 'pending') throw new UserError('This request is not waiting for a decision.');
  if (a.membership?.org_id !== l.lender_org_id || !can(a.membership, 'finance.approve')) throw new UserError('Only the lender’s credit staff decide this request.');
  if (a.user.id === l.created_by || a.user.id === l.submitted_by) throw new UserError('You prepared this request, so someone else must decide it.');
  const b = (await batch(l.bid))!;
  const note = clean(i.note, 400);
  await tx(async () => {
    if (!approve) {
      if (note.length < 3) throw new UserError('Give the reason (Kitovu and the farmer will see it).');
      await db.run(`UPDATE loan_lines SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, l.id, a.user.id, note);
    } else {
      const amount = i.amount ? naira(i.amount, 'Amount') : Number(l.requested_kobo);
      if (amount > Number(l.requested_kobo)) throw new UserError('You can approve the amount requested or less.');
      const cap = await capacity(l.lender_org_id, l.receipt_ids);
      if (amount > cap.maxLoan) throw new UserError(`The receipts now support at most ${fmtNGN(cap.maxLoan)} under your policy.`);
      await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'loan:' + l.lender_org_id);
      const loanNo = `LN-${b.lender_code}-${String(Number(await db.val('SELECT count(*) FROM loans WHERE lender_org_id=$1', l.lender_org_id)) + 1).padStart(5, '0')}`;
      const loanId = (await db.val<string>(
        `INSERT INTO loans (loan_no, lender_org_id, product_id, line_id, farmer_id, principal_kobo, interest_bp_month, fee_bp, tenor_days, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        loanNo, l.lender_org_id, b.product_id, l.id, l.farmer_id, amount, b.interest_bp_month, b.fee_bp, b.tenor_days, a.user.id))!;
      await pledge(loanId, l.lender_org_id, l.receipt_ids, a.user.id, loanNo, b.lender);
      await db.run(`UPDATE loan_lines SET status='approved', approved_kobo=$2, decided_by=$3, decided_at=now(), decision_note=$4, loan_id=$5 WHERE id=$1`, l.id, amount, a.user.id, note || null, loanId);
    }
    if (!(await db.val(`SELECT 1 FROM loan_lines WHERE batch_id=$1 AND status='pending'`, l.bid))) await db.run(`UPDATE loan_batches SET status='decided' WHERE id=$1`, l.bid);
    await audit(actorOf(a), approve ? 'loan.approved' : 'loan.rejected', { orgId: l.lender_org_id, entity: 'loan_line', entityId: l.id, data: { note: note || null } });
  });
}

async function loanRow(loanNo: string) {
  return db.get<any>(`SELECT ln.*, ln.principal_kobo::float AS principal, o.name AS lender, o.code AS lender_code, p.name AS product, p.min_kyc_level, p.margin_call_ltv_bp, p.liquidation_ltv_bp,
      f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, f.phone_e164, f.phone_verified_at, ua.full_name AS approver, ud.full_name AS disburser
    FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id JOIN loan_products p ON p.id=ln.product_id JOIN farmers f ON f.id=ln.farmer_id
      JOIN users ua ON ua.id=ln.approved_by LEFT JOIN users ud ON ud.id=ln.disbursed_by WHERE ln.loan_no=upper($1)`, clean(loanNo, 30));
}
function lenderStaff(a: Actor, ln: any, perm: 'finance.approve' | 'finance.view' = 'finance.approve') {
  if (a.membership?.org_id !== ln.lender_org_id || !can(a.membership, perm)) throw new UserError('Only the lender’s finance staff can do this.');
}

export async function disburse(a: Actor, loanNo: string, i: { reference?: string; on?: string }) {
  const ln = await loanRow(loanNo);
  if (!ln) throw new UserError('Loan not found.');
  lenderStaff(a, ln);
  if (ln.status !== 'approved') throw new UserError(`This loan is ${ln.status}.`);
  if (ln.approved_by === a.user.id) throw new UserError('You approved this loan, so someone else must record the disbursement.');
  if (ln.kyc_level < ln.min_kyc_level) throw new UserError('This product needs the farmer at identity level 2: confirm the farmer’s account with your bank first (on the farmer’s page).');
  const ref = clean(i.reference, 60);
  if (ref.length < 4) throw new UserError('Enter the transfer reference from your banking system.');
  if (/^\d{10}$/.test(ref)) throw new UserError('That looks like an account number. Enter the transfer reference instead.');
  const on = i.on ? new Date(i.on + 'T12:00:00+01:00') : new Date();
  if (isNaN(on.getTime()) || on.getTime() > Date.now() + 86_400_000 || Date.now() - on.getTime() > 14 * 86_400_000) throw new UserError('The disbursement date must be within the last 14 days.');
  const day = ymd(on), due = ymd(new Date(on.getTime() + ln.tenor_days * 86_400_000));
  await tx(async () => {
    await db.run(`UPDATE loans SET status='disbursed', disbursed_by=$2, disbursed_on=$3, disbursement_ref=$4, due_on=$5 WHERE id=$1`, ln.id, a.user.id, day, ref, due);
    await db.run(`INSERT INTO loan_entries (loan_id, kind, amount_kobo, on_date, reference, recorded_by) VALUES ($1,'disbursement',$2,$3,$4,$5)`, ln.id, ln.principal, day, ref, a.user.id);
    const fee = bpOf(ln.principal, ln.fee_bp);
    if (fee > 0) await db.run(`INSERT INTO loan_entries (loan_id, kind, amount_kobo, on_date, note, recorded_by) VALUES ($1,'fee',$2,$3,'processing fee',$4)`, ln.id, fee, day, a.user.id);
    const rs = await db.all<{ receipt_id: string }>('SELECT receipt_id FROM liens WHERE loan_id=$1 AND released_at IS NULL', ln.id);
    for (const r of rs) {
      await db.run(`UPDATE receipts SET status='financed' WHERE id=$1 AND status='pledged'`, r.receipt_id);
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'financed',now(),$2,$3)`, r.receipt_id, `user:${a.user.id}`, JSON.stringify({ loan_no: ln.loan_no, lender: ln.lender }));
    }
    await audit(actorOf(a), 'loan.disbursed', { orgId: ln.lender_org_id, entity: 'loan', entityId: ln.id, data: { loan_no: ln.loan_no, kobo: ln.principal, due } });
  });
  await notify(ln.farmer_id, 'loan_disbursed', ln.loan_no, { lender: ln.lender, loan: ln.loan_no, amount: fmtNGN(ln.principal, { decimals: false }), due });
}

export async function cancelLoan(a: Actor, loanNo: string, reason: string) {
  const ln = await loanRow(loanNo);
  if (!ln) throw new UserError('Loan not found.');
  lenderStaff(a, ln);
  if (ln.status !== 'approved') throw new UserError('Only an approved loan that has not been disbursed can be cancelled.');
  if (clean(reason).length < 5) throw new UserError('Give the reason.');
  await tx(async () => {
    await db.run(`UPDATE loans SET status='cancelled', closed_at=now() WHERE id=$1`, ln.id);
    await releaseLiens(ln.id, a.user.id, `loan ${ln.loan_no} cancelled: ${clean(reason, 200)}`);
    await audit(actorOf(a), 'loan.cancelled', { orgId: ln.lender_org_id, entity: 'loan', entityId: ln.id, data: { reason: clean(reason, 200) } });
  });
}

// ---------- money on a loan ----------
export interface Position { principal: number; fee: number; interest: number; repaid: number; waived: number; outstanding: number; principalOut: number; interestOut: number; feeOut: number; daysIn: number; overdueDays: number }

/** Simple daily interest on principal outstanding; repayments pay fees, then interest, then principal. */
export function position(ln: { interest_bp_month: number; disbursed_on: Date | string | null; due_on: Date | string | null }, entries: { kind: string; amount_kobo: number | string; on_date: Date | string }[], asOf = new Date()): Position {
  const d = (x: Date | string) => new Date(typeof x === 'string' ? x + (x.length === 10 ? 'T00:00:00Z' : '') : x.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const end = d(ymd(asOf));
  const es = [...entries].sort((x, y) => d(x.on_date) - d(y.on_date) || (x.kind === 'repayment' ? 1 : -1));
  let pOut = 0, feeOut = 0, intOut = 0, principal = 0, fee = 0, interest = 0, repaid = 0, waived = 0, last: number | null = null, acc = 0;
  const rate = ln.interest_bp_month / 10_000 / 30;
  const accrue = (to: number) => { if (last !== null && to > last) { acc += pOut * rate * ((to - last) / 86_400_000); last = to; } const whole = Math.floor(acc); intOut += whole; interest += whole; acc -= whole; };
  for (const e of es) {
    const t = d(e.on_date), amt = Number(e.amount_kobo);
    if (t > end) continue;
    accrue(t);
    if (last === null) last = t;
    if (e.kind === 'disbursement') { pOut += amt; principal += amt; }
    else if (e.kind === 'fee') { feeOut += amt; fee += amt; }
    else {
      let left = amt;
      const pay = (x: number) => { const p = Math.min(x, left); left -= p; return p; };
      feeOut -= pay(feeOut); intOut -= pay(intOut); pOut -= pay(pOut);
      if (e.kind === 'repayment') repaid += amt - left; else waived += amt - left;
    }
  }
  accrue(end);
  const outstanding = pOut + intOut + feeOut;
  const due = ln.due_on ? d(ln.due_on) : null;
  return { principal, fee, interest, repaid, waived, outstanding, principalOut: pOut, interestOut: intOut, feeOut, daysIn: ln.disbursed_on ? Math.round((end - d(ln.disbursed_on)) / 86_400_000) : 0,
    overdueDays: due && outstanding > 0 && end > due ? Math.round((end - due) / 86_400_000) : 0 };
}
export const entriesOf = (loanId: string) => db.all<any>('SELECT e.*, u.full_name AS by_name FROM loan_entries e LEFT JOIN users u ON u.id=e.recorded_by WHERE e.loan_id=$1 ORDER BY e.on_date, e.id', loanId);

export async function repay(a: Actor, loanNo: string, i: { amount?: string; on?: string; reference?: string; kind?: string; note?: string }) {
  const ln = await loanRow(loanNo);
  if (!ln) throw new UserError('Loan not found.');
  const kitovuFin = isKitovu(a) && can(a.membership, 'finance.approve');
  if (!kitovuFin) lenderStaff(a, ln);
  if (ln.status !== 'disbursed') throw new UserError(`This loan is ${ln.status}.`);
  const kind = i.kind === 'waiver' ? 'waiver' : 'repayment';
  if (kind === 'waiver' && (a.membership?.org_id !== ln.lender_org_id)) throw new UserError('Only the lender can waive interest or fees.');
  const amount = naira(i.amount ?? '', 'Amount');
  const on = i.on ? new Date(i.on + 'T12:00:00+01:00') : new Date();
  if (isNaN(on.getTime()) || on.getTime() > Date.now() + 86_400_000) throw new UserError('The date cannot be in the future.');
  if (on.getTime() < new Date(ln.disbursed_on).getTime() - 86_400_000) throw new UserError('The date is before the disbursement.');
  const ref = clean(i.reference, 60);
  if (kind === 'repayment' && ref.length < 4) throw new UserError('Enter the payment reference.');
  if (kind === 'waiver' && clean(i.note).length < 5) throw new UserError('Explain the waiver.');
  const before = position(ln, await entriesOf(ln.id), on);
  if (amount > before.outstanding + 100) throw new UserError(`That is more than the ${fmtNGN(before.outstanding)} owed on that date.`);
  const res = await tx(async () => {
    await db.run(`INSERT INTO loan_entries (loan_id, kind, amount_kobo, on_date, reference, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ln.id, kind, Math.min(amount, before.outstanding), ymd(on), ref || null, clean(i.note, 300) || null, a.user.id);
    const after = position(ln, await entriesOf(ln.id));
    let closed = false;
    if (after.outstanding <= 0) {
      closed = true;
      await db.run(`UPDATE loans SET status='repaid', closed_at=now() WHERE id=$1`, ln.id);
      await releaseLiens(ln.id, a.user.id, `loan ${ln.loan_no} repaid`);
    }
    await audit(actorOf(a), `loan.${kind}`, { orgId: ln.lender_org_id, entity: 'loan', entityId: ln.id, data: { kobo: amount, closed } });
    return { closed, outstanding: after.outstanding };
  });
  if (kind === 'repayment') await notify(ln.farmer_id, res.closed ? 'loan_closed' : 'loan_repayment', `${ln.loan_no}:${ref}`,
    { lender: ln.lender, loan: ln.loan_no, amount: fmtNGN(Math.min(amount, before.outstanding)), owed: fmtNGN(res.outstanding) });
  return res;
}

// ---------- views, margin watch, NCR ----------
async function marketValue(loanId: string) {
  const rs = await db.all<{ receipt_id: string; commodity_code: string; state_code: string }>(
    `SELECT l.receipt_id, r.commodity_code, w.state_code FROM liens l JOIN receipts r ON r.id=l.receipt_id JOIN warehouses w ON w.id=r.warehouse_id WHERE l.loan_id=$1 AND l.released_at IS NULL`, loanId);
  let total = 0, unpriced = 0;
  for (const r of rs) {
    const ref = await referencePrice(r.commodity_code, r.state_code);
    if (!ref.kobo_per_kg) { unpriced++; continue; }
    total += Math.round(((await receiptBalance(r.receipt_id))!.remaining_kg) * ref.kobo_per_kg);
  }
  return { total, unpriced, receipts: rs.length };
}

export async function loansFor(a: Actor, q: { status?: string } = {}) {
  if (!can(a.membership, 'finance.view')) throw new UserError('Not allowed.');
  const rows = await db.all<any>(`SELECT ln.*, ln.principal_kobo::float AS principal, o.name AS lender, f.full_name AS farmer_name, f.code AS farmer_code, p.margin_call_ltv_bp, p.liquidation_ltv_bp
     FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id JOIN farmers f ON f.id=ln.farmer_id JOIN loan_products p ON p.id=ln.product_id
     WHERE ($1::uuid IS NULL OR ln.lender_org_id=$1) AND ($2 = '' OR ln.status=$2) ORDER BY ln.approved_at DESC LIMIT 300`,
    isKitovu(a) ? null : a.membership!.org_id, clean(q.status, 20));
  for (const r of rows) {
    if (r.status !== 'disbursed') continue;
    r.pos = position(r, await entriesOf(r.id));
    const mv = await marketValue(r.id);
    r.market = mv.total; r.ltv_bp = mv.total ? Math.round((r.pos.outstanding / mv.total) * 10_000) : null;
  }
  return rows;
}

export async function loanView(a: Actor, loanNo: string) {
  if (!can(a.membership, 'finance.view')) return undefined;
  const ln = await loanRow(loanNo);
  if (!ln || (!isKitovu(a) && ln.lender_org_id !== a.membership!.org_id)) return undefined;
  ln.entries = await entriesOf(ln.id);
  ln.pos = ln.status === 'disbursed' || ln.status === 'repaid' ? position(ln, ln.entries) : null;
  ln.mv = await marketValue(ln.id);
  ln.ltv_bp = ln.pos && ln.mv.total ? Math.round((ln.pos.outstanding / ln.mv.total) * 10_000) : null;
  ln.liens = await db.all(`SELECT l.*, r.receipt_no, r.status::text AS receipt_status, r.net_weight_kg::float AS kg, c.name AS commodity, w.name AS wh_name FROM liens l JOIN receipts r ON r.id=l.receipt_id
    JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id WHERE l.loan_id=$1 ORDER BY l.created_at`, ln.id);
  return ln;
}

/** Loans whose debt has grown too close to the value of the stock behind them (prices fell or interest built up). */
export async function marginAlerts(orgId: string | null) {
  const ls = await db.all<any>(`SELECT ln.*, p.margin_call_ltv_bp, p.liquidation_ltv_bp, f.full_name AS farmer_name FROM loans ln JOIN loan_products p ON p.id=ln.product_id JOIN farmers f ON f.id=ln.farmer_id
    WHERE ln.status='disbursed' AND ($1::uuid IS NULL OR ln.lender_org_id=$1)`, orgId);
  const out = [];
  for (const ln of ls) {
    const pos = position(ln, await entriesOf(ln.id)), mv = await marketValue(ln.id);
    const ltv = mv.total ? Math.round((pos.outstanding / mv.total) * 10_000) : null;
    if (ltv === null || ltv >= ln.margin_call_ltv_bp || pos.overdueDays > 0)
      out.push({ loan_no: ln.loan_no, farmer: ln.farmer_name, ltv_bp: ltv, level: ltv === null ? 'no_price' : ltv >= ln.liquidation_ltv_bp ? 'liquidation' : ltv >= ln.margin_call_ltv_bp ? 'margin_call' : 'overdue', overdue_days: pos.overdueDays, outstanding: pos.outstanding });
  }
  return out;
}

/** National Collateral Registry: one row per active lien, for the lender to file. StorageX holds no BVN/NIN, so the
 *  lender adds the debtor's identity number from its own records. */
export async function ncrCsv(a: Actor) {
  if (!lendingOrg(a) || !can(a.membership, 'finance.view')) throw new UserError('Not allowed.');
  const rows = await db.all<any>(
    `SELECT ln.loan_no, f.code AS farmer_code, f.full_name, f.phone_e164, s.name AS state, f.community, v.customer_ref, r.receipt_no, c.name AS commodity, b.remaining_kg::float AS kg,
            w.name AS warehouse, w.code AS wh_code, ln.principal_kobo::float AS principal, ln.disbursed_on, ln.due_on, li.created_at AS lien_date
     FROM liens li JOIN loans ln ON ln.id=li.loan_id JOIN receipts r ON r.id=li.receipt_id JOIN receipt_balances b ON b.receipt_id=r.id JOIN commodities c ON c.code=r.commodity_code
       JOIN warehouses w ON w.id=r.warehouse_id JOIN farmers f ON f.id=ln.farmer_id LEFT JOIN states s ON s.code=f.state_code
       LEFT JOIN lender_verifications v ON v.farmer_id=f.id AND v.org_id=ln.lender_org_id AND v.revoked_at IS NULL
     WHERE li.released_at IS NULL AND ln.lender_org_id=$1 ORDER BY ln.loan_no, r.receipt_no`, a.membership!.org_id);
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['loan_no', 'debtor_name', 'debtor_phone', 'debtor_state', 'debtor_community', 'your_customer_ref', 'storagex_farmer_code', 'collateral_type', 'collateral_description', 'receipt_no', 'quantity_kg', 'warehouse', 'secured_amount_ngn', 'lien_date', 'disbursed_on', 'maturity_date'];
  const lines = rows.map((r) => [r.loan_no, r.full_name, r.phone_e164, r.state, r.community, r.customer_ref, r.farmer_code, 'Warehouse receipt (agricultural produce)',
    `${r.kg} kg ${r.commodity} at ${r.warehouse} (${r.wh_code})`, r.receipt_no, r.kg, r.warehouse, (r.principal / 100).toFixed(2), ymd(new Date(r.lien_date)), r.disbursed_on ? ymd(new Date(r.disbursed_on)) : '', r.due_on ? ymd(new Date(r.due_on)) : ''].map(q).join(','));
  await audit(actorOf(a), 'loan.ncr_export', { orgId: a.membership!.org_id, data: { rows: rows.length } });
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
