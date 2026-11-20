// Money through Paystack: paying farmers their share of a sale, and buyers paying for a sale by link.
//   Payouts: Kitovu finance saves the farmer's bank account once (Paystack resolves the name; StorageX keeps the
//   recipient code, bank name and last four digits, never the account number). After a sale is settled, one
//   person asks for the payout and a different person approves it, which sends the transfer. Paystack's webhook
//   then marks the farmer's line paid, or failed.
//   Buyer links: Kitovu finance makes a payment link for what a sale still owes. When the buyer pays, Paystack's
//   webhook records the payment and matches it to the sale, ready for settlement.
import crypto from 'node:crypto';
import { db, tx } from './db';
import { config } from './config';
import { audit, systemActor } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { clean } from './util';
import { farmerByCode } from './registry';
import { compareNames } from './identity';
import { saleMoney } from './settlement';

export const connected = () => !!config.paystackSecret;
type Send = (url: string, init: any) => Promise<{ status: number; json(): Promise<any> }>;
let send: Send = fetch as any;
/** Tests replace the network. */
export const setTransport = (s: Send) => { send = s; };

async function ps(path: string, method = 'GET', body?: unknown) {
  if (!connected()) throw new UserError('Paystack is not connected yet (see Settings → Connections).');
  const r = await send(`${config.paystackBase.replace(/\/$/, '')}${path}`, {
    method, signal: AbortSignal.timeout(20_000), body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${config.paystackSecret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400 || j?.status === false) throw new UserError(`Paystack: ${j?.message ?? `error ${r.status}`}`);
  return j.data;
}
const needFin = (a: Actor) => { if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'finance.approve')) throw new UserError('Only Kitovu finance handles payouts and payment links.'); };
const systemUser = async () => (await db.val<string>(`SELECT id FROM users WHERE email='system@storagex.invalid'`))!;

let banksCache: { at: number; list: { name: string; code: string }[] } | null = null;
export async function banks() {
  if (banksCache && Date.now() - banksCache.at < 86_400_000) return banksCache.list;
  const d = await ps('/bank?country=nigeria&perPage=100');
  banksCache = { at: Date.now(), list: (d ?? []).map((b: any) => ({ name: b.name, code: b.code })) };
  return banksCache.list;
}

// ---------- recipients ----------
export async function saveRecipient(a: Actor, farmerCode: string, i: { bank_code?: string; account_number?: string; override_note?: string }) {
  needFin(a);
  const f = await farmerByCode(a, farmerCode);
  if (!f) throw new UserError('Farmer not found.');
  const acct = String(i.account_number ?? '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(acct)) throw new UserError('A Nigerian bank account number has 10 digits.');
  const bank = (await banks()).find((b) => b.code === String(i.bank_code));
  if (!bank) throw new UserError('Choose the bank.');
  const resolved = await ps(`/bank/resolve?account_number=${acct}&bank_code=${bank.code}`);
  const name = String(resolved?.account_name ?? '');
  const parts = name.split(/\s+/);
  let match = compareNames(f.full_name, { first: parts.slice(1).join(' '), last: parts[0] });
  if (match !== 'match') match = compareNames(f.full_name, { first: parts[0], last: parts.slice(1).join(' ') });
  const note = clean(i.override_note, 200);
  if (match !== 'match' && match !== 'partial' && note.length < 10) throw new UserError(`The bank holds this account as “${name}”, which does not match ${f.full_name}. Check with the farmer; to use it anyway, explain why in the note.`);
  const rec = await ps('/transferrecipient', 'POST', { type: 'nuban', name, account_number: acct, bank_code: bank.code, currency: 'NGN', description: `StorageX farmer ${f.code}` });
  await tx(async () => {
    await db.run(`UPDATE payout_recipients SET status='replaced' WHERE farmer_id=$1 AND status='active'`, f.id);
    await db.run(`INSERT INTO payout_recipients (farmer_id, recipient_code, bank_code, bank_name, account_last4, account_name, name_match, override_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      f.id, rec.recipient_code, bank.code, bank.name, acct.slice(-4), name, match === 'match' || match === 'partial' ? match : 'override', note || null, a.user.id);
    await audit(actorOf(a), 'payout.recipient_saved', { entity: 'farmer', entityId: f.id, data: { bank: bank.name, last4: acct.slice(-4), name_match: match } });
  });
  return { account_name: name, match };
}
export const recipientOf = (farmerId: string) => db.get<any>(`SELECT * FROM payout_recipients WHERE farmer_id=$1 AND status='active'`, farmerId);

// ---------- payouts ----------
export async function requestPayout(a: Actor, lineId: string) {
  needFin(a);
  const l = await db.get<any>(`SELECT sl.*, sl.amount_kobo::float AS amount, s.ref FROM settlement_lines sl JOIN settlements st ON st.id=sl.settlement_id JOIN sales s ON s.id=st.sale_id WHERE sl.id=$1`, lineId);
  if (!l || l.party !== 'farmer') throw new UserError('Only farmer lines are paid through Paystack; lenders are paid by bank transfer.');
  if (l.paid_at) throw new UserError('Already paid.');
  if (l.amount <= 0) throw new UserError('Nothing to pay on this line.');
  const r = await recipientOf(l.farmer_id);
  if (!r) throw new UserError('Save the farmer’s bank account first (on the farmer’s page).');
  const ref = `SXP-${l.ref}-${String(lineId).slice(0, 8)}`;
  await db.run(`INSERT INTO payouts (line_id, recipient_id, amount_kobo, reference, requested_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (line_id) DO UPDATE SET status='requested', recipient_id=EXCLUDED.recipient_id, requested_by=EXCLUDED.requested_by, requested_at=now(), approved_by=NULL, failure_reason=NULL
    WHERE payouts.status IN ('failed','reversed','cancelled')`, lineId, r.id, Math.round(l.amount), ref, a.user.id);
  await audit(actorOf(a), 'payout.requested', { entity: 'settlement_line', entityId: lineId, data: { kobo: l.amount, ref } });
}
export async function approvePayout(a: Actor, payoutId: string) {
  needFin(a);
  const p = await db.get<any>(`SELECT p.*, p.amount_kobo::float AS amount, r.recipient_code, st.settled_by FROM payouts p JOIN payout_recipients r ON r.id=p.recipient_id
    JOIN settlement_lines sl ON sl.id=p.line_id JOIN settlements st ON st.id=sl.settlement_id WHERE p.id=$1`, payoutId);
  if (!p || p.status !== 'requested') throw new UserError('This payout is not waiting for approval.');
  if (p.requested_by === a.user.id) throw new UserError('You asked for this payout, so someone else approves it.');
  if (p.settled_by === a.user.id) throw new UserError('You settled this sale, so someone else approves its payouts.');
  // Mark it sent before calling Paystack, so a second click cannot send twice; the reference makes Paystack refuse a repeat too.
  const n = await db.run(`UPDATE payouts SET status='sent', approved_by=$2, sent_at=now() WHERE id=$1 AND status='requested'`, payoutId, a.user.id);
  if (!n) throw new UserError('Already sent.');
  try {
    const t = await ps('/transfer', 'POST', { source: 'balance', amount: Math.round(p.amount), recipient: p.recipient_code, reference: p.reference, reason: `StorageX sale payout ${p.reference}` });
    await db.run('UPDATE payouts SET transfer_code=$2 WHERE id=$1', payoutId, t?.transfer_code ?? null);
    if (t?.status === 'success') await finishPayout(p.reference, 'succeeded');
    else if (t?.status === 'otp') {
      // The Paystack account asks for a one-time code on every transfer (kept on because other platforms share it).
      await db.run(`UPDATE payouts SET status='awaiting_otp' WHERE id=$1`, payoutId);
      await audit(actorOf(a), 'payout.awaiting_code', { entity: 'payout', entityId: payoutId, data: { ref: p.reference } });
      return 'otp' as const;
    }
  } catch (e) {
    await db.run(`UPDATE payouts SET status='requested', approved_by=NULL, sent_at=NULL, failure_reason=$2 WHERE id=$1 AND transfer_code IS NULL`, payoutId, String((e as Error).message).slice(0, 200));
    throw e;
  }
  await audit(actorOf(a), 'payout.sent', { entity: 'payout', entityId: payoutId, data: { ref: p.reference, kobo: p.amount } });
  return 'sent' as const;
}

/** The approver types the code Paystack sent to the account owner's phone; Paystack then sends the money. */
export async function confirmPayoutCode(a: Actor, payoutId: string, code: string) {
  needFin(a);
  const p = await db.get<any>(`SELECT * FROM payouts WHERE id=$1`, payoutId);
  if (!p || p.status !== 'awaiting_otp') throw new UserError('This payout is not waiting for a code.');
  if (p.approved_by !== a.user.id) throw new UserError('The person who approved this payout enters its code.');
  const otp = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(otp)) throw new UserError('Enter the code Paystack sent (digits only).');
  const t = await ps('/transfer/finalize_transfer', 'POST', { transfer_code: p.transfer_code, otp });
  await db.run(`UPDATE payouts SET status='sent' WHERE id=$1 AND status='awaiting_otp'`, payoutId);
  if (t?.status === 'success') await finishPayout(p.reference, 'succeeded');
  await audit(actorOf(a), 'payout.sent', { entity: 'payout', entityId: payoutId, data: { ref: p.reference, kobo: Number(p.amount_kobo), with_code: true } });
}
/** Ask Paystack to send the code again. */
export async function resendPayoutCode(a: Actor, payoutId: string) {
  needFin(a);
  const p = await db.get<any>(`SELECT * FROM payouts WHERE id=$1`, payoutId);
  if (!p || p.status !== 'awaiting_otp') throw new UserError('This payout is not waiting for a code.');
  await ps('/transfer/resend_otp', 'POST', { transfer_code: p.transfer_code, reason: 'transfer' });
}
/** Give up on a payout stuck waiting for a code, so it can be asked for again. */
export async function cancelPayout(a: Actor, payoutId: string) {
  needFin(a);
  const n = await db.run(`UPDATE payouts SET status='cancelled', finished_at=now(), failure_reason='Cancelled while waiting for the Paystack code' WHERE id=$1 AND status='awaiting_otp'`, payoutId);
  if (!n) throw new UserError('Only a payout waiting for its code can be cancelled here.');
  await audit(actorOf(a), 'payout.cancelled', { entity: 'payout', entityId: payoutId });
}
async function finishPayout(reference: string, outcome: 'succeeded' | 'failed' | 'reversed', reason?: string) {
  const p = await db.get<any>('SELECT * FROM payouts WHERE reference=$1', reference);
  if (!p || ['succeeded'].includes(p.status) && outcome === 'succeeded') return;
  await tx(async () => {
    await db.run(`UPDATE payouts SET status=$2, finished_at=now(), failure_reason=$3 WHERE id=$1`, p.id, outcome, reason ?? null);
    if (outcome === 'succeeded') await db.run(`UPDATE settlement_lines SET paid_ref=$2, paid_at=now(), paid_by=$3 WHERE id=$1 AND paid_at IS NULL`, p.line_id, reference, p.approved_by);
    else await db.run(`UPDATE settlement_lines SET paid_ref=NULL, paid_at=NULL, paid_by=NULL WHERE id=$1 AND paid_ref=$2`, p.line_id, reference);
  });
  await audit(systemActor('paystack'), `payout.${outcome}`, { entity: 'payout', entityId: p.id, data: { ref: reference, reason: reason ?? null } });
}
export const payoutsFor = (saleId: string) => db.all<any>(`SELECT p.*, p.amount_kobo::float AS amount, r.bank_name, r.account_last4, rq.full_name AS requested_name, ap.full_name AS approved_name
  FROM payouts p JOIN payout_recipients r ON r.id=p.recipient_id JOIN settlement_lines sl ON sl.id=p.line_id JOIN settlements st ON st.id=sl.settlement_id
  JOIN users rq ON rq.id=p.requested_by LEFT JOIN users ap ON ap.id=p.approved_by WHERE st.sale_id=$1`, saleId);

// ---------- buyer payment links ----------
export async function paymentLink(a: Actor, saleRef: string, email: string) {
  needFin(a);
  const s = await db.get<any>(`SELECT id, ref, status, buyer_name FROM sales WHERE ref=upper($1)`, clean(saleRef, 20));
  if (!s || s.status !== 'approved') throw new UserError('Payment links are for approved sales.');
  const e = clean(email, 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UserError('Enter the buyer’s email: Paystack sends the receipt there.');
  const due = (await saleMoney(s.id)).due;
  if (due <= 0) throw new UserError('The buyer has paid in full.');
  const n = Number(await db.val('SELECT count(*) FROM payment_links WHERE sale_id=$1', s.id)) + 1;
  const ref = `${s.ref}-P${n}`;
  const d = await ps('/transaction/initialize', 'POST', { email: e, amount: Math.round(due), reference: ref, currency: 'NGN', channels: ['bank_transfer', 'bank', 'card', 'ussd'], metadata: { sale: s.ref, buyer: s.buyer_name } });
  await db.run(`UPDATE payment_links SET status='cancelled' WHERE sale_id=$1 AND status='open'`, s.id);
  await db.run(`INSERT INTO payment_links (sale_id, reference, amount_kobo, email, url, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, s.id, ref, Math.round(due), e, d.authorization_url, a.user.id);
  await audit(actorOf(a), 'sale.payment_link', { entity: 'sale', entityId: s.id, data: { ref, kobo: due } });
  return { url: d.authorization_url as string, reference: ref, amount: due };
}
export const linksFor = (saleId: string) => db.all<any>(`SELECT *, amount_kobo::float AS amount FROM payment_links WHERE sale_id=$1 ORDER BY created_at DESC`, saleId);

async function linkPaid(reference: string, amount: number, paidAt: string | null) {
  const l = await db.get<any>(`SELECT * FROM payment_links WHERE reference=$1`, reference);
  if (!l || l.status === 'paid') return;
  const sys = await systemUser();
  const s = await db.get<any>('SELECT id, ref, status FROM sales WHERE id=$1', l.sale_id);
  const fits = s?.status === 'approved' && amount <= (await saleMoney(l.sale_id)).due;
  await tx(async () => {
    const cid = await db.val<string>(`INSERT INTO collections (amount_kobo, received_on, reference, payer, sale_id, recorded_by, matched_by, matched_at, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      amount, (paidAt ? new Date(paidAt) : new Date()).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }), reference, `Paystack: ${l.email}`, fits ? l.sale_id : null, sys, fits ? sys : null, fits ? new Date() : null,
      fits ? 'Paid by link; matched automatically' : 'Paid by link, but more than the sale owes or the sale is not approved: match or refund by hand');
    await db.run(`UPDATE payment_links SET status='paid', paid_at=now(), collection_id=$2 WHERE id=$1`, l.id, cid);
  });
  await audit(systemActor('paystack'), 'collection.recorded', { entity: 'sale', entityId: l.sale_id, data: { ref: reference, kobo: amount, matched: fits } });
}

// ---------- webhook ----------
export function validSignature(raw: string, sig: string) {
  if (!config.paystackSecret || !sig) return false;
  const want = crypto.createHmac('sha512', config.paystackSecret).update(raw).digest('hex');
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
/** Handle one verified Paystack event. Repeats are ignored. */
export async function handleEvent(e: any) {
  const type = String(e?.event ?? ''), d = e?.data ?? {};
  const key = `${type}:${d.reference ?? d.id ?? ''}`;
  const fresh = await db.val(`INSERT INTO provider_events (provider, event_key, type) VALUES ('paystack',$1,$2) ON CONFLICT DO NOTHING RETURNING 1`, key, type);
  if (!fresh) return 'repeat';
  if (type === 'charge.success') { await linkPaid(String(d.reference), Number(d.amount), d.paid_at ?? null); return 'charge'; }
  if (type === 'transfer.success') { await finishPayout(String(d.reference), 'succeeded'); return 'transfer'; }
  if (type === 'transfer.failed') { await finishPayout(String(d.reference), 'failed', d.reason ?? d.gateway_response ?? 'failed'); return 'transfer'; }
  if (type === 'transfer.reversed') { await finishPayout(String(d.reference), 'reversed', 'reversed by the bank'); return 'transfer'; }
  return 'ignored';
}
