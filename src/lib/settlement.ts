// Settlement (Build 8): from a sale to money in the farmer's hands.
//   1. Kitovu proposes a sale: buyer, price per kg, and the receipts (from one warehouse and crop, possibly many farmers).
//   2. Each farmer agrees to the price (code to their phone, or a signed slip); a lender with a lien approves too.
//      Then the receipts show "Being sold" and cannot be pledged or withdrawn for anything else.
//   3. The buyer pays into Kitovu's collection account quoting the sale reference; finance records and matches it.
//   4. The warehouse loads the stock out against the sale (two-person release, as in Build 5).
//   5. When paid and delivered, a finance person who did not propose the sale settles it: per receipt, Kitovu fees,
//      then the lender's loan (posted as a repayment, releasing the lien), then the farmer's balance.
//   6. Payouts are recorded with transfer references by someone other than the settler; the farmer is texted.
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { toKobo, fmtNGN, bpOf, valueKobo } from './money';
import { saveFile } from './files';
import { issueOtp, checkOtp } from './otp';
import { notifyFarmer as notify } from './notify';
import { getSettings } from './settings';
import { clean } from './util';
import { receiptBalance } from './stock';
import { position, entriesOf } from './finance';
import type { Upload } from './http';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const SELLABLE = ['issued', 'partially_released', 'pledged', 'financed'];
function needOps(a: Actor) { if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Kitovu operations arrange sales.'); }
function needFin(a: Actor) { if (!isKitovu(a) || !can(a.membership, 'finance.approve')) throw new UserError('Only Kitovu finance can do this.'); }

// ---------- proposing a sale ----------
export async function proposeSale(a: Actor, i: { buyer?: string; buyer_org?: string; price?: string; receipts?: string; note?: string }) {
  needOps(a);
  const nos = String(i.receipts ?? '').split(/[,\s]+/).filter(Boolean);
  if (!nos.length) throw new UserError('List the receipts being sold.');
  let perKg: number;
  try { perKg = toKobo(i.price ?? ''); } catch { throw new UserError('Enter the price per kg in naira, e.g. 480.'); }
  if (perKg <= 0) throw new UserError('The price must be more than zero.');
  const org = i.buyer_org ? await db.get<{ id: string; name: string }>(`SELECT id, name FROM organisations WHERE id=$1 AND kind='buyer'`, i.buyer_org) : undefined;
  const buyer = org?.name ?? clean(i.buyer, 120);
  if (buyer.length < 3) throw new UserError('Name the buyer.');
  return tx(async () => {
    const items: { receipt_id: string; farmer_id: string; kg: number; status: string; wh: string; com: string; lender: string | null }[] = [];
    for (const no of [...new Set(nos.map((n) => n.toUpperCase()))]) {
      const r = await db.get<{ id: string; status: string; owner_farmer_id: string | null; warehouse_id: string; commodity_code: string }>('SELECT id, status::text, owner_farmer_id, warehouse_id, commodity_code FROM receipts WHERE receipt_no=$1 FOR UPDATE', no);
      if (!r) throw new UserError(`Receipt ${no} not found.`);
      if (!SELLABLE.includes(r.status)) throw new UserError(`Receipt ${no} is ${r.status.replace(/_/g, ' ')} and cannot be sold.`);
      if (!r.owner_farmer_id) throw new UserError(`Receipt ${no} has no farmer owner.`);
      if (await db.val(`SELECT s.ref FROM sale_items x JOIN sales s ON s.id=x.sale_id WHERE x.receipt_id=$1 AND s.status IN ('proposed','approved')`, r.id)) throw new UserError(`Receipt ${no} is already in a sale.`);
      if (await db.val(`SELECT 1 FROM releases WHERE receipt_id=$1 AND status='ordered'`, r.id)) throw new UserError(`Receipt ${no} has a release waiting. Load or cancel it first.`);
      const kg = (await receiptBalance(r.id))!.remaining_kg;
      if (kg <= 0) throw new UserError(`Receipt ${no} holds nothing.`);
      const lender = await db.val<string>('SELECT lender_org_id FROM liens WHERE receipt_id=$1 AND released_at IS NULL', r.id);
      items.push({ receipt_id: r.id, farmer_id: r.owner_farmer_id, kg, status: r.status, wh: r.warehouse_id, com: r.commodity_code, lender: lender ?? null });
    }
    if (new Set(items.map((x) => `${x.wh}:${x.com}`)).size > 1) throw new UserError('One sale covers one crop at one warehouse.');
    const day = ymd(new Date()).slice(2).replace(/-/g, '');
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'sl:' + day);
    const ref = `SL-${day}-${String(Number(await db.val(`SELECT count(*) FROM sales WHERE ref LIKE $1`, `SL-${day}-%`)) + 1).padStart(3, '0')}`;
    const id = (await db.val<string>(`INSERT INTO sales (ref, warehouse_id, commodity_code, buyer_org_id, buyer_name, kobo_per_kg, created_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      ref, items[0].wh, items[0].com, org?.id ?? null, buyer, perKg, a.user.id, clean(i.note, 300) || null))!;
    for (const x of items)
      await db.run(`INSERT INTO sale_items (sale_id, receipt_id, farmer_id, kg, gross_kobo, previous_status, lender_org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, x.receipt_id, x.farmer_id, x.kg, valueKobo(x.kg, perKg), x.status, x.lender);
    await audit(actorOf(a), 'sale.proposed', { entity: 'sale', entityId: id, data: { ref, buyer, kobo_per_kg: perKg, receipts: items.length } });
    return { id, ref };
  });
}

async function item(itemId: string) {
  return db.get<any>(`SELECT x.*, x.kg::float AS kgf, x.gross_kobo::float AS gross, s.ref, s.status AS sale_status, s.kobo_per_kg, s.buyer_name, s.created_by AS sale_creator, c.name AS commodity,
      f.code AS farmer_code, f.full_name AS farmer_name, f.phone_e164, f.phone_verified_at, r.receipt_no
    FROM sale_items x JOIN sales s ON s.id=x.sale_id JOIN commodities c ON c.code=s.commodity_code JOIN farmers f ON f.id=x.farmer_id JOIN receipts r ON r.id=x.receipt_id WHERE x.id=$1`, itemId);
}

export async function sendAgreementCode(a: Actor, itemId: string, channel: 'sms' | 'voice') {
  needOps(a);
  const x = await item(itemId);
  if (!x || x.sale_status !== 'proposed') throw new UserError('This sale is not waiting for agreement.');
  if (!x.phone_e164 || !x.phone_verified_at) throw new UserError('No confirmed phone: use the signed sale slip.');
  await issueOtp('sale_agree', x.id, x.phone_e164, (c) => `StorageX: code ${c} agrees to sell ${x.kgf.toLocaleString('en-NG')} kg ${x.commodity} (receipt ${x.receipt_no}) to ${x.buyer_name} at ${fmtNGN(Number(x.kobo_per_kg))}/kg, ${fmtNGN(x.gross, { decimals: false })} before fees and any loan. Give it only if you agree.`, channel);
}

export async function recordAgreement(a: Actor, itemId: string, i: { method?: string; otp?: string }, slip?: Upload) {
  needOps(a);
  const x = await item(itemId);
  if (!x || x.sale_status !== 'proposed') throw new UserError('This sale is not waiting for agreement.');
  if (x.farmer_agreed_at) throw new UserError('The farmer has already agreed.');
  let fileId: string | null = null;
  if (i.method === 'code') { const r = await checkOtp('sale_agree', x.id, String(i.otp ?? '')); if (!r.ok) throw new UserError(r.reason); }
  else if (i.method === 'paper_slip') fileId = await saveFile(slip, { kind: 'sale_evidence', entity: 'sale_item', entityId: x.id, userId: a.user.id, allowPdf: true, label: 'Photo of the signed sale slip' });
  else throw new UserError('Choose how the farmer agreed.');
  await db.run(`UPDATE sale_items SET farmer_agreed_at=now(), agreement_method=$2, agreement_file_id=$3, agreement_by=$4 WHERE id=$1`, x.id, i.method, fileId, a.user.id);
  await audit(actorOf(a), 'sale.farmer_agreed', { entity: 'sale', entityId: x.sale_id, data: { receipt: x.receipt_no, method: i.method } });
  await maybeApprove(x.sale_id, a.user.id);
}

export async function lenderApprove(a: Actor, itemId: string) {
  const x = await item(itemId);
  if (!x || x.sale_status !== 'proposed' || !x.lender_org_id) throw new UserError('Nothing to approve here.');
  if (a.membership?.org_id !== x.lender_org_id || !can(a.membership, 'finance.approve')) throw new UserError('Only the lender holding the pledge can approve this sale.');
  await db.run('UPDATE sale_items SET lender_approved_by=$2, lender_approved_at=now() WHERE id=$1 AND lender_approved_at IS NULL', x.id, a.user.id);
  await audit(actorOf(a), 'sale.lender_approved', { orgId: x.lender_org_id, entity: 'sale', entityId: x.sale_id, data: { receipt: x.receipt_no } });
  await maybeApprove(x.sale_id, a.user.id);
}

/** When every owner has agreed and every lien holder approved, the receipts are committed to the sale. */
async function maybeApprove(saleId: string, userId: string) {
  await tx(async () => {
    const s = await db.get<{ status: string; ref: string; buyer_name: string }>('SELECT status, ref, buyer_name FROM sales WHERE id=$1 FOR UPDATE', saleId);
    if (s?.status !== 'proposed') return;
    if (await db.val(`SELECT 1 FROM sale_items WHERE sale_id=$1 AND (farmer_agreed_at IS NULL OR (lender_org_id IS NOT NULL AND lender_approved_at IS NULL))`, saleId)) return;
    const items = await db.all<{ receipt_id: string }>('SELECT receipt_id FROM sale_items WHERE sale_id=$1', saleId);
    for (const x of items) {
      await db.run(`UPDATE receipts SET status='sale_approved', distribution_enabled=false WHERE id=$1`, x.receipt_id);
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'sale_approved',now(),$2,$3)`, x.receipt_id, `user:${userId}`, JSON.stringify({ sale: s.ref, buyer: s.buyer_name }));
    }
    await db.run(`UPDATE sales SET status='approved', approved_at=now() WHERE id=$1`, saleId);
  });
}

export async function cancelSale(a: Actor, saleId: string, reason: string) {
  needOps(a);
  if (clean(reason).length < 5) throw new UserError('Give the reason.');
  await tx(async () => {
    const s = await db.get<{ status: string; ref: string }>('SELECT status, ref FROM sales WHERE id=$1 FOR UPDATE', saleId);
    if (!s || !['proposed', 'approved'].includes(s.status)) throw new UserError('Only an open sale can be cancelled.');
    if (await db.val('SELECT 1 FROM collections WHERE sale_id=$1', saleId)) throw new UserError('Money has been received for this sale. Refund and unmatch it before cancelling.');
    if (await db.val(`SELECT 1 FROM releases WHERE sale_id=$1 AND status='loaded'`, saleId)) throw new UserError('Stock has already left for this sale; it must be settled.');
    await db.run(`UPDATE releases SET status='cancelled', note='sale cancelled' WHERE sale_id=$1 AND status='ordered'`, saleId);
    if (s.status === 'approved') {
      for (const x of await db.all<{ receipt_id: string; previous_status: string }>('SELECT receipt_id, previous_status FROM sale_items WHERE sale_id=$1', saleId)) {
        await db.run(`UPDATE receipts SET status=$2 WHERE id=$1 AND status='sale_approved'`, x.receipt_id, x.previous_status);
        await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'sale_cancelled',now(),$2,$3)`, x.receipt_id, `user:${a.user.id}`, JSON.stringify({ sale: s.ref }));
      }
    }
    await db.run(`UPDATE sales SET status='cancelled', note=COALESCE(note || ' — ', '') || $2 WHERE id=$1`, saleId, `cancelled: ${clean(reason, 200)}`);
    await audit(actorOf(a), 'sale.cancelled', { entity: 'sale', entityId: saleId, data: { reason: clean(reason, 200) } });
  });
}

/** Release orders for every receipt in an approved sale, to the buyer's collector. */
export async function orderDelivery(a: Actor, saleId: string, collector: string, phone: string) {
  needOps(a);
  const s = await db.get<{ status: string; ref: string }>('SELECT status, ref FROM sales WHERE id=$1', saleId);
  if (s?.status !== 'approved') throw new UserError('Deliveries can be ordered once every farmer (and lender) has agreed.');
  const name = clean(collector, 120);
  if (name.length < 3) throw new UserError('Name the buyer’s collector or driver.');
  const refs: string[] = [];
  await tx(async () => {
    for (const x of await db.all<{ receipt_id: string; kg: string }>(`SELECT x.receipt_id, x.kg FROM sale_items x WHERE x.sale_id=$1
        AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.sale_id=x.sale_id AND r.receipt_id=x.receipt_id AND r.status IN ('ordered','loaded'))`, saleId)) {
      const day = ymd(new Date()).slice(2).replace(/-/g, '');
      await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'rel:' + day);
      const ref = `REL-${day}-${String(Number(await db.val(`SELECT count(*) FROM releases WHERE ref LIKE $1`, `REL-${day}-%`)) + 1).padStart(3, '0')}`;
      await db.run(`INSERT INTO releases (ref, receipt_id, kg_ordered, reason, collector_name, collector_phone, ordered_by, sale_id, note) VALUES ($1,$2,$3,'sale_delivery',$4,$5,$6,$7,$8)`,
        ref, x.receipt_id, x.kg, name, clean(phone, 20) || null, a.user.id, saleId, `delivery for ${s.ref}`);
      refs.push(ref);
    }
  });
  if (!refs.length) throw new UserError('Every receipt in this sale already has a delivery ordered.');
  await audit(actorOf(a), 'sale.delivery_ordered', { entity: 'sale', entityId: saleId, data: { releases: refs } });
  return refs;
}

// ---------- collections ----------
export async function recordCollection(a: Actor, i: { amount?: string; on?: string; reference?: string; payer?: string; note?: string }) {
  needFin(a);
  let amount: number;
  try { amount = toKobo(i.amount ?? ''); } catch { throw new UserError('Enter the amount received in naira.'); }
  if (amount <= 0) throw new UserError('Enter the amount received.');
  const ref = clean(i.reference, 120), payer = clean(i.payer, 120);
  if (ref.length < 3 || payer.length < 2) throw new UserError('Enter the bank reference (or narration) and who paid.');
  const on = i.on ? new Date(i.on + 'T12:00:00+01:00') : new Date();
  if (isNaN(on.getTime()) || on.getTime() > Date.now() + 86_400_000) throw new UserError('The date cannot be in the future.');
  // Match by the sale reference in the narration, when the amount fits.
  const m = ref.toUpperCase().match(/SL-\d{6}-\d{3}/);
  let saleId: string | null = null;
  if (m) {
    const s = await db.get<{ id: string; status: string }>(`SELECT id, status FROM sales WHERE ref=$1`, m[0]);
    if (s && s.status === 'approved' && amount <= (await saleMoney(s.id)).due) saleId = s.id;
  }
  const id = await db.val<string>(`INSERT INTO collections (amount_kobo, received_on, reference, payer, sale_id, recorded_by, matched_by, matched_at, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    amount, ymd(on), ref, payer, saleId, a.user.id, saleId ? a.user.id : null, saleId ? new Date() : null, clean(i.note, 300) || null);
  await audit(actorOf(a), 'collection.recorded', { entity: 'collection', entityId: id!, data: { kobo: amount, matched: saleId } });
  return { matched: !!saleId };
}

export async function matchCollection(a: Actor, collectionId: string, saleRef: string) {
  needFin(a);
  const c = await db.get<{ amount_kobo: string; sale_id: string | null; recorded_by: string }>('SELECT amount_kobo, sale_id, recorded_by FROM collections WHERE id=$1', collectionId);
  if (!c) throw new UserError('Payment not found.');
  if (c.sale_id) throw new UserError('This payment is already matched.');
  if (c.recorded_by === a.user.id) throw new UserError('You recorded this payment, so someone else must match it by hand.');
  const s = await db.get<{ id: string; status: string }>('SELECT id, status FROM sales WHERE ref=upper($1)', clean(saleRef, 20));
  if (!s || s.status !== 'approved') throw new UserError('Choose an approved, unsettled sale.');
  if (Number(c.amount_kobo) > (await saleMoney(s.id)).due) throw new UserError('This payment is more than the sale still owes. Record the excess as a separate payment.');
  await db.run('UPDATE collections SET sale_id=$2, matched_by=$3, matched_at=now() WHERE id=$1', collectionId, s.id, a.user.id);
  await audit(actorOf(a), 'collection.matched', { entity: 'collection', entityId: collectionId, data: { sale: saleRef } });
}
export const unmatchedCollections = () => db.all<any>(`SELECT c.*, c.amount_kobo::float AS amount, u.full_name AS recorder FROM collections c JOIN users u ON u.id=c.recorded_by WHERE c.sale_id IS NULL ORDER BY c.received_on DESC LIMIT 100`);

export async function saleMoney(saleId: string) {
  const gross = Number(await db.val('SELECT COALESCE(sum(gross_kobo),0) FROM sale_items WHERE sale_id=$1', saleId));
  const paid = Number(await db.val('SELECT COALESCE(sum(amount_kobo),0) FROM collections WHERE sale_id=$1', saleId));
  return { gross, paid, due: Math.max(0, gross - paid) };
}

// ---------- settlement: the waterfall ----------
export async function previewWaterfall(saleId: string, asOf = new Date()) {
  const s = await getSettings();
  const items = await db.all<any>(`SELECT x.*, x.kg::float AS kgf, x.gross_kobo::float AS gross, r.issued_at, r.receipt_no, f.full_name AS farmer_name FROM sale_items x
    JOIN receipts r ON r.id=x.receipt_id JOIN farmers f ON f.id=x.farmer_id WHERE x.sale_id=$1 ORDER BY r.receipt_no`, saleId);
  const out = [];
  for (const x of items) {
    const days = Math.max(1, Math.ceil((asOf.getTime() - new Date(x.issued_at).getTime()) / 86_400_000));
    const storage = Math.round(x.kgf * s['fees.storage_kobo_per_kg_month'] * (days / 30));
    const handling = Math.round(x.kgf * s['fees.handling_kobo_per_kg'] * 2);
    const commission = bpOf(x.gross, s['fees.sale_commission_bp']);
    let left = x.gross;
    const lines: { party: 'kitovu' | 'lender' | 'farmer'; label: string; amount: number; org_id?: string; loan_id?: string; farmer_id?: string }[] = [];
    const take = (n: number) => { const t = Math.min(n, left); left -= t; return t; };
    lines.push({ party: 'kitovu', label: `Storage, ${days} days`, amount: take(storage) });
    lines.push({ party: 'kitovu', label: 'Handling in and out', amount: take(handling) });
    lines.push({ party: 'kitovu', label: `Sale commission ${s['fees.sale_commission_bp'] / 100}%`, amount: take(commission) });
    let shortfall = 0;
    const loan = await db.get<any>(`SELECT ln.* FROM liens li JOIN loans ln ON ln.id=li.loan_id WHERE li.receipt_id=$1 AND li.released_at IS NULL`, x.receipt_id);
    if (loan && loan.status === 'disbursed') {
      // A loan can be secured by several receipts: this receipt pays what is still owed after the others in this sale.
      const owed = position(loan, await entriesOf(loan.id), asOf).outstanding;
      const already = out.filter((o) => o.loan_id === loan.id).reduce((n, o) => n + o.toLender, 0);
      const need = Math.max(0, owed - already);
      const paid = take(need);
      lines.push({ party: 'lender', label: `Loan ${loan.loan_no}`, amount: paid, org_id: loan.lender_org_id, loan_id: loan.id });
      shortfall = need - paid;
    }
    lines.push({ party: 'farmer', label: 'Balance to the farmer', amount: left, farmer_id: x.farmer_id });
    out.push({ item_id: x.id, receipt_no: x.receipt_no, farmer: x.farmer_name, farmer_id: x.farmer_id, receipt_id: x.receipt_id, kg: x.kgf, gross: x.gross, lines, loan_id: loan?.id ?? null, toLender: lines.find((l) => l.party === 'lender')?.amount ?? 0, shortfall });
  }
  return out;
}

export async function settle(a: Actor, saleId: string) {
  needFin(a);
  return tx(async () => {
    const s = await db.get<any>('SELECT * FROM sales WHERE id=$1 FOR UPDATE', saleId);
    if (!s || s.status !== 'approved') throw new UserError('Only an approved sale can be settled.');
    if (s.created_by === a.user.id) throw new UserError('You arranged this sale, so someone else must settle it.');
    const money = await saleMoney(saleId);
    if (money.due > 0) throw new UserError(`The buyer still owes ${fmtNGN(money.due)}.`);
    const undelivered = await db.all<{ receipt_no: string }>(`SELECT r.receipt_no FROM sale_items x JOIN receipts r ON r.id=x.receipt_id
      WHERE x.sale_id=$1 AND COALESCE((SELECT sum(kg_loaded) FROM releases l WHERE l.sale_id=x.sale_id AND l.receipt_id=x.receipt_id AND l.status='loaded'),0) < x.kg - GREATEST(1, x.kg*0.005)`, saleId);
    if (undelivered.length) throw new UserError(`Not yet delivered to the buyer: ${undelivered.map((u) => u.receipt_no).join(', ')}.`);
    const wf = await previewWaterfall(saleId);
    const totals = { gross: money.gross, kitovu: 0, lender: 0, farmer: 0, shortfall: 0 };
    const sid = (await db.val<string>('INSERT INTO settlements (sale_id, settled_by, totals) VALUES ($1,$2,$3) RETURNING id', saleId, a.user.id, '{}'))!;
    const day = ymd(new Date());
    for (const it of wf) {
      let seq = 0;
      for (const l of it.lines) {
        await db.run(`INSERT INTO settlement_lines (settlement_id, item_id, seq, party, label, amount_kobo, org_id, farmer_id, loan_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          sid, it.item_id, ++seq, l.party, l.label, l.amount, l.org_id ?? null, l.farmer_id ?? null, l.loan_id ?? null);
        totals[l.party] += l.amount;
        if (l.party === 'lender' && l.amount > 0) {
          await db.run(`INSERT INTO loan_entries (loan_id, kind, amount_kobo, on_date, reference, note, recorded_by) VALUES ($1,'repayment',$2,$3,$4,$5,$6)`, l.loan_id, l.amount, day, s.ref, 'from sale proceeds', a.user.id);
        }
      }
      totals.shortfall += it.shortfall;
    }
    // Close loans paid in full and release their liens; mark every receipt settled.
    for (const loanId of [...new Set(wf.map((w) => w.loan_id).filter(Boolean))] as string[]) {
      const ln = (await db.get<any>('SELECT * FROM loans WHERE id=$1', loanId))!;
      if (position(ln, await entriesOf(loanId)).outstanding <= 0) await db.run(`UPDATE loans SET status='repaid', closed_at=now() WHERE id=$1`, loanId);
    }
    for (const it of wf) {
      await db.run(`UPDATE liens SET released_at=now(), release_reason=$2 WHERE receipt_id=$1 AND released_at IS NULL`, it.receipt_id, `sold under ${s.ref}`);
      await db.run(`UPDATE receipts SET status='settled', closed_at=now(), closed_reason=$2 WHERE id=$1`, it.receipt_id, `Sold under ${s.ref}`);
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'settled',now(),$2,$3)`, it.receipt_id, `user:${a.user.id}`,
        JSON.stringify({ sale: s.ref, gross_kobo: it.gross, to_lender_kobo: it.toLender, to_farmer_kobo: it.lines.find((l) => l.party === 'farmer')!.amount }));
    }
    await db.run(`UPDATE settlements SET totals=$2 WHERE id=$1`, sid, JSON.stringify(totals));
    await db.run(`UPDATE sales SET status='settled' WHERE id=$1`, saleId);
    await audit(actorOf(a), 'sale.settled', { entity: 'sale', entityId: saleId, data: { ref: s.ref, ...totals } });
    return totals;
  });
}

export async function markPaid(a: Actor, lineId: string, reference: string) {
  needFin(a);
  const l = await db.get<any>(`SELECT sl.*, st.settled_by, s.ref, f.full_name, f.phone_e164, f.phone_verified_at FROM settlement_lines sl JOIN settlements st ON st.id=sl.settlement_id JOIN sales s ON s.id=st.sale_id
    LEFT JOIN farmers f ON f.id=sl.farmer_id WHERE sl.id=$1`, lineId);
  if (!l || l.party === 'kitovu') throw new UserError('Only lender and farmer lines are paid out.');
  if (l.paid_at) throw new UserError('Already paid.');
  if (l.settled_by === a.user.id) throw new UserError('You settled this sale, so someone else records the payout.');
  const ref = clean(reference, 60);
  if (ref.length < 4) throw new UserError('Enter the transfer reference.');
  if (/^\d{10}$/.test(ref)) throw new UserError('That looks like an account number. Enter the transfer reference instead.');
  await db.run('UPDATE settlement_lines SET paid_ref=$2, paid_at=now(), paid_by=$3 WHERE id=$1', lineId, ref, a.user.id);
  await audit(actorOf(a), 'settlement.paid', { entity: 'settlement_line', entityId: lineId, data: { party: l.party, kobo: Number(l.amount_kobo), ref } });
  if (l.party === 'farmer' && l.farmer_id) await notify(l.farmer_id, 'sale_paid', `${l.ref}:${lineId}`, { amount: fmtNGN(Number(l.amount_kobo)), sale: l.ref, ref });
}

// ---------- views ----------
export const salesList = () => db.all<any>(
  `SELECT s.*, s.kobo_per_kg::float AS perkg, w.name AS wh_name, c.name AS commodity, (SELECT count(*)::int FROM sale_items x WHERE x.sale_id=s.id) AS items,
     (SELECT COALESCE(sum(gross_kobo),0)::float FROM sale_items x WHERE x.sale_id=s.id) AS gross, (SELECT COALESCE(sum(amount_kobo),0)::float FROM collections k WHERE k.sale_id=s.id) AS paid
   FROM sales s JOIN warehouses w ON w.id=s.warehouse_id JOIN commodities c ON c.code=s.commodity_code ORDER BY s.created_at DESC LIMIT 200`);

export async function saleView(a: Actor, ref: string) {
  const s = await db.get<any>(`SELECT s.*, s.kobo_per_kg::float AS perkg, w.name AS wh_name, w.code AS wh_code, c.name AS commodity, u.full_name AS creator FROM sales s
    JOIN warehouses w ON w.id=s.warehouse_id JOIN commodities c ON c.code=s.commodity_code JOIN users u ON u.id=s.created_by WHERE s.ref=upper($1)`, clean(ref, 20));
  if (!s) return undefined;
  const lenderView = a.membership?.org_kind === 'lender';
  if (!isKitovu(a) && !(lenderView && await db.val('SELECT 1 FROM sale_items WHERE sale_id=$1 AND lender_org_id=$2', s.id, a.membership!.org_id))) return undefined;
  s.items = await db.all<any>(`SELECT x.*, x.kg::float AS kgf, x.gross_kobo::float AS gross, r.receipt_no, f.full_name AS farmer_name, f.code AS farmer_code, f.phone_verified_at, o.name AS lender,
      COALESCE((SELECT sum(kg_loaded) FROM releases l WHERE l.sale_id=x.sale_id AND l.receipt_id=x.receipt_id AND l.status='loaded'),0)::float AS delivered
    FROM sale_items x JOIN receipts r ON r.id=x.receipt_id JOIN farmers f ON f.id=x.farmer_id LEFT JOIN organisations o ON o.id=x.lender_org_id WHERE x.sale_id=$1 ORDER BY r.receipt_no`, s.id);
  s.money = await saleMoney(s.id);
  s.collections = await db.all<any>('SELECT *, amount_kobo::float AS amount FROM collections WHERE sale_id=$1 ORDER BY received_on', s.id);
  s.releases = await db.all<any>('SELECT x.ref, x.status, x.kg_ordered::float AS ordered, x.kg_loaded::float AS loaded, r.receipt_no FROM releases x JOIN receipts r ON r.id=x.receipt_id WHERE x.sale_id=$1 ORDER BY x.ref', s.id);
  const st = await db.get<any>('SELECT * FROM settlements WHERE sale_id=$1', s.id);
  s.settlement = st ? { ...st, lines: await db.all<any>(`SELECT sl.*, sl.amount_kobo::float AS amount, r.receipt_no, f.full_name AS farmer_name, o.name AS org_name, u.full_name AS payer
      FROM settlement_lines sl JOIN sale_items x ON x.id=sl.item_id JOIN receipts r ON r.id=x.receipt_id LEFT JOIN farmers f ON f.id=sl.farmer_id LEFT JOIN organisations o ON o.id=sl.org_id LEFT JOIN users u ON u.id=sl.paid_by
      WHERE sl.settlement_id=$1 ORDER BY r.receipt_no, sl.seq`, st.id) } : null;
  s.preview = s.status === 'approved' ? await previewWaterfall(s.id) : null;
  if (lenderView) s.items = s.items.filter((x: any) => x.lender_org_id === a.membership!.org_id);
  return s;
}

/** Everything that happened to a farmer's produce and money, in one place. */
export async function farmerStatement(farmerId: string) {
  const deliveries = await db.all<any>(`SELECT i.ref, i.captured_at AS at, i.net_kg::float AS kg, c.name AS commodity, w.name AS warehouse, i.status FROM intakes i JOIN commodities c ON c.code=i.commodity_code JOIN warehouses w ON w.id=i.warehouse_id WHERE i.farmer_id=$1 ORDER BY i.captured_at`, farmerId);
  const receipts = await db.all<any>(`SELECT r.receipt_no, r.issued_at AS at, r.net_weight_kg::float AS kg, b.remaining_kg::float AS held, r.status::text AS status, c.name AS commodity FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id JOIN commodities c ON c.code=r.commodity_code WHERE r.owner_farmer_id=$1 ORDER BY r.issued_at`, farmerId);
  const loans = await db.all<any>(`SELECT ln.*, ln.principal_kobo::float AS principal, o.name AS lender FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id WHERE ln.farmer_id=$1 AND ln.status IN ('disbursed','repaid') ORDER BY ln.approved_at`, farmerId);
  for (const l of loans) l.pos = position(l, await entriesOf(l.id));
  const sales = await db.all<any>(`SELECT s.ref, st.settled_at AS at, r.receipt_no, x.kg::float AS kg, x.gross_kobo::float AS gross, s.kobo_per_kg::float AS perkg, s.buyer_name,
      (SELECT json_agg(json_build_object('party', sl.party, 'label', sl.label, 'amount', sl.amount_kobo, 'paid_ref', sl.paid_ref, 'paid_at', sl.paid_at) ORDER BY sl.seq) FROM settlement_lines sl WHERE sl.item_id=x.id) AS lines
    FROM sale_items x JOIN sales s ON s.id=x.sale_id JOIN receipts r ON r.id=x.receipt_id LEFT JOIN settlements st ON st.sale_id=s.id WHERE x.farmer_id=$1 AND s.status='settled' ORDER BY st.settled_at`, farmerId);
  const owed = Number(await db.val(`SELECT COALESCE(sum(amount_kobo),0) FROM settlement_lines WHERE farmer_id=$1 AND party='farmer' AND paid_at IS NULL`, farmerId));
  const paid = Number(await db.val(`SELECT COALESCE(sum(amount_kobo),0) FROM settlement_lines WHERE farmer_id=$1 AND party='farmer' AND paid_at IS NOT NULL`, farmerId));
  return { deliveries, receipts, loans, sales, owed, paid };
}
