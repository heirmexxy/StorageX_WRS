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
import { sendSms } from './sms';
import { getSettings } from './settings';
import { sign, verify, keyId } from './sign';
import { Pdf } from './pdf';
import { clean } from './util';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';

export interface Receipt {
  id: string; receipt_no: string; verify_token: string; status: string; commodity_code: string; commodity: string; grade: string | null; moisture_pct: string | null;
  bags: number | null; net_weight_kg: string; warehouse_id: string; wh_code: string; wh_name: string; wh_state: string; wh_tier: string; can_back_loans: boolean;
  owner_farmer_id: string | null; farmer_code: string | null; farmer_name: string | null; issued_at: Date | null; closed_at: Date | null; closed_reason: string | null;
  intake_id: string | null; intake_ref: string | null; lot_no: number | null; lots: number | null; signature: string | null; sig_key_id: string | null; issued_by_name: string | null; source: string;
}

/** The fixed facts that are signed. Changing any of them breaks the signature. */
export const signedFacts = (r: { receipt_no: string; verify_token: string; commodity_code: string; net_weight_kg: string | number; wh_code: string; issued_at: Date | string | null }) =>
  ['SXR1', r.receipt_no, r.verify_token, r.commodity_code, Number(r.net_weight_kg).toFixed(2), r.wh_code, r.issued_at ? new Date(r.issued_at).toISOString() : ''].join('|');

export const verifyUrl = (r: { verify_token: string; signature: string | null }) => `${config.baseUrl.replace(/\/$/, '')}/r/${r.verify_token}${r.signature ? `?s=${r.signature}` : ''}`;

const COLS = `r.id, r.receipt_no, r.verify_token, r.status::text AS status, r.commodity_code, c.name AS commodity, r.grade, r.moisture_pct::text, r.bags, r.net_weight_kg::text,
  r.warehouse_id, w.code AS wh_code, w.name AS wh_name, s.name AS wh_state, w.tier AS wh_tier, w.can_back_loans, r.owner_farmer_id, f.code AS farmer_code, f.full_name AS farmer_name,
  r.issued_at, r.closed_at, r.closed_reason, r.intake_id, i.ref AS intake_ref, r.lot_no, r.lots, r.signature, r.sig_key_id, u.full_name AS issued_by_name, r.source`;
const FROM = `FROM receipts r JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id JOIN states s ON s.code=w.state_code
  LEFT JOIN farmers f ON f.id=r.owner_farmer_id LEFT JOIN intakes i ON i.id=r.intake_id LEFT JOIN users u ON u.id=r.issued_by`;

/** Who sees which receipt. $1 = actor's org. Lenders: only farmers who consented to them (pledges come in Build 7). */
function scope(a: Actor) {
  const m = a.membership!;
  if (m.org_kind === 'kitovu') return { where: '$1::uuid IS NULL', arg: null };
  if (m.org_kind === 'warehouse_operator') return { where: 'w.operator_org_id = $1', arg: m.org_id };
  if (m.org_kind === 'lender') return { where: `EXISTS (SELECT 1 FROM farmer_consents fc WHERE fc.farmer_id=r.owner_farmer_id AND fc.org_id=$1 AND fc.withdrawn_at IS NULL)`, arg: m.org_id };
  if (m.org_kind === 'field_partner_network' || m.org_kind === 'cooperative')
    return { where: `(EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id=f.registered_by_user AND mm.org_id=$1) OR EXISTS (SELECT 1 FROM field_partners fp WHERE fp.id=f.registered_by_partner AND fp.org_id=$1))`, arg: m.org_id };
  return { where: 'false AND $1::uuid IS NULL', arg: null };
}

export async function listReceipts(a: Actor, q: { status?: string; text?: string } = {}) {
  if (!can(a.membership, 'receipts.view')) throw new UserError('Your role cannot see receipts.');
  const sc = scope(a), text = clean(q.text, 60);
  return db.all<Receipt>(`SELECT ${COLS} ${FROM} WHERE ${sc.where} AND ($2 = '' OR r.status::text = $2)
      AND ($3 = '' OR r.receipt_no ILIKE '%' || $3 || '%' OR f.full_name ILIKE '%' || $3 || '%' OR f.code = upper($3))
    ORDER BY r.issued_at DESC NULLS LAST LIMIT 300`, sc.arg, clean(q.status, 30), text);
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
            w.id AS wh_id, w.code AS wh_code, w.name AS wh_name, w.status AS wh_status, w.tier AS wh_tier, c.name AS commodity, c.max_moisture_pct::float AS max_moisture,
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
    const issued: { no: string; token: string; kg: number; sig: string }[] = [];
    for (let k = 0; k < lots.length; k++) {
      const no = prefix + String(++seq).padStart(4, '0');
      // Token and time are made here so the signature can be stored with the row (its facts are frozen on insert).
      const token = crypto.randomBytes(16).toString('hex');
      const sig = sign(signedFacts({ receipt_no: no, verify_token: token, commodity_code: i.commodity_code, net_weight_kg: lots[k].kg, wh_code: i.wh_code, issued_at: now }));
      const row = (await db.get<{ id: string }>(
        `INSERT INTO receipts (receipt_no, verify_token, depositor_farmer_id, owner_farmer_id, warehouse_id, commodity_code, grade, moisture_pct, bags, net_weight_kg, status, issued_at,
           intake_id, lot_no, lots, issued_by, source, signature, sig_key_id)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,'issued',$10,$11,$12,$13,$14,'app',$15,$16) RETURNING id`,
        no, token, i.farmer_id, i.wh_id, i.commodity_code, i.grade, i.moisture, lots[k].bags, lots[k].kg, now, i.id, k + 1, lots.length, a.user.id, sig, keyId()))!;
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'issued',$2,$3,$4)`, row.id, now, `user:${a.user.id}`,
        JSON.stringify({ receipt_no: no, delivery: i.ref, farmer: i.farmer_code, warehouse: i.wh_code, commodity: i.commodity_code, net_kg: lots[k].kg, bags: lots[k].bags, grade: i.grade, moisture_pct: i.moisture, lot: `${k + 1}/${lots.length}`, signature: sig }));
      issued.push({ no, token, kg: lots[k].kg, sig });
    }
    await audit(actorOf(a), 'receipt.issued', { entity: 'intake', entityId: i.id, data: { delivery: i.ref, receipts: issued.map((x) => x.no) } });
    return { receipts: issued, farmer: i, commodity: i.commodity };
  });
}

export async function notifyIssued(r: Awaited<ReturnType<typeof issueFromIntake>>) {
  const f = r.farmer;
  if (!f.phone_e164 || !f.phone_verified_at || !(await getSettings())['phone_check.sms']) return;
  const list = r.receipts.map((x) => `${x.no} (${x.kg.toLocaleString('en-NG')} kg)`).join(', ');
  await sendSms(f.phone_e164, `StorageX: receipt ${list} issued for your ${r.commodity} at ${f.wh_name}. Check any time: ${verifyUrl({ verify_token: r.receipts[0].token, signature: null })}`).catch(() => null);
}

export async function cancelReceipt(a: Actor, no: string, reason: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt-issuing rights can cancel receipts.');
  const r = await receiptByNo(a, no);
  if (!r) throw new UserError('Receipt not found.');
  if (r.status !== 'issued') throw new UserError(`Only an issued receipt with no lien or sale can be cancelled (this one is ${r.status}).`);
  const issuedBy = await db.val<string>('SELECT issued_by FROM receipts WHERE id=$1', r.id);
  if (issuedBy === a.user.id) throw new UserError('You issued this receipt, so someone else must cancel it.');
  const why = clean(reason, 300);
  if (why.length < 10) throw new UserError('Explain the reason in a sentence (it appears on the public record as “cancelled”, the reason stays internal).');
  await tx(async () => {
    await db.run(`UPDATE receipts SET status='cancelled', closed_at=now(), closed_reason=$2, distribution_enabled=false WHERE id=$1`, r.id, why);
    await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'cancelled',now(),$2,$3)`, r.id, `user:${a.user.id}`, JSON.stringify({ reason: why }));
    await audit(actorOf(a), 'receipt.cancelled', { entity: 'receipt', entityId: r.id, data: { receipt_no: r.receipt_no, reason: why } });
  });
}

// ---------- public Receipt Passport ----------
const PUBLIC_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad'; note: string }> = {
  issued: { label: 'Valid', tone: 'ok', note: 'The produce is in the warehouse and the receipt is not pledged or sold.' },
  pledged: { label: 'Valid — pledged to a lender', tone: 'warn', note: 'The receipt backs a loan. It cannot be sold or pledged again until released.' },
  financed: { label: 'Valid — financed', tone: 'warn', note: 'The receipt backs a loan. It cannot be sold or pledged again until released.' },
  sale_approved: { label: 'Being sold', tone: 'warn', note: 'A sale is in progress.' },
  partially_released: { label: 'Partly withdrawn', tone: 'warn', note: 'Some of the produce has left the warehouse.' },
  under_exception: { label: 'Under review', tone: 'bad', note: 'Kitovu is investigating this receipt. Do not rely on it until resolved.' },
  settled: { label: 'Closed — settled', tone: 'bad', note: 'The produce was sold and the receipt is closed.' },
  closed: { label: 'Closed', tone: 'bad', note: 'The receipt is closed; the produce is no longer held against it.' },
  cancelled: { label: 'Cancelled', tone: 'bad', note: 'This receipt was cancelled and is not valid.' },
  expired: { label: 'Expired', tone: 'bad', note: 'This receipt has expired.' },
};
export const EVENT_LABEL: Record<string, string> = { issued: 'Issued', cancelled: 'Cancelled', legacy_issued: 'Issued (old system)', legacy_closed: 'Closed (old system)', liquidated: 'Liquidated', closed: 'Closed' };

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
  const initials = r.farmer_name ? r.farmer_name.split(/\s+/).map((w) => w[0]?.toUpperCase() + '.').join(' ') : null;
  return {
    receipt_no: r.receipt_no, status: r.status, view: PUBLIC_STATUS[r.status] ?? { label: r.status, tone: 'warn' as const, note: '' },
    commodity: r.commodity, grade: r.grade, moisture: r.moisture_pct, bags: r.bags, net_kg: Number(r.net_weight_kg), issued_at: r.issued_at, closed_at: r.closed_at,
    warehouse: `${r.wh_name}, ${r.wh_state} State`, wh_code: r.wh_code, tier: r.wh_tier, can_back_loans: r.can_back_loans, insured,
    owner: r.farmer_code ? `${initials} (${r.farmer_code})` : 'Organisation', lot: r.lots && r.lots > 1 ? `${r.lot_no} of ${r.lots}` : null,
    events: events.map((e) => ({ label: EVENT_LABEL[e.event_type] ?? e.event_type.replace(/_/g, ' '), at: e.occurred_at })),
    chain_ok: await chainOk(r.id), signature_ok: storedSigOk || r.source !== 'app', legacy: r.source !== 'app', qr_sig: qrSig, checked_at: new Date(), key_id: r.sig_key_id,
  };
}

// ---------- printable PDF ----------
export async function receiptPdf(a: Actor, no: string) {
  const r = await receiptByNo(a, no);
  if (!r) throw new UserError('Receipt not found.');
  const p = new Pdf(), L = 48, R = p.w - 48;
  p.box(0, 0, p.w, 70, { fill: 0.12 });
  p.text(L, 32, 'StorageX by Kitovu', { size: 16, bold: true, gray: 1 });
  p.text(L, 52, 'Electronic warehouse receipt - printed copy', { size: 10, gray: 0.85 });
  p.text(L, 110, r.receipt_no, { size: 22, bold: true });
  p.text(L, 132, `Status when printed: ${(PUBLIC_STATUS[r.status]?.label ?? r.status).toUpperCase()}`, { size: 11, bold: true, gray: r.status === 'issued' ? 0 : 0.35 });
  const rows: [string, string][] = [
    ['Commodity', `${r.commodity}${r.grade ? `, grade ${r.grade}` : ''}`],
    ['Net weight', `${Number(r.net_weight_kg).toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg${r.bags ? ` in ${r.bags} bags` : ''}`],
    ['Moisture at intake', r.moisture_pct ? `${Number(r.moisture_pct)}%` : '-'],
    ['Warehouse', `${r.wh_name} (${r.wh_code}), ${r.wh_state} State, tier ${r.wh_tier}`],
    ['Depositor and owner', r.farmer_name ? `${r.farmer_name} (${r.farmer_code})` : '-'],
    ['Issued', r.issued_at ? new Date(r.issued_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }) + ' WAT' : '-'],
    ['From delivery', `${r.intake_ref ?? '-'}${r.lots && r.lots > 1 ? `, receipt ${r.lot_no} of ${r.lots}` : ''}`],
    ['Issued by', r.issued_by_name ?? '-'],
  ];
  let y = 170;
  for (const [k, v] of rows) { p.text(L, y, k, { size: 9, gray: 0.4 }); const end = p.wrap(L + 120, y, v, 190, { size: 11 }); const ny = Math.max(y + 28, end + 10); p.line(L, ny - 19, L + 330, ny - 19, { gray: 0.85 }); y = ny; }
  const url = verifyUrl(r);
  p.qr(R - 140, 160, 140, url);
  p.wrap(R - 140, 320, 'Scan to see the live status. Check it before lending, buying or releasing stock.', 140, { size: 8, gray: 0.3 });
  y += 10;
  p.box(L, y, R - L, 92, { stroke: 0.6 });
  y = p.wrap(L + 12, y + 18, 'This paper is a copy. The receipt is the record held by StorageX at the address below. Its status may have changed since printing: a receipt can be pledged, sold, partly withdrawn or cancelled. Rely only on the live record.', R - L - 24, { size: 9 });
  p.text(L + 12, y + 6, url.length > 95 ? url.slice(0, 95) + '...' : url, { size: 7, gray: 0.3 });
  p.text(L, 790, `Signed by StorageX (key ${r.sig_key_id ?? '-'}). Signature: ${(r.signature ?? '').slice(0, 44)}...`, { size: 7, gray: 0.45 });
  p.text(L, 804, 'Kitovu Technology Company Limited', { size: 7, gray: 0.45 });
  await audit(actorOf(a), 'receipt.printed', { entity: 'receipt', entityId: r.id, data: { receipt_no: r.receipt_no } });
  return { pdf: p.toBuffer({ title: r.receipt_no }), name: `${r.receipt_no}.pdf` };
}
