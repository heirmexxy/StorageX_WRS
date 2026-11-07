// Stock control (Build 5). Every kilo that enters or leaves a warehouse is a row in stock_moves; balances are
// sums. Receipts say who owns the stock; the ledger and physical counts say whether it is really there.
import crypto from 'node:crypto';
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { saveFile } from './files';
import { sendSms } from './sms';
import { getSettings } from './settings';
import { clean } from './util';
import type { Upload } from './http';

const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';
const r2 = (n: number) => Math.round(n * 100) / 100;
export const LIVE = ['issued', 'partially_released', 'pledged', 'financed', 'sale_approved', 'under_exception'];
function needStock(a: Actor) { if (!can(a.membership, 'stock.manage')) throw new UserError('Your role cannot manage stock.'); }

async function warehouseFor(a: Actor, whId: string) {
  needStock(a);
  const w = await db.get<{ id: string; code: string; name: string; operator_org_id: string; status: string }>('SELECT id, code, name, operator_org_id, status FROM warehouses WHERE id=$1', whId);
  if (!w || (!isKitovu(a) && w.operator_org_id !== a.membership!.org_id)) throw new UserError('Warehouse not found.');
  return w;
}
export const warehouseByCode = async (a: Actor, code: string) => {
  const id = await db.val<string>('SELECT id FROM warehouses WHERE code=upper($1)', clean(code, 20));
  return id ? warehouseFor(a, id) : undefined;
};

// ---------- placing accepted deliveries ----------
/** Called when a delivery is accepted: the stock enters the ledger, on the stack the clerk named if it exists or can be made. */
export async function placeIntake(userId: string, i: { id: string; warehouse_id: string; commodity_code: string; net_kg: number | string; bags: number; stack_ref: string | null }) {
  let stackId: string | null = null;
  const code = clean(i.stack_ref, 30).toUpperCase();
  if (code) {
    const s = await db.get<{ id: string; commodity_code: string; status: string }>('SELECT id, commodity_code, status FROM stacks WHERE warehouse_id=$1 AND code=$2', i.warehouse_id, code);
    if (!s) stackId = (await db.val<string>(`INSERT INTO stacks (warehouse_id, code, commodity_code, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, i.warehouse_id, code, i.commodity_code, userId))!;
    else if (s.commodity_code === i.commodity_code && s.status === 'open') stackId = s.id;
  }
  await db.run(`INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, created_by) VALUES ($1,$2,$3,'in',$4,$5,'intake',$6,$7)
    ON CONFLICT DO NOTHING`, i.warehouse_id, i.commodity_code, stackId, i.net_kg, i.bags, i.id, userId);
}

// ---------- views ----------
export async function overview(a: Actor) {
  needStock(a);
  return db.all<any>(
    `SELECT w.id, w.code, w.name, w.status,
       COALESCE((SELECT sum(kg) FROM stock_moves m WHERE m.warehouse_id=w.id), 0)::float AS book_kg,
       COALESCE((SELECT sum(b.remaining_kg) FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id WHERE r.warehouse_id=w.id AND r.status::text = ANY($2)), 0)::float AS owed_kg,
       (SELECT max(counted_at) FROM stock_counts c WHERE c.warehouse_id=w.id) AS last_count,
       (SELECT count(*)::int FROM stock_adjustments x WHERE x.warehouse_id=w.id AND x.status='proposed') AS pending_adj,
       (SELECT count(*)::int FROM releases x JOIN receipts r ON r.id=x.receipt_id WHERE r.warehouse_id=w.id AND x.status='ordered') AS pending_rel
     FROM warehouses w WHERE w.status <> 'closed' AND ($1::uuid IS NULL OR w.operator_org_id=$1) ORDER BY w.name`,
    isKitovu(a) ? null : a.membership!.org_id, LIVE);
}

export async function stacksOf(whId: string) {
  return db.all<any>(
    `SELECT s.id, s.code, s.commodity_code, c.name AS commodity, s.status,
       COALESCE((SELECT sum(kg) FROM stock_moves m WHERE m.stack_id=s.id), 0)::float AS kg,
       COALESCE((SELECT sum(bags) FROM stock_moves m WHERE m.stack_id=s.id), 0)::int AS bags,
       lc.est_kg::float AS count_kg, lc.bags_counted AS count_bags, lc.counted_at, lc.book_kg::float AS count_book_kg
     FROM stacks s JOIN commodities c ON c.code=s.commodity_code
       LEFT JOIN LATERAL (SELECT * FROM stock_counts k WHERE k.stack_id=s.id ORDER BY counted_at DESC LIMIT 1) lc ON true
     WHERE s.warehouse_id=$1 ORDER BY s.status, s.code`, whId);
}

/** Per commodity: what the ledger says is there, what receipts say is owed, and what was last counted. */
export async function reconcile(whId: string) {
  const s = await getSettings();
  const tol = s['stock.tolerance_pct'], maxAge = s['stock.count_every_days'];
  const rows = await db.all<any>(
    `WITH book AS (SELECT commodity_code, sum(kg)::float AS kg, sum(bags)::int AS bags, COALESCE(sum(kg) FILTER (WHERE stack_id IS NULL), 0)::float AS unplaced FROM stock_moves WHERE warehouse_id=$1 GROUP BY 1),
          owed AS (SELECT r.commodity_code, sum(b.remaining_kg)::float AS kg, count(*)::int AS n,
                          count(*) FILTER (WHERE r.status='under_exception')::int AS under_review
                   FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id WHERE r.warehouse_id=$1 AND r.status::text = ANY($2) GROUP BY 1),
          lastc AS (SELECT DISTINCT ON (k.stack_id) k.stack_id, k.est_kg, k.counted_at FROM stock_counts k WHERE k.warehouse_id=$1 ORDER BY k.stack_id, k.counted_at DESC),
          -- A count is carried forward by the moves on its stack since it was taken (e.g. a release after the count).
          counted AS (SELECT s.commodity_code, sum(lc.est_kg + COALESCE((SELECT sum(m.kg) FROM stock_moves m WHERE m.stack_id=s.id AND m.created_at > lc.counted_at), 0))::float AS kg, min(lc.counted_at) AS oldest,
                             count(*) FILTER (WHERE lc.counted_at IS NULL OR lc.counted_at < now() - ($3 || ' days')::interval)::int AS stale
                      FROM stacks s LEFT JOIN lastc lc ON lc.stack_id=s.id
                      WHERE s.warehouse_id=$1 AND s.status='open' AND COALESCE((SELECT sum(kg) FROM stock_moves m WHERE m.stack_id=s.id),0) > 0 GROUP BY 1)
     SELECT c.code AS commodity_code, c.name AS commodity, COALESCE(book.kg,0) AS book_kg, COALESCE(book.bags,0) AS book_bags, COALESCE(book.unplaced,0) AS unplaced_kg,
            COALESCE(owed.kg,0) AS owed_kg, COALESCE(owed.n,0) AS receipts, COALESCE(owed.under_review,0) AS under_review,
            counted.kg AS counted_kg, counted.oldest, COALESCE(counted.stale,0) AS stale_stacks
     FROM commodities c LEFT JOIN book ON book.commodity_code=c.code LEFT JOIN owed ON owed.commodity_code=c.code LEFT JOIN counted ON counted.commodity_code=c.code
     WHERE book.kg IS NOT NULL OR owed.kg IS NOT NULL ORDER BY c.name`, whId, LIVE, String(maxAge));
  return rows.map((r) => {
    const flags: { severity: 'hold' | 'review'; text: string }[] = [];
    if (r.owed_kg > r.book_kg + 0.5) flags.push({ severity: 'hold', text: `Receipts claim ${r2(r.owed_kg)} kg but the ledger holds ${r2(r.book_kg)} kg.` });
    if (r.counted_kg !== null && r.counted_kg !== undefined && r.unplaced_kg < 0.5 && r.stale_stacks === 0 && r.counted_kg < r.owed_kg * (1 - tol / 100))
      flags.push({ severity: 'hold', text: `Last counts total ${r2(r.counted_kg)} kg, ${r2(r.owed_kg - r.counted_kg)} kg short of what receipts claim (tolerance ${tol}%).` });
    if (r.unplaced_kg > 0.5) flags.push({ severity: 'review', text: `${r2(r.unplaced_kg)} kg is not on any stack yet. Place it so it can be counted.` });
    if (r.stale_stacks > 0) flags.push({ severity: 'review', text: `${r.stale_stacks} stack(s) not counted in the last ${maxAge} days.` });
    return { ...r, flags };
  });
}

export const pendingAdjustments = (whId: string) => db.all<any>(
  `SELECT x.*, x.kg::float AS kgf, s.code AS stack_code, u.full_name AS proposer FROM stock_adjustments x JOIN stacks s ON s.id=x.stack_id JOIN users u ON u.id=x.proposed_by
   WHERE x.warehouse_id=$1 ORDER BY x.status='proposed' DESC, x.proposed_at DESC LIMIT 50`, whId);
export const releasesAt = (whId: string) => db.all<any>(
  `SELECT x.*, x.kg_ordered::float AS ordered, x.kg_loaded::float AS loaded, r.receipt_no, c.name AS commodity, f.full_name AS owner, u.full_name AS orderer
   FROM releases x JOIN receipts r ON r.id=x.receipt_id JOIN commodities c ON c.code=r.commodity_code LEFT JOIN farmers f ON f.id=r.owner_farmer_id JOIN users u ON u.id=x.ordered_by
   WHERE r.warehouse_id=$1 ORDER BY x.status='ordered' DESC, x.ordered_at DESC LIMIT 50`, whId);
export const movesOf = (whId: string) => db.all<any>(
  `SELECT m.*, m.kg::float AS kgf, s.code AS stack_code, c.name AS commodity, u.full_name AS by_name,
     CASE m.ref_type WHEN 'intake' THEN (SELECT ref FROM intakes WHERE id=m.ref_id) WHEN 'release' THEN (SELECT ref FROM releases WHERE id=m.ref_id) END AS ref
   FROM stock_moves m LEFT JOIN stacks s ON s.id=m.stack_id JOIN commodities c ON c.code=m.commodity_code LEFT JOIN users u ON u.id=m.created_by
   WHERE m.warehouse_id=$1 ORDER BY m.id DESC LIMIT 100`, whId);

// ---------- stacks, transfers, counts ----------
const stackBal = async (id: string) => db.get<{ kg: number; bags: number }>(`SELECT COALESCE(sum(kg),0)::float AS kg, COALESCE(sum(bags),0)::int AS bags FROM stock_moves WHERE stack_id=$1`, id);
const unplacedBal = async (whId: string, com: string) => db.get<{ kg: number; bags: number }>(`SELECT COALESCE(sum(kg),0)::float AS kg, COALESCE(sum(bags),0)::int AS bags FROM stock_moves WHERE warehouse_id=$1 AND commodity_code=$2 AND stack_id IS NULL`, whId, com);

export async function createStack(a: Actor, whId: string, code: string, commodity: string, note?: string) {
  const w = await warehouseFor(a, whId);
  const c = clean(code, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9\-/ ]{0,29}$/.test(c)) throw new UserError('Use the code painted on the stack card, e.g. B2-S1.');
  if (!(await db.val('SELECT 1 FROM commodities WHERE code=$1', commodity))) throw new UserError('Choose the crop.');
  if (await db.val('SELECT 1 FROM stacks WHERE warehouse_id=$1 AND code=$2', w.id, c)) throw new UserError(`Stack ${c} already exists here.`);
  const id = await db.val<string>(`INSERT INTO stacks (warehouse_id, code, commodity_code, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, w.id, c, commodity, clean(note, 200) || null, a.user.id);
  await audit(actorOf(a), 'stock.stack_created', { orgId: w.operator_org_id, entity: 'stack', entityId: id!, data: { warehouse: w.code, code: c } });
}

/** Move stock between stacks (or from "not on a stack") in the same warehouse and crop. */
export async function transfer(a: Actor, whId: string, i: { from?: string; to?: string; kg?: string; bags?: string; note?: string }) {
  const w = await warehouseFor(a, whId);
  const kg = Number(i.kg), bags = Number(i.bags || 0);
  if (!(kg > 0) || !Number.isInteger(bags) || bags < 0) throw new UserError('Enter the kilograms (and bags) moved.');
  const to = await db.get<{ id: string; commodity_code: string; status: string }>('SELECT id, commodity_code, status FROM stacks WHERE id=$1 AND warehouse_id=$2', i.to, w.id);
  if (!to || to.status !== 'open') throw new UserError('Choose an open stack to move to.');
  const from = i.from && i.from !== 'unplaced' ? await db.get<{ id: string; commodity_code: string }>('SELECT id, commodity_code FROM stacks WHERE id=$1 AND warehouse_id=$2', i.from, w.id) : null;
  if (i.from && i.from !== 'unplaced' && !from) throw new UserError('Choose the stack to move from.');
  if (from && from.id === to.id) throw new UserError('Choose two different stacks.');
  const com = from ? from.commodity_code : to.commodity_code;
  if (com !== to.commodity_code) throw new UserError('Both stacks must hold the same crop.');
  await tx(async () => {
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'stock:' + w.id);
    const bal = from ? await stackBal(from.id) : await unplacedBal(w.id, com);
    if (bal!.kg + 0.001 < kg) throw new UserError(`Only ${r2(bal!.kg)} kg is there to move.`);
    const ref = crypto.randomUUID();
    await db.run(`INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, note, created_by) VALUES ($1,$2,$3,'transfer_out',$4,$5,'transfer',$6,$7,$8)`,
      w.id, com, from?.id ?? null, -kg, -bags, ref, clean(i.note, 200) || null, a.user.id);
    await db.run(`INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, note, created_by) VALUES ($1,$2,$3,'transfer_in',$4,$5,'transfer',$6,$7,$8)`,
      w.id, com, to.id, kg, bags, ref, clean(i.note, 200) || null, a.user.id);
    await audit(actorOf(a), 'stock.transfer', { orgId: w.operator_org_id, entity: 'warehouse', entityId: w.id, data: { from: from?.id ?? 'unplaced', to: to.id, kg, bags } });
  });
}

/** A count: bags counted on the stack, and a sample of bags weighed to estimate the total weight. */
export async function recordCount(a: Actor, whId: string, i: { stack?: string; bags?: string; sample_bags?: string; sample_kg?: string; note?: string }, photo?: Upload) {
  const w = await warehouseFor(a, whId);
  const s = await db.get<{ id: string; code: string }>('SELECT id, code FROM stacks WHERE id=$1 AND warehouse_id=$2', i.stack, w.id);
  if (!s) throw new UserError('Choose the stack you counted.');
  const bags = Number(i.bags), sb = Number(i.sample_bags || 0), skg = Number(i.sample_kg || 0);
  if (!Number.isInteger(bags) || bags < 0) throw new UserError('Enter the number of bags counted.');
  const bal = (await stackBal(s.id))!;
  let est: number;
  if (bags === 0) est = 0;
  else if (sb > 0 && skg > 0) {
    if (!Number.isInteger(sb) || sb > bags) throw new UserError('Sample bags must be a whole number, not more than the bags counted.');
    est = r2((skg / sb) * bags);
  } else {
    if (!bal.bags) throw new UserError('Weigh a sample of bags: the ledger has no bag count to estimate from.');
    est = r2((bal.kg / bal.bags) * bags);   // no sample: use the ledger's average bag weight
  }
  await tx(async () => {
    const photoId = photo ? await saveFile(photo, { kind: 'stock_evidence', entity: 'stack', entityId: s.id, userId: a.user.id, label: 'Photo of the stack' }) : null;
    await db.run(`INSERT INTO stock_counts (warehouse_id, stack_id, bags_counted, sample_bags, sample_kg, est_kg, book_kg, book_bags, photo_id, counted_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      w.id, s.id, bags, sb || null, skg || null, est, bal.kg, bal.bags, photoId, a.user.id, clean(i.note, 300) || null);
    await audit(actorOf(a), 'stock.counted', { orgId: w.operator_org_id, entity: 'stack', entityId: s.id, data: { stack: s.code, bags, est_kg: est, book_kg: bal.kg } });
  });
  return { est, book: bal.kg, diff: r2(est - bal.kg) };
}

export async function proposeAdjustment(a: Actor, whId: string, i: { stack?: string; kg?: string; bags?: string; reason?: string; note?: string }, photo?: Upload) {
  const w = await warehouseFor(a, whId);
  const s = await db.get<{ id: string; code: string }>('SELECT id, code FROM stacks WHERE id=$1 AND warehouse_id=$2', i.stack, w.id);
  if (!s) throw new UserError('Choose the stack.');
  const kg = Number(i.kg), bags = Number(i.bags || 0);
  if (!kg || !Number.isFinite(kg) || !Number.isInteger(bags)) throw new UserError('Enter the change in kg: negative for a loss (e.g. -25), positive for a gain found on recount.');
  if (!['moisture_loss', 'pest_damage', 'spillage', 'theft', 'recount_correction', 'other'].includes(String(i.reason))) throw new UserError('Choose a reason.');
  if (kg > 0 && i.reason !== 'recount_correction') throw new UserError('Only a recount correction can add stock.');
  const note = clean(i.note, 400);
  if (note.length < 10) throw new UserError('Describe what happened in a sentence.');
  const bal = (await stackBal(s.id))!;
  if (bal.kg + kg < -0.001) throw new UserError(`The stack only holds ${r2(bal.kg)} kg.`);
  await tx(async () => {
    const photoId = photo ? await saveFile(photo, { kind: 'stock_evidence', entity: 'stack', entityId: s.id, userId: a.user.id, label: 'Photo' }) : null;
    const id = await db.val<string>(`INSERT INTO stock_adjustments (warehouse_id, stack_id, kg, bags, reason, note, photo_id, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      w.id, s.id, kg, bags, i.reason, note, photoId, a.user.id);
    await audit(actorOf(a), 'stock.adjustment_proposed', { orgId: w.operator_org_id, entity: 'stock_adjustment', entityId: id!, data: { stack: s.code, kg, reason: i.reason } });
  });
}

export async function decideAdjustment(a: Actor, id: string, approve: boolean, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'stock.manage')) throw new UserError('Only Kitovu operations approve stock adjustments.');
  const x = await db.get<any>(`SELECT x.*, s.commodity_code FROM stock_adjustments x JOIN stacks s ON s.id=x.stack_id WHERE x.id=$1`, id);
  if (!x || x.status !== 'proposed') throw new UserError('This adjustment was already decided.');
  if (x.proposed_by === a.user.id) throw new UserError('You proposed this adjustment, so someone else must decide it.');
  if (!approve && clean(note).length < 3) throw new UserError('Say why it is rejected.');
  await tx(async () => {
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'stock:' + x.warehouse_id);
    if (approve) {
      const bal = (await stackBal(x.stack_id))!;
      if (bal.kg + Number(x.kg) < -0.001) throw new UserError(`The stack now holds only ${r2(bal.kg)} kg.`);
      await db.run(`INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, note, created_by) VALUES ($1,$2,$3,'adjust',$4,$5,'adjustment',$6,$7,$8)`,
        x.warehouse_id, x.commodity_code, x.stack_id, x.kg, x.bags, x.id, `${x.reason}: ${x.note}`, a.user.id);
    }
    await db.run(`UPDATE stock_adjustments SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, id, approve ? 'approved' : 'rejected', a.user.id, clean(note, 300) || null);
    await audit(actorOf(a), `stock.adjustment_${approve ? 'approved' : 'rejected'}`, { entity: 'stock_adjustment', entityId: id, data: { kg: Number(x.kg), reason: x.reason } });
  });
}

// ---------- releases (withdrawals against receipts) ----------
export const receiptBalance = (receiptId: string) => db.get<{ remaining_kg: number; released_kg: number }>(
  'SELECT remaining_kg::float, released_kg::float FROM receipt_balances WHERE receipt_id=$1', receiptId);

export async function orderRelease(a: Actor, receiptNo: string, i: { kg?: string; reason?: string; collector_name?: string; collector_phone?: string; note?: string }) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt rights order releases.');
  const r = await db.get<{ id: string; receipt_no: string; status: string; warehouse_id: string }>('SELECT id, receipt_no, status::text, warehouse_id FROM receipts WHERE receipt_no=upper($1)', clean(receiptNo, 40));
  if (!r) throw new UserError('Receipt not found.');
  if (!['issued', 'partially_released'].includes(r.status)) throw new UserError(`Stock cannot be released against a receipt that is ${r.status.replace(/_/g, ' ')}.`);
  const reason = String(i.reason);
  if (!['owner_withdrawal', 'sale_delivery', 'other'].includes(reason)) throw new UserError('Choose why the stock is leaving.');
  const bal = (await receiptBalance(r.id))!;
  const pending = Number(await db.val(`SELECT COALESCE(sum(kg_ordered),0) FROM releases WHERE receipt_id=$1 AND status='ordered'`, r.id));
  const kg = i.kg ? Number(i.kg) : r2(bal.remaining_kg - pending);
  if (!(kg > 0) || kg > bal.remaining_kg - pending + 0.001) throw new UserError(`At most ${r2(bal.remaining_kg - pending)} kg can be released on this receipt.`);
  const name = clean(i.collector_name, 120);
  if (name.length < 3) throw new UserError('Enter the name of the person collecting.');
  return tx(async () => {
    const ymd = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', year: '2-digit', month: '2-digit', day: '2-digit' }).split('/').reverse().join('');
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'rel:' + ymd);
    const ref = `REL-${ymd}-${String(Number(await db.val(`SELECT count(*) FROM releases WHERE ref LIKE $1`, `REL-${ymd}-%`)) + 1).padStart(3, '0')}`;
    const id = await db.val<string>(`INSERT INTO releases (ref, receipt_id, kg_ordered, reason, collector_name, collector_phone, ordered_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      ref, r.id, r2(kg), reason, name, clean(i.collector_phone, 20) || null, a.user.id, clean(i.note, 300) || null);
    await audit(actorOf(a), 'release.ordered', { entity: 'receipt', entityId: r.id, data: { ref, receipt_no: r.receipt_no, kg: r2(kg), reason } });
    return { id: id!, ref };
  });
}

export async function releaseByRef(a: Actor, ref: string) {
  needStock(a);
  const x = await db.get<any>(
    `SELECT x.*, x.kg_ordered::float AS ordered, x.kg_loaded::float AS loaded, r.receipt_no, r.id AS rid, r.status::text AS receipt_status, r.warehouse_id, r.commodity_code,
       c.name AS commodity, w.name AS wh_name, w.operator_org_id, f.full_name AS owner, f.code AS owner_code, f.phone_e164, f.phone_verified_at, u.full_name AS orderer, lu.full_name AS loader
     FROM releases x JOIN receipts r ON r.id=x.receipt_id JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id
       LEFT JOIN farmers f ON f.id=r.owner_farmer_id JOIN users u ON u.id=x.ordered_by LEFT JOIN users lu ON lu.id=x.loaded_by WHERE x.ref=upper($1)`, clean(ref, 30));
  if (!x || (!isKitovu(a) && x.operator_org_id !== a.membership!.org_id)) return undefined;
  return x;
}

/** At the gate: weigh the stock out, photograph the scale and the signed release slip. Closes or reduces the receipt. */
export async function confirmLoading(a: Actor, ref: string, i: { stack?: string; kg?: string; bags?: string; note?: string }, files: { scale?: Upload; slip?: Upload }) {
  const x = await releaseByRef(a, ref);
  if (!x) throw new UserError('Release not found.');
  if (x.status !== 'ordered') throw new UserError(`This release is already ${x.status}.`);
  if (x.ordered_by === a.user.id) throw new UserError('You ordered this release, so someone else must load it.');
  const kg = Number(i.kg), bags = Number(i.bags);
  if (!(kg > 0) || !(Number.isInteger(bags) && bags > 0)) throw new UserError('Enter the weight on the scale and the number of bags loaded.');
  const tol = Math.max(1, x.ordered * 0.005);
  if (Math.abs(kg - x.ordered) > tol) throw new UserError(`Loaded ${kg} kg but ${x.ordered} kg was ordered (allowed ±${r2(tol)} kg). Load the right amount, or ask Kitovu to cancel and re-order.`);
  return tx(async () => {
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', 'stock:' + x.warehouse_id);
    const s = await db.get<{ id: string; code: string; commodity_code: string }>('SELECT id, code, commodity_code FROM stacks WHERE id=$1 AND warehouse_id=$2', i.stack, x.warehouse_id);
    if (!s || s.commodity_code !== x.commodity_code) throw new UserError('Choose the stack the bags came from.');
    const bal = (await stackBal(s.id))!;
    if (bal.kg + 0.001 < kg) throw new UserError(`Stack ${s.code} holds only ${r2(bal.kg)} kg.`);
    const rb = (await receiptBalance(x.rid))!;
    const take = Math.min(kg, rb.remaining_kg);
    const scale = await saveFile(files.scale, { kind: 'stock_evidence', entity: 'release', entityId: x.id, userId: a.user.id, label: 'Photo of the scale display' });
    const slip = await saveFile(files.slip, { kind: 'stock_evidence', entity: 'release', entityId: x.id, userId: a.user.id, allowPdf: true, label: 'Photo of the signed release slip' });
    await db.run(`UPDATE releases SET status='loaded', kg_loaded=$2, bags_loaded=$3, stack_id=$4, loaded_by=$5, loaded_at=now(), scale_photo_id=$6, slip_photo_id=$7, note=COALESCE($8, note) WHERE id=$1`,
      x.id, r2(take), bags, s.id, a.user.id, scale, slip, clean(i.note, 300) || null);
    await db.run(`INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, created_by) VALUES ($1,$2,$3,'out',$4,$5,'release',$6,$7)`,
      x.warehouse_id, x.commodity_code, s.id, -kg, -bags, x.id, a.user.id);
    const remaining = r2(rb.remaining_kg - take);
    const closed = remaining <= 0.5;
    await db.run(`UPDATE receipts SET status=$2, closed_at=CASE WHEN $3 THEN now() END, closed_reason=CASE WHEN $3 THEN 'All stock withdrawn' END, distribution_enabled=false WHERE id=$1`,
      x.rid, closed ? 'closed' : 'partially_released', closed);
    await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,$2,now(),$3,$4)`, x.rid, closed ? 'closed' : 'released', `user:${a.user.id}`,
      JSON.stringify({ release: x.ref, kg: r2(take), bags, remaining_kg: Math.max(0, remaining), reason: x.reason }));
    await audit(actorOf(a), 'release.loaded', { orgId: x.operator_org_id, entity: 'receipt', entityId: x.rid, data: { ref: x.ref, kg, remaining } });
    return { remaining: Math.max(0, remaining), closed, x };
  });
}

export async function notifyRelease(r: Awaited<ReturnType<typeof confirmLoading>>) {
  const x = r.x;
  if (!x.phone_e164 || !x.phone_verified_at || !(await getSettings())['phone_check.sms']) return;
  await sendSms(x.phone_e164, `StorageX: ${Number(x.ordered).toLocaleString('en-NG')} kg ${x.commodity} released from ${x.wh_name} on receipt ${x.receipt_no} (${x.ref}), collected by ${x.collector_name}. ${r.closed ? 'The receipt is now closed.' : `Still held: ${r.remaining.toLocaleString('en-NG')} kg.`} If this is wrong, call Kitovu now.`).catch(() => null);
}

export async function cancelRelease(a: Actor, ref: string, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt rights cancel releases.');
  const n = await db.run(`UPDATE releases SET status='cancelled', note=$2 WHERE ref=upper($1) AND status='ordered'`, clean(ref, 30), clean(note, 300) || 'cancelled');
  if (!n) throw new UserError('Only an order not yet loaded can be cancelled.');
  await audit(actorOf(a), 'release.cancelled', { data: { ref } });
}

export const releasesOf = (receiptId: string) => db.all<any>(
  `SELECT x.ref, x.status, x.kg_ordered::float AS ordered, x.kg_loaded::float AS loaded, x.ordered_at, x.loaded_at, x.collector_name, x.reason FROM releases x WHERE x.receipt_id=$1 ORDER BY x.ordered_at DESC`, receiptId);

// ---------- putting receipts under review when stock is in doubt ----------
export async function setUnderReview(a: Actor, whId: string, commodity: string, on: boolean, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'receipts.issue')) throw new UserError('Only Kitovu staff with receipt rights can do this.');
  const n = clean(note, 300);
  if (n.length < 10) throw new UserError('Explain in a sentence (stays internal).');
  return tx(async () => {
    if (on) {
      const rs = await db.all<{ id: string; status: string }>(`SELECT id, status::text FROM receipts WHERE warehouse_id=$1 AND commodity_code=$2 AND status IN ('issued','partially_released') FOR UPDATE`, whId, commodity);
      for (const r of rs) {
        await db.run(`UPDATE receipts SET status='under_exception', distribution_enabled=false WHERE id=$1`, r.id);
        await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'review_started',now(),$2,$3)`, r.id, `user:${a.user.id}`, JSON.stringify({ previous_status: r.status, note: n }));
      }
      await audit(actorOf(a), 'stock.review_started', { entity: 'warehouse', entityId: whId, data: { commodity, receipts: rs.length, note: n } });
      return rs.length;
    }
    const rs = await db.all<{ id: string; prev: string }>(
      `SELECT r.id, (SELECT e.data->>'previous_status' FROM receipt_events e WHERE e.receipt_id=r.id AND e.event_type='review_started' ORDER BY e.seq DESC LIMIT 1) AS prev
       FROM receipts r WHERE r.warehouse_id=$1 AND r.commodity_code=$2 AND r.status='under_exception' FOR UPDATE`, whId, commodity);
    for (const r of rs) {
      const back = ['issued', 'partially_released'].includes(r.prev) ? r.prev : 'issued';
      await db.run(`UPDATE receipts SET status=$2 WHERE id=$1`, r.id, back);
      await db.run(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data) VALUES ($1,'review_ended',now(),$2,$3)`, r.id, `user:${a.user.id}`, JSON.stringify({ status: back, note: n }));
    }
    await audit(actorOf(a), 'stock.review_ended', { entity: 'warehouse', entityId: whId, data: { commodity, receipts: rs.length, note: n } });
    return rs.length;
  });
}
