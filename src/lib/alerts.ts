// Alerts for lenders and Kitovu: prices closing in on a loan's limits, sales of pledged stock, and warehouse
// conditions from WareGuard. Each alert is raised once per key, so the jobs that raise them can run again safely.
// Kitovu (org_id NULL) gets a copy of everything a lender gets. Texts go only when switched on in Settings and
// only to staff who have a phone number on their account.
import { emit } from './webhooks';
import { db } from './db';
import { audit, systemActor } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { getSettings } from './settings';
import { sendSms } from './sms';
import { fmtNGN } from './money';
import { position, entriesOf } from './finance';
import { referencePrice } from './valuation';

export type AlertKind = 'price_warning' | 'margin_call' | 'liquidation' | 'price_drop' | 'sale_proposed' | 'sale_approved' | 'sale_cancelled' | 'sale_settled' | 'warehouse_condition' | 'warehouse_offline' | 'storage_term';
export type Level = 'info' | 'warn' | 'urgent';
export const KIND_LABEL: Record<AlertKind, string> = {
  price_warning: 'Price warning', margin_call: 'Margin call', liquidation: 'Liquidation level', price_drop: 'Price fall',
  sale_proposed: 'Sale offer', sale_approved: 'Sale agreed', sale_cancelled: 'Sale cancelled', sale_settled: 'Sale paid out',
  warehouse_condition: 'Warehouse conditions', warehouse_offline: 'WareGuard offline',
};

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;

/** Raise an alert for an organisation (and a copy for Kitovu). Returns true if it is new. Never throws. */
export async function raise(orgId: string | null, a: { kind: AlertKind; level: Level; title: string; body: string; link?: string; key: string }) {
  try {
    const targets = orgId ? [orgId, null] : [null];
    let fresh = false;
    for (const org of targets) {
      const id = await db.val<string>(`INSERT INTO alerts (org_id, kind, level, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        org, a.kind, a.level, a.title, a.body, a.link ?? null, a.key);
      if (!id) continue;
      fresh = true;
      if (org) await emit(org, 'alert.created', { id, kind: a.kind, level: a.level, title: a.title, body: a.body, link: a.link ?? null }, a.key);
      if (a.level !== 'info') await textStaff(org, `StorageX: ${a.title}. ${a.body}`.slice(0, 300));
    }
    return fresh;
  } catch (e) { console.error('[alerts]', a.kind, a.key, e); return false; }
}

async function textStaff(orgId: string | null, text: string) {
  const s = await getSettings();
  if (!s['alerts.sms']) return;
  const phones = await db.all<{ phone_e164: string }>(`SELECT DISTINCT u.phone_e164 FROM users u JOIN memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.org_id
    WHERE u.status='active' AND u.phone_e164 IS NOT NULL AND ${orgId ? 'm.org_id=$1' : `o.kind='kitovu' AND $1::uuid IS NULL`} AND m.role IN ('super_admin','ops_manager','finance','lender_admin','credit_officer')`, orgId);
  for (const p of phones) await sendSms(p.phone_e164, text);
}

function alertOrg(a: Actor) {
  if (!can(a.membership, 'finance.view') && !can(a.membership, 'warehouses.view')) throw new UserError('Alerts are for lenders, warehouses and Kitovu.');
  return a.membership!.org_kind === 'kitovu' ? null : a.membership!.org_id;
}

export async function alertsFor(a: Actor, q: { all?: string } = {}) {
  const org = alertOrg(a);
  return db.all<any>(`SELECT al.*, u.full_name AS seen_name FROM alerts al LEFT JOIN users u ON u.id=al.seen_by
    WHERE ${org ? 'al.org_id=$1' : 'al.org_id IS NULL AND $1::uuid IS NULL'} AND ($2 OR al.seen_at IS NULL OR al.created_at > now() - interval '14 days')
    ORDER BY (al.seen_at IS NULL) DESC, al.created_at DESC LIMIT 200`, org, q.all === '1');
}
export async function unseenCount(a: Actor) {
  if (!a.membership || !(can(a.membership, 'finance.view') || can(a.membership, 'warehouses.view'))) return 0;
  const org = a.membership.org_kind === 'kitovu' ? null : a.membership.org_id;
  return Number(await db.val(`SELECT count(*) FROM alerts WHERE ${org ? 'org_id=$1' : 'org_id IS NULL AND $1::uuid IS NULL'} AND seen_at IS NULL`, org));
}
export async function markSeen(a: Actor, id: string | 'all') {
  const org = alertOrg(a);
  const n = await db.run(`UPDATE alerts SET seen_by=$2, seen_at=now() WHERE seen_at IS NULL AND ${org ? 'org_id=$1' : 'org_id IS NULL AND $1::uuid IS NULL'} AND ($3 = 'all' OR id::text=$3)`, org, a.user.id, id);
  await audit(actorOf(a), 'alerts.seen', { data: { id, count: n } });
  return n;
}

// ---------- price watch (daily, after valuation) ----------
const week = (d = new Date()) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}W${Math.ceil(((t.getTime() - y.getTime()) / 86_400_000 + 1) / 7)}`; };

/** Every running loan against the value of its stock today. Warns before the margin call, not after. */
export async function priceWatch(today = new Date()) {
  const s = await getSettings();
  const gap = s['alerts.ltv_warning_gap_pct'] * 100;
  const ls = await db.all<any>(`SELECT ln.*, p.margin_call_ltv_bp, p.liquidation_ltv_bp, f.full_name AS farmer_name, o.name AS lender FROM loans ln JOIN loan_products p ON p.id=ln.product_id
    JOIN farmers f ON f.id=ln.farmer_id JOIN organisations o ON o.id=ln.lender_org_id WHERE ln.status='disbursed'`);
  const prices = new Map<string, number | null>();
  let raised = 0;
  for (const ln of ls) {
    const rs = await db.all<any>(`SELECT r.receipt_no, r.commodity_code, w.state_code, b.remaining_kg::float AS kg, c.name AS crop FROM liens li JOIN receipts r ON r.id=li.receipt_id
      JOIN receipt_balances b ON b.receipt_id=r.id JOIN warehouses w ON w.id=r.warehouse_id JOIN commodities c ON c.code=r.commodity_code WHERE li.loan_id=$1 AND li.released_at IS NULL`, ln.id);
    let value = 0, priced = true;
    for (const r of rs) {
      const k = `${r.commodity_code}:${r.state_code}`;
      if (!prices.has(k)) prices.set(k, (await referencePrice(r.commodity_code, r.state_code, today)).kobo_per_kg);
      const p = prices.get(k);
      if (p == null) { priced = false; break; }
      value += r.kg * p;
    }
    if (!priced || !value) continue;
    const owed = position(ln, await entriesOf(ln.id), today).outstanding;
    if (owed <= 0) continue;
    const ltv = Math.round((owed / value) * 10_000);
    const crops = [...new Set(rs.map((r) => r.crop))].join(' and ');
    const base = { link: `/loans/${ln.loan_no}` };
    const facts = `${ln.farmer_name} owes ${N(owed)} against ${crops} now worth ${N(value)}: ${pct(ltv)} of its value.`;
    let a: Parameters<typeof raise>[1] | null = null;
    if (ltv >= ln.liquidation_ltv_bp) a = { ...base, kind: 'liquidation', level: 'urgent', title: `${ln.loan_no} is at its liquidation level`, body: `${facts} The limit is ${pct(ln.liquidation_ltv_bp)}. Ask Kitovu to arrange a sale, or ask the farmer to repay now.`, key: `liq:${ln.loan_no}:${week(today)}` };
    else if (ltv >= ln.margin_call_ltv_bp) a = { ...base, kind: 'margin_call', level: 'urgent', title: `${ln.loan_no} has reached its margin call`, body: `${facts} The margin call is ${pct(ln.margin_call_ltv_bp)}. Ask the farmer for a part repayment or more stock, or plan a sale.`, key: `mc:${ln.loan_no}:${week(today)}` };
    else if (ltv >= ln.margin_call_ltv_bp - gap) a = { ...base, kind: 'price_warning', level: 'warn', title: `${ln.loan_no} is getting close to its margin call`, body: `${facts} The margin call is at ${pct(ln.margin_call_ltv_bp)}. Nothing to do yet; watch the price, and consider a sale if it keeps falling.`, key: `pw:${ln.loan_no}:${week(today)}` };
    if (a && await raise(ln.lender_org_id, a)) raised++;
  }
  await audit(systemActor('price-watch'), 'alerts.price_watch', { data: { loans: ls.length, raised } });
  return { loans: ls.length, raised };
}

/** Price falls found by the daily valuation, as alerts to the lenders holding those receipts. */
export async function alertPriceDrops(drops: { receipt_no: string; change_pct: number }[], day: string) {
  for (const d of drops) {
    const l = await db.get<any>(`SELECT li.lender_org_id, ln.loan_no, c.name AS crop FROM receipts r JOIN liens li ON li.receipt_id=r.id AND li.released_at IS NULL JOIN loans ln ON ln.id=li.loan_id
      JOIN commodities c ON c.code=r.commodity_code WHERE r.receipt_no=$1`, d.receipt_no);
    if (!l) continue;
    await raise(l.lender_org_id, { kind: 'price_drop', level: 'warn', title: `${l.crop} price fell ${Math.abs(d.change_pct).toFixed(1)}%`, link: `/receipts/${d.receipt_no}`,
      body: `The reference price behind receipt ${d.receipt_no} (loan ${l.loan_no}) fell ${Math.abs(d.change_pct).toFixed(1)}% since its last valuation.`, key: `drop:${d.receipt_no}:${day}` });
  }
}
