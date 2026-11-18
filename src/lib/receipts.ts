// Warehouse receipts (Build 4). A receipt is issued from an accepted delivery, by a Kitovu person who did not
// record that delivery. Its facts are frozen in the database, every change of state is an event in a hash chain,
// and the facts are signed (Ed25519) so a printed QR can be checked by anyone, even offline by partners.
import crypto from 'node:crypto';
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, rateLimit, type Actor } from './auth';
import { can } from './rbac';
import { config } from './config';
import { UserError } from './errors';
import { notifyFarmer as notify } from './notify';
import { getSettings } from './settings';
import { sign, verify, keyId } from './sign';
import { receiptPdfBuffer, valueFromRow } from './receipt-doc';
import { pageOffset } from './registry';
import { clean } from './util';
import { referencePrice } from './valuation';
import { valueKobo } from './money';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';

export interface Receipt {
  id: string; receipt_no: string; verify_token: string; status: string; commodity_code: string; commodity: string; grade: string | null; moisture_pct: string | null;
  bags: number | null; net_weight_kg: string; warehouse_id: string; wh_code: string; wh_name: string; wh_state: string; wh_tier: string; can_back_loans: boolean;
  owner_farmer_id: string | null; farmer_code: string | null; farmer_name: string | null; issued_at: Date | null; closed_at: Date | null; closed_reason: string | null;
  intake_id: string | null; intake_ref: string | null; lot_no: number | null; lots: number | null; signature: string | null; sig_key_id: string | null; issued_by_name: string | null; source: string;
  issue_kobo_per_kg: number | null; issue_value_kobo: number | null; issue_price: any; insurer_name: string | null; policy_number: string | null; cover_to: Date | null;
}

/** The fixed facts that are signed. Changing any of them breaks the signature. */
export const signedFacts = (r: { receipt_no: string; verify_token: string; commodity_code: string; net_weight_kg: string | number; wh_code: string; issued_at: Date | string | null }) =>
  ['SXR1', r.receipt_no, r.verify_token, r.commodity_code, Number(r.net_weight_kg).toFixed(2), r.wh_code, r.issued_at ? new Date(r.issued_at).toISOString() : ''].join('|');

export const verifyUrl = (r: { verify_token: string; signature: string | null }) => `${config.baseUrl.replace(/\/$/, '')}/r/${r.verify_token}${r.signature ? `?s=${r.signature}` : ''}`;

const COLS = `r.id, r.receipt_no, r.verify_token, r.status::text AS status, r.commodity_code, c.name AS commodity, r.grade, r.moisture_pct::text, r.bags, r.net_weight_kg::text,
  r.warehouse_id, w.code AS wh_code, w.name AS wh_name, s.name AS wh_state, w.tier AS wh_tier, w.can_back_loans, r.owner_farmer_id, f.code AS farmer_code, f.full_name AS farmer_name,
  r.issued_at, r.closed_at, r.closed_reason, r.intake_id, i.ref AS intake_ref, r.lot_no, r.lots, r.signature, r.sig_key_id, u.full_name AS issued_by_name, r.source,
  r.issue_kobo_per_kg::float AS issue_kobo_per_kg, r.issue_value_kobo::float AS issue_value_kobo, r.issue_price, ip.insurer_name, ip.policy_number, ip.cover_to`;
const FROM = `FROM receipts r JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id JOIN states s ON s.code=w.state_code
  LEFT JOIN farmers f ON f.id=r.owner_farmer_id LEFT JOIN intakes i ON i.id=r.intake_id LEFT JOIN users u ON u.id=r.issued_by
  LEFT JOIN insurance_policies ip ON ip.id=r.insurance_policy_id`;

/** Who sees which receipt. $1 = actor's org. Lenders: only farmers who consented to them (pledges come in Build 7). */
function scope(a: Actor) {
  const m = a.membership!;
  if (m.org_kind === 'kitovu') return { where: '$1::uuid IS NULL', arg: null };
  if (m.org_kind === 'warehouse_operator') return { where: 'w.operator_org_id = $1', arg: m.org_id };
  if (m.org_kind === 'lender') return { where: `(EXISTS (SELECT 1 FROM farmer_consents fc WHERE fc.farmer_id=r.owner_farmer_id AND fc.org_id=$1 AND fc.withdrawn_at IS NULL) OR EXISTS (SELECT 1 FROM liens li WHERE li.receipt_id=r.id AND li.lender_org_id=$1))`, arg: m.org_id };
  if (m.org_kind === 'field_partner_network' || m.org_kind === 'cooperative')
    return { where: `(EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id=f.registered_by_user AND mm.org_id=$1) OR EXISTS (SELECT 1 FROM field_partners fp WHERE fp.id=f.registered_by_partner AND fp.org_id=$1))`, arg: m.org_id };
  return { where: 'false AND $1::uuid IS NULL', arg: null };
}

export async function listReceipts(a: Actor, q: { status?: string; text?: string; page?: string } = {}) {
  if (!can(a.membership, 'receipts.view')) throw new UserError('Your role cannot see receipts.');
  const sc = scope(a), text = clean(q.text, 60);
  return db.all<Receipt>(`SELECT ${COLS}, count(*) OVER()::int AS total_rows ${FROM} WHERE ${sc.where} AND ($2 = '' OR r.status::text = $2)
      AND ($3 = '' OR r.receipt_no ILIKE '%' || $3 || '%' OR f.full_name ILIKE '%' || $3 || '%' OR f.code = upper($3))
    ORDER BY r.issued_at DESC NULLS LAST, r.receipt_no LIMIT 100 OFFSET $4`, sc.arg, clean(q.status, 30), text, pageOffset(q.page));
}

export async function receiptByNo(a: Actor, no: string) {
  if (!can(a.membership, 'receipts.view')) throw new UserError('Your role cannot see receipts.');
  const sc = scope(a);
  return db.get<Receipt>(`SELECT ${COLS} ${FROM} WHERE r.receipt_no = upper($2) AND ${sc.where}`, sc.arg, clean(no, 40));
}

export const eventsOf = (receiptId: string) => db.all<{ seq: number; event_type: string; occurred_at: Date; actor: string; data: any; hash: string; actor_name: string | null }>(
  `SELECT e.seq, e.event_type, e.occurred_at, e.actor, e.data, e.hash, u.full_name AS actor_name FROM receipt_events e
   LEFT JOIN users u ON e.actor LIKE 'user:%' AND u.id::text = substr(e.actor, 6) WHERE e.receipt_id=$1 ORDER BY e.seq`, receiptId);
export const chainOk = async (receiptId: string) => !!(await db.val<boolean>('SELECT receipt_events_verify($1)', receiptId));

// ---------- issue ----------
export async function issuable(intakeId: string) {
  return db.get<any>(
    `SELECT i.id, i.ref, i.status, i.clerk_user_id, i.net_kg::float AS net, i.bags, i.moisture_pct::float AS moisture, i.grade, i.commodity_code, i.captured_at,
            f.id AS farmer_id, f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, f.status AS farmer_status, f.phone_e164, f.phone_verified_at,
            w.id AS wh_id, w.state_code AS wh_state_code, w.code AS wh_code, w.name AS wh_name, w.status AS wh_status, w.tier AS wh_tier, c.name AS commodity, c.max_moisture_pct::float AS max_moisture,
            (SELECT count(*)::int FROM receipts r WHERE r.intake_id=i.id AND r.status <> 'cancelled') AS live_receipts
     FROM intakes i JOIN farmers f ON f.id=i.farmer_id JOIN warehouses w ON w.id=i.warehouse_id JOIN commodities c ON c.code=i.commodity_code WHERE i.id=$1`, intakeId);
}

/** Reasons a delivery cannot become a receipt yet (empty = ready). */
export function blockers(i: any, a?: Actor) {
  const b: string[] = [];
  if (i.status !== 'accepted') b.push('The delivery has not been accepted.');
  if (i.live_receipts > 0) b.push('Receipts are already issued for this delivery.');
  if (i.farmer_status !== 'active') b.push('The farmer record is not active.');
  if (i.kyc_level < 1) b.push('The farmer’s identity is not checked yet (needs level 1).');
  if (!['certified', 'active'].includes(i.wh_status)) b.push(`The warehouse is ${i.wh_status}; receipts are issued only at certified or active warehouses.`);
  if (i.wh_tier === 'D') b.push('Tier D warehouses are listed only; they cannot issue receipts.');
  if (i.max_moisture && i.moisture > i.max_moisture) b.push(`Moisture ${i.moisture}% is above the ${i.max_moisture}% limit. Dry, re-test and record a new delivery.`);
  if (a && i.clerk_user_id === a.user.id) b.push('You recorded this delivery, so someone else must issue its receipt.');
  return b;
}

/** Split a net weight into lots: either equal parts or the weights given. Bags are shared in proportion. */
export function lotsFor(net: number, bags: number, input: string) {
  const s = clean(input, 200);
  let weights: number[];
  if (!s || /^\d+$/.test(s)) {
    const n = s ? Number(s) : 1;
    if (n < 1 || n > 10) throw new UserError('Split into 1 to 10 receipts.');
    const each = Math.floor((net / n) * 100) / 100;
    weights = Array.from({ length: n }, (_, k) => (k === n - 1 ? Math.round((net - each * (n - 1)) * 100) / 100 : each));
  } else {
    weights = s.split(/[,;\s]+/).filter(Boolean).map(Number);
    if (weights.some((w) => !(w > 0)) || weights.length > 10) throw new UserError('Give up to 10 weights in kg, separated by commas.');
    const sum = Math.round(weights.reduce((x, y) => x + y, 0) * 100) / 100;
    if (Math.abs(sum - net) > 0.01) throw new UserError(`The weights add up to ${sum} kg, but the delivery is ${net} kg.`);
  }
  if (weights.length > bags) throw new UserError('There cannot be more receipts than bags.');
  let left = bags;
  const lots = weights.map((w, k) => {
    const b = k === weights.length - 1 ? left : Math.max(1, Math.round((bags * w) / net));
    left -= b; return { kg: w, bags: b };
  });
  if (lots.some((l) => l.bags < 1)) throw new UserError('Each receipt needs at least one bag. Use fewer or larger lots.');
  return lots;
}

export async function issueFromIntake(a: Actor, intakeId: string, split = '') {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt-issuing rights can issue receipts.');
  return tx(async () => {
    await db.run('SELECT 1 FROM intakes WHERE id=$1 FOR UPDATE', intakeId);   // one issuer at a time per delivery
    const i = await issuable(intakeId);
    if (!i) throw new UserError('Delivery not found.');
    const b = blockers(i, a);
    if (b.length) throw new UserError(b.join(' '));
    const lots = lotsFor(i.net, i.bags, split);
    const now = new Date();
    const ymd = now.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', year: '2-digit', month: '2-digit', day: '2-digit' }).split('/').reverse().join('');
    const parts = String(i.wh_code).split('-');
    const prefix = `SX-${parts[1]}-${parts[2]}-${ymd}-`;
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', prefix);
    let seq = Number(await db.val(`SELECT count(*) FROM receipts WHERE receipt_no LIKE $1 || '%'`, prefix));
    // Value at storage: the reference price on the day of issue is the baseline a lender lends against. It is
    // fixed on the receipt; later prices are daily valuations. No price yet = no value on the receipt.
    const ref = await referencePrice(i.commodity_code, i.wh_state_code, now);
    const basis = ref.kobo_per_kg ? { scope: ref.scope, state: ref.state, from: ref.from, to: ref.to, window_days: ref.window_days, observations: ref.observations.length, markets: [...new Set(ref.observations.map((o) => o.market))].slice(0, 4) } : null;
    const policy = await db.val<string>(`SELECT id FROM insurance_policies WHERE warehouse_id=$1 AND status='active' AND (cover_from IS NULL OR cover_from <= $2::date) AND cover_to >= $2::date ORDER BY cover_to DESC LIMIT 1`,
      i.wh_id, now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }));
    const issued: { no: string; token: string; kg: number; sig: string }[] = [];
    for (let k = 0; k < lots.length; k++) {
      const no = prefix + String(++seq).padStart(4, '0');
      // Token and time are made here so the signature can be stored with the row (its facts are frozen on insert).
      const token = crypto.randomBytes(16).toString('hex');
      const sig = sign(signedFacts({ receipt_no: no, verify_token: token, commodity_code: i.commodity_code, net_weight_kg: lots[k].kg, wh_code: i.wh_code, issued_at: now }));
      const row = (await db.get<{ id: string }>(
        `INSERT INTO receipts (receipt_no, verify_token, depositor_farmer_id, owner_farmer_id, warehouse_id, commodity_code, grade, moisture_pct, bags, net_weight_kg, status, issued_at,
           intake_id, lot_no, lots, issued_by, source, signature, sig_key_id, issue_kobo_per_kg, issue_value_kobo, issue_price, insurance_policy_id, unit_price_kobo, value_kobo)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,'issued',$10,$11,$12,$13,$14,'app',$15,$16,$17,$18,$19,$20,$17,$18) RETURNING id`,
        no, token, i.farmer_id, i.wh_id, i.commodity_code, i.grade, i.moisture, lots[k].bags, lots[k].kg, now, i.id, k + 1, lots.length, a.user.id, sig, keyId(),
        ref.kobo_per_kg, ref.kobo_per_kg ? valueKobo(lots[k].kg, ref.kobo_per_kg) : null, basis ? JSON.stringify(basis) : null, policy ?? null))!;
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'issued',$2,$3,$4)`, row.id, now, `user:${a.user.id}`,
        JSON.stringify({ receipt_no: no, delivery: i.ref, farmer: i.farmer_code, warehouse: i.wh_code, commodity: i.commodity_code, net_kg: lots[k].kg, bags: lots[k].bags, grade: i.grade, moisture_pct: i.moisture, lot: `${k + 1}/${lots.length}`, signature: sig,
          value_at_storage: ref.kobo_per_kg ? { kobo_per_kg: ref.kobo_per_kg, kobo: valueKobo(lots[k].kg, ref.kobo_per_kg) } : null, insurance_policy: policy ?? null }));
      issued.push({ no, token, kg: lots[k].kg, sig });
    }
    await audit(actorOf(a), 'receipt.issued', { entity: 'intake', entityId: i.id, data: { delivery: i.ref, receipts: issued.map((x) => x.no) } });
    return { receipts: issued, farmer: i, commodity: i.commodity };
  });
}

export async function notifyIssued(r: Awaited<ReturnType<typeof issueFromIntake>>) {
  const f = r.farmer;
  const list = r.receipts.map((x) => `${x.no} (${x.kg.toLocaleString('en-NG')} kg)`).join(', ');
  await notify(f.farmer_id, 'receipt_issued', r.receipts[0].no, { receipts: list, crop: r.commodity, warehouse: f.wh_name, link: verifyUrl({ verify_token: r.receipts[0].token, signature: null }) });
}

export async function cancelReceipt(a: Actor, no: string, reason: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt-issuing rights can cancel receipts.');
  const r = await receiptByNo(a, no);
  if (!r) throw new UserError('Receipt not found.');
  if (r.status !== 'issued') throw new UserError(`Only an issued receipt with no lien or sale can be cancelled (this one is ${r.status}).`);
  const issuedBy = await db.val<string>('SELECT issued_by FROM receipts WHERE id=$1', r.id);
  if (issuedBy === a.user.id) throw new UserError('You issued this receipt, so someone else must cancel it.');
  if (await db.val(`SELECT 1 FROM releases WHERE receipt_id=$1 AND status <> 'cancelled'`, r.id)) throw new UserError('Stock has been ordered out on this receipt. Cancel the release first.');
  const why = clean(reason, 300);
  if (why.length < 10) throw new UserError('Explain the reason in a sentence (it appears on the public record as “cancelled”, the reason stays internal).');
  await tx(async () => {
    await db.run(`UPDATE receipts SET status='cancelled', closed_at=now(), closed_reason=$2, distribution_enabled=false WHERE id=$1`, r.id, why);
    await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'cancelled',now(),$2,$3)`, r.id, `user:${a.user.id}`, JSON.stringify({ reason: why }));
    await audit(actorOf(a), 'receipt.cancelled', { entity: 'receipt', entityId: r.id, data: { receipt_no: r.receipt_no, reason: why } });
  });
}

// ---------- public Receipt Passport ----------
export const PUBLIC_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad'; note: string }> = {
  issued: { label: 'Valid', tone: 'ok', note: 'The produce is in the warehouse and the receipt is not pledged or sold.' },
  pledged: { label: 'Valid — pledged to a lender', tone: 'warn', note: 'The receipt backs a loan and cannot be pledged again. The produce can leave only through a sale the lender approves, or after the loan is repaid; the lender is paid first.' },
  financed: { label: 'Valid — financed', tone: 'warn', note: 'The receipt backs a loan and cannot be pledged again. The produce can leave only through a sale the lender approves, or after the loan is repaid; the lender is paid first.' },
  sale_approved: { label: 'Being sold', tone: 'warn', note: 'A sale is in progress.' },
  partially_released: { label: 'Partly withdrawn', tone: 'warn', note: 'Some of the produce has left the warehouse.' },
  under_exception: { label: 'Under review', tone: 'bad', note: 'Kitovu is investigating this receipt. Do not rely on it until resolved.' },
  settled: { label: 'Closed — settled', tone: 'bad', note: 'The produce was sold and the receipt is closed.' },
  closed: { label: 'Closed', tone: 'bad', note: 'The receipt is closed; the produce is no longer held against it.' },
  cancelled: { label: 'Cancelled', tone: 'bad', note: 'This receipt was cancelled and is not valid.' },
  expired: { label: 'Expired', tone: 'bad', note: 'This receipt has expired.' },
};
export const EVENT_LABEL: Record<string, string> = { issued: 'Issued', cancelled: 'Cancelled', released: 'Part withdrawn', pledged: 'Pledged to a lender', financed: 'Loan paid out', lien_released: 'Pledge released', sale_approved: 'Sale agreed', sale_cancelled: 'Sale cancelled', settled: 'Sold and settled', review_started: 'Put under review', review_ended: 'Review ended', legacy_issued: 'Issued (old system)', legacy_closed: 'Closed (old system)', liquidated: 'Liquidated', closed: 'Closed' };

export async function passport(token: string, sig: string | undefined, ip: string) {
  if (!(await rateLimit(`passport:${ip}`, 120, 600))) throw new UserError('Too many checks from this network. Wait a few minutes.');
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const r = await db.get<Receipt>(`SELECT ${COLS} ${FROM} WHERE r.verify_token=$1`, token);
  if (!r) return null;
  const events = await db.all<{ seq: number; event_type: string; occurred_at: Date }>('SELECT seq, event_type, occurred_at FROM receipt_events WHERE receipt_id=$1 ORDER BY seq', r.id);
  const insured = !!(await db.val(`SELECT 1 FROM insurance_policies WHERE warehouse_id=$1 AND status='active' AND current_date BETWEEN cover_from AND cover_to`, r.warehouse_id));
  const facts = signedFacts(r);
  const storedSigOk = !!r.signature && verify(facts, r.signature);
  const qrSig = sig ? (verify(facts, sig) ? 'match' : 'mismatch') : 'absent';
  const held = await db.val<string>('SELECT remaining_kg FROM receipt_balances WHERE receipt_id=$1', r.id);
  const initials = r.farmer_name ? r.farmer_name.split(/\s+/).map((w) => w[0]?.toUpperCase() + '.').join(' ') : null;
  const today = await db.get<{ market_value_kobo: string; kobo_per_kg: string; valued_on: Date }>(`SELECT market_value_kobo, kobo_per_kg, valued_on FROM receipt_valuations
    WHERE receipt_id=$1 AND kobo_per_kg IS NOT NULL ORDER BY valued_on DESC LIMIT 1`, r.id);
  return {
    receipt_no: r.receipt_no, status: r.status, view: PUBLIC_STATUS[r.status] ?? { label: r.status, tone: 'warn' as const, note: '' },
    held_kg: ['closed', 'settled', 'cancelled', 'expired'].includes(r.status) ? 0 : Number(held ?? r.net_weight_kg),
    commodity: r.commodity, grade: r.grade, moisture: r.moisture_pct, bags: r.bags, net_kg: Number(r.net_weight_kg), issued_at: r.issued_at, closed_at: r.closed_at,
    warehouse: `${r.wh_name}, ${r.wh_state} State`, wh_code: r.wh_code, tier: r.wh_tier, can_back_loans: r.can_back_loans, insured,
    owner: r.farmer_code ? `${initials} (${r.farmer_code})` : 'Organisation', lot: r.lots && r.lots > 1 ? `${r.lot_no} of ${r.lots}` : null,
    events: events.map((e) => ({ label: EVENT_LABEL[e.event_type] ?? e.event_type.replace(/_/g, ' '), at: e.occurred_at })),
    chain_ok: await chainOk(r.id), signature_ok: storedSigOk || r.source !== 'app', legacy: r.source !== 'app', qr_sig: qrSig, checked_at: new Date(), key_id: r.sig_key_id,
    value_at_storage: r.issue_value_kobo != null ? { kobo: Number(r.issue_value_kobo), per_kg: Number(r.issue_kobo_per_kg) } : null,
    value_today: today && !['closed', 'settled', 'cancelled', 'expired'].includes(r.status) ? { kobo: Number(today.market_value_kobo), per_kg: Number(today.kobo_per_kg), on: today.valued_on } : null,
    insurance: r.insurer_name ? `${r.insurer_name}${r.policy_number ? `, policy ${r.policy_number}` : ''}${r.cover_to ? `, cover to ${new Date(r.cover_to).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` : null,
  };
}

// ---------- printable PDF ----------
export async function receiptPdf(a: Actor, no: string) {
  const r = await receiptByNo(a, no);
  if (!r) throw new UserError('Receipt not found.');
  const extra = await db.get<{ insured: boolean; clerk: string | null }>(`SELECT
      EXISTS (SELECT 1 FROM insurance_policies p WHERE p.warehouse_id=$1 AND p.status='active' AND (p.cover_from IS NULL OR p.cover_from <= current_date) AND p.cover_to >= current_date) AS insured,
      (SELECT u.full_name FROM intakes i JOIN users u ON u.id=i.clerk_user_id WHERE i.id=$2) AS clerk`, r.warehouse_id, r.intake_id);
  const pdf = receiptPdfBuffer({
    receipt_no: r.receipt_no, status: r.status, status_label: PUBLIC_STATUS[r.status]?.label ?? r.status,
    commodity: r.commodity, grade: r.grade, net_kg: Number(r.net_weight_kg), bags: r.bags, moisture: r.moisture_pct != null ? Number(r.moisture_pct) : null,
    warehouse: r.wh_name, wh_code: r.wh_code, wh_state: r.wh_state, wh_tier: r.wh_tier, insured: !!extra?.insured,
    depositor: r.farmer_name ?? '—', depositor_code: r.farmer_code ?? '—', issued_at: r.issued_at ?? new Date(),
    intake_ref: r.intake_ref, lot: r.lots && r.lots > 1 ? `receipt ${r.lot_no} of ${r.lots}` : null,
    issued_by: r.issued_by_name, received_by: extra?.clerk ?? null, url: verifyUrl(r), key_id: r.sig_key_id, signature: r.signature,
    value: valueFromRow(r), insurance: r.insurer_name ? { insurer: r.insurer_name, policy_no: r.policy_number, cover_to: r.cover_to } : null,
  });
  await audit(actorOf(a), 'receipt.printed', { entity: 'receipt', entityId: r.id, data: { receipt_no: r.receipt_no } });
  return { pdf, name: `${r.receipt_no}.pdf` };
}
