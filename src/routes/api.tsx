// StorageX partner API v1. JSON in and out; amounts in kobo (integers); dates as YYYY-MM-DD; times ISO 8601.
// Documentation: /developers (and the OpenAPI description at /api/v1/openapi.json).
import { get, post } from '../lib/router';
import { HttpError, type Ctx } from '../lib/http';
import { db } from '../lib/db';
import * as A from '../lib/api';
import * as F from '../lib/finance';
import * as Rc from '../lib/receipts';
import * as SL from '../lib/settlement';
import { alertsFor } from '../lib/alerts';
import { issuersList } from '../lib/issuers';
import { loanSeries, receiptSeries } from '../lib/history';
import { upsertDevice, recordReadings } from '../lib/wareguard';
import { openapi } from '../lib/api-spec';
import { UserError } from '../lib/errors';

const ymd = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }) : null);
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const kobo = (n: unknown) => (n == null ? null : Math.round(Number(n)));
const nairaStr = (k: unknown) => { const n = Number(k); if (!Number.isInteger(n) || n <= 0) throw new UserError('amount_kobo: a whole number of kobo above 0.'); return (n / 100).toFixed(2); };

/** Wrap a handler: authenticate, check the scope, answer JSON; user errors become 400 with { error }. */
function api(scope: A.Scope | null, h: (c: Ctx, x: A.ApiCtx) => Promise<unknown>) {
  return async (c: Ctx) => {
    const x = await A.authenticate(c);
    if (scope) A.need(x, scope);
    try { const out = await h(c, x); if (!c.done) c.json(out); }
    catch (e) { if (e instanceof UserError) return c.json({ error: e.message }, 400); throw e; }
  };
}

get('/api/v1/openapi.json', 'webhook', async (c) => c.json(openapi()));

get('/api/v1/me', 'webhook', api(null, async (_c, x) => ({
  organisation: { id: x.client.org_id, name: x.actor.membership!.org_name, kind: x.actor.membership!.org_kind },
  key: { name: x.client.name, scopes: x.client.scopes }, acting_as: { name: x.actor.user.full_name, role: x.actor.membership!.role },
})));

// ---------- receipts ----------
async function receiptOut(x: A.ApiCtx, no: string) {
  const r = await Rc.receiptByNo(x.actor, no);
  if (!r) throw new HttpError(404, 'Receipt not found, or not one you can see.');
  const today = await db.get<any>(`SELECT market_value_kobo, kobo_per_kg, valued_on FROM receipt_valuations WHERE receipt_id=$1 AND kobo_per_kg IS NOT NULL ORDER BY valued_on DESC LIMIT 1`, r.id);
  const lien = await db.get<any>(`SELECT ln.loan_no, li.lender_org_id = $2 AS yours FROM liens li JOIN loans ln ON ln.id=li.loan_id WHERE li.receipt_id=$1 AND li.released_at IS NULL`, r.id, x.client.org_id);
  return {
    receipt_no: r.receipt_no, status: r.status, commodity: { code: r.commodity_code, name: r.commodity }, grade: r.grade, moisture_pct: Number(r.moisture_pct),
    net_weight_kg: Number(r.net_weight_kg), bags: r.bags, warehouse: { code: r.wh_code, name: r.wh_name }, issued_at: iso(r.issued_at),
    issuer: r.issuer_name ?? 'Kitovu',
    storage: (() => { const t = Rc.termOf(r); return { months: t.months, until: t.until, days_left: t.days, state: t.state }; })(),
    value_at_storage: r.issue_value_kobo != null ? { kobo: kobo(r.issue_value_kobo), kobo_per_kg: kobo(r.issue_kobo_per_kg) } : null,
    value_today: today ? { kobo: kobo(today.market_value_kobo), kobo_per_kg: kobo(today.kobo_per_kg), on: ymd(today.valued_on) } : null,
    insurance: r.insurer_name ? { insurer: r.insurer_name, policy_no: r.policy_number, cover_to: ymd(r.cover_to) } : null,
    pledged: lien ? { to_you: !!lien.yours, loan_no: lien.yours ? lien.loan_no : undefined } : null,
    check_url: Rc.verifyUrl(r),
  };
}
get('/api/v1/receipts/:no', 'webhook', api('receipts:read', async (c, x) => receiptOut(x, c.params.no)));
get('/api/v1/receipts/:no/value-history', 'webhook', api('receipts:read', async (c, x) => {
  const r = await Rc.receiptByNo(x.actor, c.params.no);
  if (!r) throw new HttpError(404, 'Receipt not found, or not one you can see.');
  return { receipt_no: r.receipt_no, points: (await receiptSeries(r.id)).map((p) => ({ on: p.on, kobo: p.kobo, kobo_per_kg: p.per_kg, kg: p.kg })) };
}));

// ---------- loan requests ----------
get('/api/v1/loan-requests', 'webhook', api('loans:read', async (c, x) => {
  const status = ['pending', 'approved', 'rejected'].includes(String(c.query.status)) ? c.query.status : 'pending';
  const rows = await db.all<any>(`SELECT l.*, b.ref AS batch, p.name AS product, f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, po.name AS prepared_by, ln.loan_no
    FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id JOIN loan_products p ON p.id=b.product_id JOIN farmers f ON f.id=l.farmer_id
    LEFT JOIN organisations po ON po.id=b.prepared_by_org_id LEFT JOIN loans ln ON ln.id=l.loan_id
    WHERE b.lender_org_id=$1 AND b.status <> 'draft' AND l.status=$2 ORDER BY b.submitted_at DESC, f.full_name LIMIT 500`, x.client.org_id, status);
  const out = [];
  for (const l of rows) {
    const receipts = [];
    for (const id of l.receipt_ids) { const no = await db.val<string>('SELECT receipt_no FROM receipts WHERE id=$1', id); receipts.push(await receiptOut(x, no!)); }
    out.push({ id: l.id, status: l.status, batch: l.batch, product: l.product, prepared_by: l.prepared_by ?? 'Kitovu',
      farmer: { code: l.farmer_code, name: l.farmer_name, identity_level: l.kyc_level },
      requested_kobo: kobo(l.requested_kobo), max_loan_kobo: kobo(l.max_loan_kobo), market_value_kobo: kobo(l.market_value_kobo),
      review: l.review ?? null, decided_at: iso(l.decided_at), approved_kobo: kobo(l.approved_kobo), loan_no: l.loan_no ?? null, receipts });
  }
  return { data: out };
}));
post('/api/v1/loan-requests/:id/decision', 'webhook', async (c) => {
  const x = await A.authenticate(c); A.need(x, 'loans:decide');
  await A.idempotent(c, x, async () => {
    if (typeof c.body.approve !== 'boolean' && !['true', 'false'].includes(String(c.body.approve))) throw new UserError('approve: true or false.');
    const approve = String(c.body.approve) === 'true';
    await F.decideLine(x.actor, c.params.id, approve, { amount: (c.body as any).amount_kobo != null ? nairaStr((c.body as any).amount_kobo) : undefined, note: c.body.note });
    const l = await db.get<any>('SELECT l.status, l.approved_kobo, ln.loan_no FROM loan_lines l LEFT JOIN loans ln ON ln.id=l.loan_id WHERE l.id=$1', c.params.id);
    return { status: 200, body: { id: c.params.id, status: l.status, approved_kobo: kobo(l.approved_kobo), loan_no: l.loan_no ?? null } };
  });
});

// ---------- loans ----------
async function loanOut(x: A.ApiCtx, no: string, history = false) {
  const ln = await F.loanView(x.actor, no);
  if (!ln) throw new HttpError(404, 'Loan not found.');
  const p = ln.pos;
  return {
    loan_no: ln.loan_no, status: ln.status, product: ln.product, farmer: { code: ln.farmer_code, name: ln.farmer_name },
    principal_kobo: kobo(ln.principal), interest_bp_month: ln.interest_bp_month, fee_bp: ln.fee_bp, tenor_days: ln.tenor_days,
    disbursed_on: ymd(ln.disbursed_on), due_on: ymd(ln.due_on), disbursement_ref: ln.disbursement_ref ?? null,
    position: p ? { outstanding_kobo: p.outstanding, repaid_kobo: p.repaid, interest_kobo: p.interest, fees_kobo: p.fee, overdue_days: p.overdueDays } : null,
    collateral: { market_value_kobo: kobo(ln.mv.total), ltv_bp: ln.ltv_bp, margin_call_ltv_bp: ln.margin_call_ltv_bp, liquidation_ltv_bp: ln.liquidation_ltv_bp,
      receipts: ln.liens.map((l: any) => ({ receipt_no: l.receipt_no, status: l.receipt_status, kg: l.kg, commodity: l.commodity, warehouse: l.wh_name, released_at: iso(l.released_at) })) },
    allocations: await A.allocationsOf(ln.id, ln.principal, p?.repaid ?? 0),
    ...(history ? { value_history: await loanSeries(ln.id) } : {}),
  };
}
get('/api/v1/loans', 'webhook', api('loans:read', async (c, x) => {
  const rows = await F.loansFor(x.actor, { status: c.query.status });
  return { data: rows.map((r: any) => ({ loan_no: r.loan_no, status: r.status, farmer_code: r.farmer_code, principal_kobo: kobo(r.principal), disbursed_on: ymd(r.disbursed_on), due_on: ymd(r.due_on),
    outstanding_kobo: r.pos?.outstanding ?? null, market_value_kobo: r.market != null ? kobo(r.market) : null, ltv_bp: r.ltv_bp ?? null })) };
}));
get('/api/v1/loans/:no', 'webhook', api('loans:read', async (c, x) => loanOut(x, c.params.no, c.query.history === '1')));
get('/api/v1/loans/:no/allocations', 'webhook', api('loans:read', async (c, x) => { const l = await loanOut(x, c.params.no); return { loan_no: l.loan_no, data: l.allocations }; }));
post('/api/v1/loans/:no/allocations', 'webhook', async (c) => {
  const x = await A.authenticate(c); A.need(x, 'allocations:write');
  await A.idempotent(c, x, async () => ({ status: 200, body: await A.setAllocations(x, c.params.no, (c.body as any).allocations) }));
});
post('/api/v1/loans/:no/disbursement', 'webhook', async (c) => {
  const x = await A.authenticate(c); A.need(x, 'loans:disburse');
  await A.idempotent(c, x, async () => {
    await F.disburse(x.actor, c.params.no, { reference: c.body.reference, on: c.body.on });
    return { status: 200, body: await loanOut(x, c.params.no) };
  });
});

// ---------- sales of pledged stock ----------
get('/api/v1/sales', 'webhook', api('loans:read', async (c, x) => {
  const status = ['proposed', 'approved', 'settled', 'cancelled'].includes(String(c.query.status)) ? c.query.status : 'proposed';
  const rows = await db.all<any>(`SELECT s.id, s.ref, s.buyer_name, s.kobo_per_kg::float AS per_kg, s.status, s.created_at, c.name AS crop, w.name AS wh_name FROM sales s
    JOIN commodities c ON c.code=s.commodity_code JOIN warehouses w ON w.id=s.warehouse_id
    WHERE s.status=$2 AND EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id=s.id AND x.lender_org_id=$1) ORDER BY s.created_at DESC LIMIT 200`, x.client.org_id, status);
  const out = [];
  for (const s of rows) {
    const items = await db.all<any>(`SELECT x.id, r.receipt_no, x.kg::float AS kg, x.gross_kobo::float AS gross, x.lender_approved_at, x.farmer_agreed_at FROM sale_items x JOIN receipts r ON r.id=x.receipt_id
      WHERE x.sale_id=$1 AND x.lender_org_id=$2`, s.id, x.client.org_id);
    out.push({ ref: s.ref, status: s.status, buyer: s.buyer_name, kobo_per_kg: kobo(s.per_kg), commodity: s.crop, warehouse: s.wh_name, proposed_at: iso(s.created_at),
      items: items.map((i) => ({ item_id: i.id, receipt_no: i.receipt_no, kg: i.kg, gross_kobo: kobo(i.gross), you_approved: !!i.lender_approved_at, farmer_agreed: !!i.farmer_agreed_at })) });
  }
  return { data: out };
}));
post('/api/v1/sales/:ref/approve', 'webhook', async (c) => {
  const x = await A.authenticate(c); A.need(x, 'sales:approve');
  await A.idempotent(c, x, async () => {
    const items = await db.all<{ id: string }>(`SELECT x.id FROM sale_items x JOIN sales s ON s.id=x.sale_id WHERE s.ref=upper($1) AND x.lender_org_id=$2 AND x.lender_approved_at IS NULL`, String(c.params.ref).slice(0, 30), x.client.org_id);
    if (!items.length) throw new UserError('Nothing of yours to approve on this sale.');
    for (const i of items) await SL.lenderApprove(x.actor, i.id);
    return { status: 200, body: { sale: c.params.ref.toUpperCase(), approved_items: items.length, sale_status: await db.val('SELECT status FROM sales WHERE ref=upper($1)', c.params.ref) } };
  });
});

// ---------- alerts, issuers ----------
get('/api/v1/alerts', 'webhook', api('alerts:read', async (c, x) => ({
  data: (await alertsFor(x.actor, { all: c.query.all })).map((a: any) => ({ id: a.id, kind: a.kind, level: a.level, title: a.title, body: a.body, link: a.link, created_at: iso(a.created_at), seen_at: iso(a.seen_at) })),
})));
get('/api/v1/issuers', 'webhook', api('issuers:read', async (_c, x) => ({
  data: (await issuersList(x.actor)).map((r: any) => ({ code: r.code, name: r.name, status: r.status, tier: r.tier, your_terms: r.accepted == null ? null : { accepted: r.accepted, max_ltv_bp: r.max_ltv_bp },
    scorecard: { receipts: r.card.receipts, live_receipts: r.card.live_receipts, live_value_kobo: kobo(r.card.live_value), guarantee_kobo: kobo(r.card.guarantee), wareguard_devices: r.card.devices,
      wareguard_reporting: r.card.reporting, open_stock_checks: r.card.open_checks, loss_kg: r.card.shortfall_kg, loans: r.card.loans } })),
})));

// ---------- WareGuard (Titan) ----------
post('/api/v1/wareguard/devices', 'webhook', api('wareguard:write', async (c, x) => {
  if (x.actor.membership!.org_kind !== 'kitovu') throw new HttpError(403, 'Only Titan (a Kitovu key) sends WareGuard data.');
  const b = c.body as any;
  const w = await db.get<{ id: string }>('SELECT id FROM warehouses WHERE code=upper($1)', String(b.warehouse_code ?? '').slice(0, 20));
  if (!w) throw new UserError('warehouse_code: not a StorageX warehouse.');
  if (!/^[\w.:-]{3,80}$/.test(String(b.device_ref ?? ''))) throw new UserError('device_ref: Titan’s id for the device (3 to 80 characters).');
  const id = await upsertDevice(w.id, b.device_ref, String(b.label ?? b.device_ref).slice(0, 120));
  if (b.active === false) await db.run('UPDATE sensor_devices SET active=false WHERE id=$1', id);
  return { device_ref: b.device_ref, warehouse_code: String(b.warehouse_code).toUpperCase(), active: b.active !== false };
}));
post('/api/v1/wareguard/readings', 'webhook', api('wareguard:write', async (c, x) => {
  if (x.actor.membership!.org_kind !== 'kitovu') throw new HttpError(403, 'Only Titan (a Kitovu key) sends WareGuard data.');
  const b = c.body as any;
  const batches: any[] = Array.isArray(b.devices) ? b.devices : [b];
  if (batches.length > 500) throw new UserError('At most 500 devices per request.');
  let stored = 0; const unknown: string[] = [];
  for (const d of batches) {
    if (!Array.isArray(d.readings) || d.readings.length > 2000) throw new UserError('readings: a list of at most 2,000 { at, temp_c, rh_pct, door_open, battery_pct } per device.');
    try { stored += (await recordReadings(String(d.device_ref), d.readings)).stored; }
    catch (e: any) { if (String(e.message).startsWith('unknown WareGuard device')) unknown.push(String(d.device_ref)); else throw e; }
  }
  return { stored, unknown_devices: unknown };
}));
