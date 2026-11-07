// Valuation (Build 6). Every receipt gets a dated value that can be explained line by line:
//   reference price = median of approved market prices for the crop over the last N days (the warehouse's state
//   if there are enough, otherwise national); market value = kg still held × reference price;
//   lending value = market value − haircut; maximum loan = lending value × loan-to-value.
// Prices are entered by one person and approved by another. Lenders can set their own haircut and loan-to-value.
import { db, tx } from './db';
import { audit, systemActor } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { saveFile } from './files';
import { getSettings } from './settings';
import { toKobo, valueKobo, bpOf } from './money';
import { clean } from './util';
import { LIVE } from './stock';
import type { Upload } from './http';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';
export const UNITS: Record<string, { label: string; kg: number }> = {
  kg: { label: 'per kg', kg: 1 }, bag_50kg: { label: 'per 50 kg bag', kg: 50 }, bag_100kg: { label: 'per 100 kg bag', kg: 100 }, tonne: { label: 'per tonne', kg: 1000 },
};
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

export function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

export interface RefPrice { kobo_per_kg: number | null; scope: 'state' | 'national' | 'none'; state: string | null; window_days: number; from: string; to: string; observations: { id: string; market: string; state: string | null; source: string; on: string; kobo_per_kg: number }[] }

/** The reference price for a crop on a date: state median if enough approved prices, else national, else none. */
export async function referencePrice(commodity: string, state: string | null, on = new Date()): Promise<RefPrice> {
  const s = await getSettings();
  const win = s['price.window_days'], min = s['price.min_observations'];
  const to = ymd(on), from = ymd(new Date(on.getTime() - (win - 1) * 86_400_000));
  const rows = await db.all<{ id: string; market: string; state_code: string | null; source: string; observed_on: Date; kobo_per_kg: string }>(
    `SELECT o.id, o.market, o.state_code, ps.name AS source, o.observed_on, o.kobo_per_kg FROM price_observations o JOIN price_sources ps ON ps.id=o.source_id
     WHERE o.commodity_code=$1 AND o.status='approved' AND o.observed_on BETWEEN $2::date AND $3::date ORDER BY o.observed_on DESC`, commodity, from, to);
  const shape = (r: (typeof rows)[number]) => ({ id: r.id, market: r.market, state: r.state_code, source: r.source, on: ymd(new Date(r.observed_on)), kobo_per_kg: Number(r.kobo_per_kg) });
  const local = state ? rows.filter((r) => r.state_code === state) : [];
  if (local.length >= min) return { kobo_per_kg: median(local.map((r) => Number(r.kobo_per_kg))), scope: 'state', state, window_days: win, from, to, observations: local.map(shape) };
  if (rows.length >= min) return { kobo_per_kg: median(rows.map((r) => Number(r.kobo_per_kg))), scope: 'national', state, window_days: win, from, to, observations: rows.map(shape) };
  return { kobo_per_kg: null, scope: 'none', state, window_days: win, from, to, observations: rows.map(shape) };
}

// ---------- prices ----------
export async function addObservation(a: Actor, i: Record<string, string>, evidence?: Upload) {
  if (!isKitovu(a) || !(can(a.membership, 'finance.configure') || can(a.membership, 'stock.manage'))) throw new UserError('Only Kitovu finance or operations staff enter prices.');
  const com = await db.get<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE code=$1 AND storable', i.commodity);
  if (!com) throw new UserError('Choose the crop.');
  const state = clean(i.state, 2).toUpperCase() || null;
  if (state && !(await db.val('SELECT 1 FROM states WHERE code=$1', state))) throw new UserError('Choose a state.');
  const market = clean(i.market, 120);
  if (market.length < 3) throw new UserError('Name the market or buyer.');
  const src = await db.get<{ id: string }>('SELECT id FROM price_sources WHERE id=$1 AND active', i.source);
  if (!src) throw new UserError('Choose where the price came from.');
  const unit = UNITS[i.unit];
  if (!unit) throw new UserError('Choose the unit the price was quoted in.');
  let quoted: number;
  try { quoted = toKobo(i.price); } catch { throw new UserError('Enter the price in naira, e.g. 45000.'); }
  if (quoted <= 0) throw new UserError('The price must be more than zero.');
  const perKg = Math.round(quoted / unit.kg);
  const on = i.observed_on ? new Date(i.observed_on + 'T12:00:00+01:00') : new Date();
  if (isNaN(on.getTime()) || on.getTime() > Date.now() + 86_400_000) throw new UserError('The date cannot be in the future.');
  if (Date.now() - on.getTime() > 60 * 86_400_000) throw new UserError('Prices older than 60 days are not useful for valuation.');
  const ref = await referencePrice(com.code, state);
  const outlier = ref.kobo_per_kg ? Math.round(((perKg - ref.kobo_per_kg) / ref.kobo_per_kg) * 1000) / 10 : null;
  const s = await getSettings();
  const note = clean(i.note, 300);
  if (outlier !== null && Math.abs(outlier) > s['price.outlier_pct'] && note.length < 10)
    throw new UserError(`This is ${outlier > 0 ? '+' : ''}${outlier}% against the current reference price. Explain in the note why (e.g. new harvest, different grade).`);
  return tx(async () => {
    const id = (await db.val<string>(
      `INSERT INTO price_observations (commodity_code, state_code, market, source_id, observed_on, unit, price_quoted_kobo, kobo_per_kg, note, outlier_pct, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, com.code, state, market, src.id, ymd(on), i.unit, quoted, perKg, note || null, outlier, a.user.id))!;
    if (evidence) {
      const fid = await saveFile(evidence, { kind: 'price_evidence', entity: 'price', entityId: id, userId: a.user.id, allowPdf: true, label: 'Evidence' });
      await db.run('UPDATE price_observations SET evidence_file_id=$2 WHERE id=$1', id, fid);
    }
    await audit(actorOf(a), 'price.entered', { entity: 'price', entityId: id, data: { commodity: com.code, state, kobo_per_kg: perKg, outlier_pct: outlier } });
    return { id, perKg, outlier };
  });
}

export async function decideObservation(a: Actor, id: string, approve: boolean, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'finance.configure')) throw new UserError('Only Kitovu finance approves prices.');
  const o = await db.get<{ entered_by: string; status: string; outlier_pct: string | null }>('SELECT entered_by, status, outlier_pct FROM price_observations WHERE id=$1', id);
  if (!o || o.status !== 'pending') throw new UserError('This price was already decided.');
  if (o.entered_by === a.user.id) throw new UserError('You entered this price, so someone else must approve it.');
  if (!approve && clean(note).length < 3) throw new UserError('Say why it is rejected.');
  await db.run(`UPDATE price_observations SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, id, approve ? 'approved' : 'rejected', a.user.id, clean(note, 300) || null);
  await audit(actorOf(a), approve ? 'price.approved' : 'price.rejected', { entity: 'price', entityId: id });
}

export async function addSource(a: Actor, name: string, kind: string, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'finance.configure')) throw new UserError('Only Kitovu finance adds price sources.');
  const n = clean(name, 80);
  if (n.length < 3) throw new UserError('Name the source.');
  if (!['market_survey', 'buyer_offer', 'exchange', 'government', 'other'].includes(kind)) throw new UserError('Choose the kind of source.');
  if (await db.val('SELECT 1 FROM price_sources WHERE lower(name)=lower($1)', n)) throw new UserError('That source already exists.');
  await db.run('INSERT INTO price_sources (name, kind, note, created_by) VALUES ($1,$2,$3,$4)', n, kind, clean(note, 200) || null, a.user.id);
}

export async function pricesOverview() {
  const coms = await db.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE storable ORDER BY name');
  const out = [];
  for (const c of coms) {
    const nat = await referencePrice(c.code, null);
    const week = await referencePrice(c.code, null, new Date(Date.now() - 7 * 86_400_000));
    const states = await db.all<{ state_code: string; name: string }>(
      `SELECT DISTINCT o.state_code, s.name FROM price_observations o JOIN states s ON s.code=o.state_code WHERE o.commodity_code=$1 AND o.status='approved' AND o.observed_on > current_date - 60 ORDER BY s.name`, c.code);
    const byState = [];
    for (const st of states) { const r = await referencePrice(c.code, st.state_code); if (r.scope === 'state') byState.push({ state: st.name, kobo_per_kg: r.kobo_per_kg, n: r.observations.length }); }
    out.push({ ...c, national: nat, change_bp: nat.kobo_per_kg && week.kobo_per_kg ? Math.round(((nat.kobo_per_kg - week.kobo_per_kg) / week.kobo_per_kg) * 10000) : null, byState });
  }
  return out;
}
export const recentObservations = () => db.all<any>(
  `SELECT o.*, o.kobo_per_kg::float AS kpk, o.price_quoted_kobo::float AS quoted, c.name AS commodity, s.name AS state_name, ps.name AS source, u.full_name AS enterer, d.full_name AS decider
   FROM price_observations o JOIN commodities c ON c.code=o.commodity_code LEFT JOIN states s ON s.code=o.state_code JOIN price_sources ps ON ps.id=o.source_id
     JOIN users u ON u.id=o.entered_by LEFT JOIN users d ON d.id=o.decided_by ORDER BY (o.status='pending') DESC, o.entered_at DESC LIMIT 100`);
export const sources = () => db.all<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM price_sources WHERE active ORDER BY name');

// ---------- policies ----------
export async function policyFor(orgId: string | null, commodity: string) {
  const own = orgId ? await db.get<{ haircut_bp: number; max_ltv_bp: number }>('SELECT haircut_bp, max_ltv_bp FROM valuation_policies WHERE org_id=$1 AND commodity_code=$2', orgId, commodity) : undefined;
  const def = await db.get<{ haircut_bp: number; max_ltv_bp: number }>('SELECT haircut_bp, max_ltv_bp FROM valuation_policies WHERE org_id IS NULL AND commodity_code=$1', commodity);
  const p = own ?? def ?? { haircut_bp: 1500, max_ltv_bp: 7000 };
  return { ...p, own: !!own };
}
const policyOrg = (a: Actor) => (isKitovu(a) ? null : a.membership!.org_id);
export async function policies(a: Actor) {
  if (!can(a.membership, 'finance.view')) throw new UserError('Not allowed.');
  const coms = await db.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE storable ORDER BY name');
  const out = [];
  for (const c of coms) out.push({ ...c, ...(await policyFor(policyOrg(a), c.code)) });
  return out;
}
export async function setPolicy(a: Actor, commodity: string, haircutPct: string, ltvPct: string) {
  if (!can(a.membership, 'finance.configure') || !['kitovu', 'lender'].includes(a.membership!.org_kind)) throw new UserError('Only finance administrators set valuation policy.');
  const h = Math.round(Number(haircutPct) * 100), l = Math.round(Number(ltvPct) * 100);
  if (!(h >= 0 && h <= 9000)) throw new UserError('Haircut must be between 0% and 90%.');
  if (!(l >= 0 && l <= 10000)) throw new UserError('Loan-to-value must be between 0% and 100%.');
  if (!(await db.val('SELECT 1 FROM commodities WHERE code=$1 AND storable', commodity))) throw new UserError('Unknown crop.');
  const org = policyOrg(a);
  await db.run(`INSERT INTO valuation_policies (org_id, commodity_code, haircut_bp, max_ltv_bp, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), commodity_code) DO UPDATE SET haircut_bp=EXCLUDED.haircut_bp, max_ltv_bp=EXCLUDED.max_ltv_bp, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    org, commodity, h, l, a.user.id);
  await audit(actorOf(a), 'valuation.policy_set', { orgId: org ?? undefined, data: { commodity, haircut_bp: h, max_ltv_bp: l } });
}

// ---------- valuing receipts ----------
export function compute(heldKg: number, ref: RefPrice, p: { haircut_bp: number; max_ltv_bp: number }) {
  if (!ref.kobo_per_kg) return { market: null, lending: null, maxLoan: null };
  const market = valueKobo(heldKg, ref.kobo_per_kg);
  const lending = market - Math.ceil((market * p.haircut_bp) / 10_000);   // haircut rounds up, advance rounds down: never over-lend
  return { market, lending, maxLoan: bpOf(lending, p.max_ltv_bp) };
}

interface LiveReceipt { id: string; receipt_no: string; commodity_code: string; state_code: string; remaining_kg: string }
const liveReceipts = () => db.all<LiveReceipt>(
  `SELECT r.id, r.receipt_no, r.commodity_code, w.state_code, b.remaining_kg FROM receipts r JOIN warehouses w ON w.id=r.warehouse_id JOIN receipt_balances b ON b.receipt_id=r.id
   WHERE r.status::text = ANY($1) AND b.remaining_kg > 0`, LIVE);

/** Daily: snapshot every live receipt with Kitovu's default policy. Safe to run more than once a day. */
export async function revalueAll(on = new Date()) {
  const day = ymd(on), s = await getSettings();
  const rs = await liveReceipts();
  const cache = new Map<string, RefPrice>();
  let valued = 0, unpriced = 0; const drops: { receipt_no: string; change_pct: number }[] = [];
  for (const r of rs) {
    const key = `${r.commodity_code}:${r.state_code}`;
    if (!cache.has(key)) cache.set(key, await referencePrice(r.commodity_code, r.state_code, on));
    const ref = cache.get(key)!;
    const pol = await policyFor(null, r.commodity_code);
    const v = compute(Number(r.remaining_kg), ref, pol);
    const prev = await db.get<{ kobo_per_kg: string | null }>('SELECT kobo_per_kg FROM receipt_valuations WHERE receipt_id=$1 AND valued_on < $2 ORDER BY valued_on DESC LIMIT 1', r.id, day);
    const change = prev?.kobo_per_kg && ref.kobo_per_kg ? Math.round(((ref.kobo_per_kg - Number(prev.kobo_per_kg)) / Number(prev.kobo_per_kg)) * 10000) : null;
    const n = await db.run(
      `INSERT INTO receipt_valuations (receipt_id, valued_on, held_kg, kobo_per_kg, market_value_kobo, haircut_bp, max_ltv_bp, lending_value_kobo, max_loan_kobo, basis, change_bp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (receipt_id, valued_on) DO NOTHING`,
      r.id, day, r.remaining_kg, ref.kobo_per_kg, v.market, pol.haircut_bp, pol.max_ltv_bp, v.lending, v.maxLoan,
      JSON.stringify({ scope: ref.scope, state: ref.state, window_days: ref.window_days, from: ref.from, to: ref.to, observations: ref.observations.map((o) => o.id), median_kobo_per_kg: ref.kobo_per_kg }), change);
    if (!n) continue;
    await db.run('UPDATE receipts SET unit_price_kobo=$2, value_kobo=$3 WHERE id=$1', r.id, ref.kobo_per_kg, v.market);
    if (ref.kobo_per_kg) valued++; else unpriced++;
    if (change !== null && change <= -s['price.drop_alert_pct'] * 100) drops.push({ receipt_no: r.receipt_no, change_pct: change / 100 });
  }
  await audit(systemActor('revalue'), 'valuation.daily', { data: { day, valued, unpriced, drops: drops.length } });
  return { day, valued, unpriced, drops };
}

/** A receipt's value as the viewer should see it: their own policy if they are a lender with one, else Kitovu's. */
export async function valuationFor(a: Actor, r: { id: string; commodity_code: string; warehouse_id: string }) {
  if (!can(a.membership, 'finance.view')) return null;
  const st = (await db.val<string>('SELECT state_code FROM warehouses WHERE id=$1', r.warehouse_id))!;
  const held = Number(await db.val('SELECT remaining_kg FROM receipt_balances WHERE receipt_id=$1', r.id));
  const ref = await referencePrice(r.commodity_code, st);
  const pol = await policyFor(policyOrg(a), r.commodity_code);
  const v = compute(held, ref, pol);
  const history = await db.all<{ valued_on: Date; kobo_per_kg: string | null; market_value_kobo: string | null; change_bp: number | null }>(
    'SELECT valued_on, kobo_per_kg, market_value_kobo, change_bp FROM receipt_valuations WHERE receipt_id=$1 ORDER BY valued_on DESC LIMIT 30', r.id);
  return { held, ref, policy: pol, ...v, history };
}
