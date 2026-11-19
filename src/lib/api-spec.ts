// One description of the partner API, used for the /developers page and the OpenAPI file. Keep it in step with
// routes/api.tsx: the tests call every endpoint listed here.
import { config } from './config';
import { SCOPES } from './api';
import { EVENTS } from './webhooks';

export interface Endpoint {
  method: 'GET' | 'POST'; path: string; scope: string | null; summary: string; detail?: string;
  query?: { name: string; desc: string }[]; body?: unknown; response: unknown; idempotent?: boolean;
}

const RECEIPT = {
  receipt_no: 'SX-OY-ISY-261104-0018', status: 'financed', commodity: { code: 'MAZ', name: 'Maize (white)' }, grade: 'A', moisture_pct: 12.8,
  net_weight_kg: 2450, bags: 49, warehouse: { code: 'WH-OY-ISY-01', name: 'Iseyin Grain Store' }, issued_at: '2026-11-04T09:42:00.000Z', issuer: 'Kitovu',
  storage: { months: 6, until: '2027-05-04', days_left: 166, state: 'in_term' }, value_at_storage: { kobo: 142100000, kobo_per_kg: 58000 }, value_today: { kobo: 149450000, kobo_per_kg: 61000, on: '2026-11-18' },
  insurance: { insurer: 'Stock cover for fire, flood and theft', policy_no: 'SXW-ISY-2026-07', cover_to: '2027-06-30' }, pledged: { to_you: true, loan_no: 'LN-FUNDCO-00012' },
  check_url: 'https://storagex.com.ng/r/3f1c…',
};
const LOAN = {
  loan_no: 'LN-FUNDCO-00012', status: 'disbursed', product: 'Harvest 90', farmer: { code: 'SXF-104233', name: 'Funmilayo Adeyemi' },
  principal_kobo: 84500000, interest_bp_month: 250, fee_bp: 100, tenor_days: 90, disbursed_on: '2026-11-06', due_on: '2027-02-04', disbursement_ref: 'FT-2026-118833',
  position: { outstanding_kobo: 86235000, repaid_kobo: 0, interest_kobo: 890000, fees_kobo: 845000, overdue_days: 0 },
  collateral: { market_value_kobo: 149450000, ltv_bp: 5770, margin_call_ltv_bp: 8000, liquidation_ltv_bp: 9000,
    receipts: [{ receipt_no: 'SX-OY-ISY-261104-0018', status: 'financed', kg: 2450, commodity: 'Maize (white)', warehouse: 'Iseyin Grain Store', released_at: null }] },
  allocations: [{ user_ref: 'usr_8f2a1', amount_kobo: 50000000, share: 0.591716, repaid_kobo: 0 }, { user_ref: 'usr_c41d9', amount_kobo: 34500000, share: 0.408284, repaid_kobo: 0 }],
};

export const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/api/v1/me', scope: null, summary: 'Who this key is', response: { organisation: { id: '…', name: 'FundCo', kind: 'lender' }, key: { name: 'Loan service', scopes: ['loans:read'] }, acting_as: { name: 'Ada Bello', role: 'credit_officer' } } },
  { method: 'GET', path: '/api/v1/loan-requests', scope: 'loans:read', summary: 'Loan requests sent to you',
    detail: 'Each request is one farmer and the receipts they pledge, prepared by Kitovu or by a receipt issuer you accept. It carries the batch reviewer’s checks and the most it can be under your policy today.',
    query: [{ name: 'status', desc: 'pending (default), approved or rejected' }],
    response: { data: [{ id: '4b1e…', status: 'pending', batch: 'LB-261118-003', product: 'Harvest 90', prepared_by: 'Kitovu', farmer: { code: 'SXF-104233', name: 'Funmilayo Adeyemi', identity_level: 2 },
      requested_kobo: 84500000, max_loan_kobo: 99470000, market_value_kobo: 142100000, review: { checks: ['…'], note: '…' }, decided_at: null, approved_kobo: null, loan_no: null, receipts: [RECEIPT] }] } },
  { method: 'POST', path: '/api/v1/loan-requests/{id}/decision', scope: 'loans:decide', idempotent: true, summary: 'Approve or reject a loan request',
    detail: 'Approving creates the loan and pledges the receipts to you at once: no other lender can take them. You may approve less than was asked. Rejecting needs a reason the farmer will see. The person whose key prepared a request cannot decide it.',
    body: { approve: true, amount_kobo: 84500000, note: 'Within policy' }, response: { id: '4b1e…', status: 'approved', approved_kobo: 84500000, loan_no: 'LN-FUNDCO-00012' } },
  { method: 'POST', path: '/api/v1/loans/{loan_no}/allocations', scope: 'allocations:write', idempotent: true, summary: 'Split a loan among your users',
    detail: 'For funding partners whose users fund loans. Send your own opaque reference for each user, never a name, phone, email or account number. Replace the split freely until the loan is paid out; after that, set it once and it is fixed. The total may not exceed the loan.',
    body: { allocations: [{ user_ref: 'usr_8f2a1', amount_kobo: 50000000 }, { user_ref: 'usr_c41d9', amount_kobo: 34500000 }] },
    response: { loan_no: 'LN-FUNDCO-00012', users: 2, allocated_kobo: 84500000, unallocated_kobo: 0 } },
  { method: 'POST', path: '/api/v1/loans/{loan_no}/disbursement', scope: 'loans:disburse', idempotent: true, summary: 'Record that you paid the loan out',
    detail: 'Send the transfer reference from your bank or wallet system (not an account number). The key must belong to a different person from the one who approved the loan. Interest starts from the disbursement date.',
    body: { reference: 'FT-2026-118833', on: '2026-11-06' }, response: LOAN },
  { method: 'GET', path: '/api/v1/loans', scope: 'loans:read', summary: 'Your loans', query: [{ name: 'status', desc: 'approved, disbursed, repaid, written_off or cancelled (default: all)' }],
    response: { data: [{ loan_no: 'LN-FUNDCO-00012', status: 'disbursed', farmer_code: 'SXF-104233', principal_kobo: 84500000, disbursed_on: '2026-11-06', due_on: '2027-02-04', outstanding_kobo: 86235000, market_value_kobo: 149450000, ltv_bp: 5770 }] } },
  { method: 'GET', path: '/api/v1/loans/{loan_no}', scope: 'loans:read', summary: 'One loan: position, collateral, allocations',
    detail: 'Add ?history=1 for the value of the stock and what was owed, day by day since the loan was paid out.', query: [{ name: 'history', desc: '1 to include value_history' }], response: LOAN },
  { method: 'GET', path: '/api/v1/loans/{loan_no}/allocations', scope: 'loans:read', summary: 'Each user’s share of the loan and of repayments so far',
    detail: 'Repayments are shared in proportion to each user’s amount. repaid_kobo is rounded down to the kobo.', response: { loan_no: 'LN-FUNDCO-00012', data: LOAN.allocations } },
  { method: 'GET', path: '/api/v1/receipts/{receipt_no}', scope: 'receipts:read', summary: 'A receipt: status, value at storage, value today', response: RECEIPT },
  { method: 'GET', path: '/api/v1/receipts/{receipt_no}/value-history', scope: 'receipts:read', summary: 'A receipt’s value from storage to today',
    response: { receipt_no: 'SX-OY-ISY-261104-0018', points: [{ on: '2026-11-04', kobo: 142100000, kobo_per_kg: 58000, kg: 2450 }, { on: '2026-11-18', kobo: 149450000, kobo_per_kg: 61000, kg: 2450 }] } },
  { method: 'GET', path: '/api/v1/sales', scope: 'loans:read', summary: 'Sales of stock pledged to you', query: [{ name: 'status', desc: 'proposed (default), approved, settled or cancelled' }],
    response: { data: [{ ref: 'SL-261118-002', status: 'proposed', buyer: 'Sahel Mills Ltd', kobo_per_kg: 65000, commodity: 'Maize (white)', warehouse: 'Iseyin Grain Store', proposed_at: '2026-11-18T10:00:00.000Z',
      items: [{ item_id: '9c0d…', receipt_no: 'SX-OY-ISY-261104-0018', kg: 2450, gross_kobo: 159250000, you_approved: false, farmer_agreed: true }] }] } },
  { method: 'POST', path: '/api/v1/sales/{ref}/approve', scope: 'sales:approve', idempotent: true, summary: 'Approve a sale of stock pledged to you',
    detail: 'Pledged stock leaves the warehouse only through a sale you approve. When the buyer pays, you are paid first, after storage and handling fees.', response: { sale: 'SL-261118-002', approved_items: 1, sale_status: 'approved' } },
  { method: 'GET', path: '/api/v1/alerts', scope: 'alerts:read', summary: 'Your alerts: prices, sales, warehouse conditions', query: [{ name: 'all', desc: '1 to include older, seen alerts' }],
    response: { data: [{ id: '…', kind: 'price_warning', level: 'warn', title: 'LN-FUNDCO-00012 is getting close to its margin call', body: '…', link: '/loans/LN-FUNDCO-00012', created_at: '2026-11-18T06:00:00.000Z', seen_at: null }] } },
  { method: 'GET', path: '/api/v1/issuers', scope: 'issuers:read', summary: 'Receipt issuers and their scorecards',
    response: { data: [{ code: 'AYOG', name: 'Ayo Grains Ltd', status: 'certified', tier: 'B', your_terms: { accepted: true, max_ltv_bp: 6000 }, scorecard: { receipts: 120, live_receipts: 84, live_value_kobo: 9.2e9, guarantee_kobo: 5e8, wareguard_devices: 4, wareguard_reporting: 4, open_stock_checks: 0, loss_kg: 0, loans: { total: 61, repaid: 40, written_off: 0, overdue: 1 } } }] } },
  { method: 'POST', path: '/api/v1/wareguard/devices', scope: 'wareguard:write', summary: 'Titan: add or update a WareGuard device', body: { device_ref: 'WG-0042', warehouse_code: 'WH-OY-ISY-01', label: 'Bay 2, north wall', active: true },
    response: { device_ref: 'WG-0042', warehouse_code: 'WH-OY-ISY-01', active: true } },
  { method: 'POST', path: '/api/v1/wareguard/readings', scope: 'wareguard:write', summary: 'Titan: send readings',
    detail: 'Send one device ({ device_ref, readings }) or many ({ devices: [...] }). Readings already received are ignored, so resending is safe. Each batch is checked against the WareGuard limits in Settings straight away.',
    body: { devices: [{ device_ref: 'WG-0042', readings: [{ at: '2026-11-18T10:00:00Z', temp_c: 27.4, rh_pct: 63.1, door_open: false, battery_pct: 88 }] }] }, response: { stored: 1, unknown_devices: [] } },
];

export const WEBHOOK_EXAMPLE = { id: 'evt_1042', type: 'loan.repayment', created_at: '2026-12-02T09:15:00.000Z', data: { loan_no: 'LN-FUNDCO-00012', amount_kobo: 30000000, on: '2026-12-02', reference: 'RP-77812', outstanding_kobo: 56901000 } };
export const EVENT_HELP: Record<string, string> = {
  'loan_request.created': 'A new loan request is waiting for your decision (data: request_id, batch, product, requested_kobo).',
  'loan.approved': 'A request was approved and the loan created (data: request_id, loan_no).',
  'loan.rejected': 'A request was rejected (data: request_id, note).',
  'loan.disbursed': 'A loan was recorded as paid out (data: loan_no, principal_kobo, on, due_on, reference).',
  'loan.repayment': 'Money came in on a loan, from the farmer or from a sale (data: loan_no, amount_kobo, on, reference, outstanding_kobo).',
  'loan.repaid': 'A loan is fully repaid and its receipts are released (data: loan_no).',
  'sale.proposed': 'A buyer’s offer for stock pledged to you needs your approval (data: sale, buyer, kobo_per_kg, items, owed_kobo, gross_kobo).',
  'sale.approved': 'Everyone agreed; the stock is committed to the sale.',
  'sale.cancelled': 'The sale was cancelled; your pledge is unchanged.',
  'sale.settled': 'The buyer paid; your share was posted to the loan.',
  'alert.created': 'Any alert for you: price warnings, margin calls, warehouse conditions (data: id, kind, level, title, body, link).',
  'test.ping': 'Sent when you press “Send a test event”.',
};

export function openapi() {
  const paths: Record<string, any> = {};
  for (const e of ENDPOINTS) {
    const op: any = {
      summary: e.summary, description: [e.detail, e.scope ? `Needs the \`${e.scope}\` permission.` : null, e.idempotent ? 'Send an Idempotency-Key header to make retries safe.' : null].filter(Boolean).join('\n\n'),
      security: [{ bearer: [] }],
      parameters: [...(e.path.match(/\{(\w+)\}/g) ?? []).map((p) => ({ name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } })),
        ...(e.query ?? []).map((q) => ({ name: q.name, in: 'query', required: false, description: q.desc, schema: { type: 'string' } })),
        ...(e.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }] : [])],
      responses: { 200: { description: 'OK', content: { 'application/json': { example: e.response } } }, 400: { description: 'Not possible as asked; the error says why', content: { 'application/json': { example: { error: 'This request is not waiting for a decision.' } } } },
        401: { description: 'Missing or revoked key' }, 403: { description: 'The key lacks the permission, or the person behind it lost access' }, 404: { description: 'Not found, or not yours' }, 429: { description: 'More than 600 requests a minute' } },
    };
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { example: e.body } } };
    paths[e.path] = { ...(paths[e.path] ?? {}), [e.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'StorageX partner API', version: '1.0.0', description: 'Warehouse receipts, receipt-backed loans, funding allocations, sales and alerts. Amounts are integers in kobo. See /developers for the guide.' },
    servers: [{ url: config.baseUrl.replace(/\/$/, '') }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An API key from StorageX: sxk_…' } } },
    paths,
    'x-webhook-events': Object.fromEntries(EVENTS.map((e) => [e, EVENT_HELP[e] ?? ''])),
    'x-scopes': SCOPES,
  };
}
