// Deliveries at the warehouse gate (Build 3). Phones record them offline and upload later; see public/intake/app.js.
// The server checks the evidence pack (photo hashes and the record hash), the phone's record chain, and the
// business rules, then stores the record sealed. A Kitovu reviewer who is not the clerk accepts, holds or rejects.
import crypto from 'node:crypto';
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { saveFile, sniff } from './files';
import { issueOtp, checkOtp } from './otp';
import { notifyFarmer as notify } from './notify';
import { inspect } from './agents/intake-inspector';
import { getSettings } from './settings';
import { hmac, clean } from './util';
import { placeIntake } from './stock';
import type { Upload } from './http';

export class Conflict extends UserError {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';

/** Same algorithm as canonical() in public/intake/app.js: sorted keys, no spaces. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export const sha256hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const recordHash = (r: Record<string, unknown>) => { const { evidence_hash: _e, ...rest } = r; return sha256hex(canonical(rest)); };

function need(a: Actor) { if (!can(a.membership, 'stock.manage')) throw new UserError('Your role cannot record deliveries.'); }

async function warehousesFor(a: Actor) {
  return db.all<{ id: string; code: string; name: string; state_code: string; lat: string | null; lng: string | null; status: string }>(
    `SELECT id, code, name, state_code, lat::text, lng::text, status FROM warehouses WHERE status <> 'closed' AND ($1::uuid IS NULL OR operator_org_id=$1) ORDER BY name`,
    isKitovu(a) ? null : a.membership!.org_id);
}

/** Everything the phone needs to work offline. Farmer data is limited to what the gate needs. */
export async function bootstrap(a: Actor) {
  need(a);
  const whs = await warehousesFor(a);
  const states = [...new Set(whs.map((w) => w.state_code))];
  const farmers = await db.all(
    `SELECT code, full_name AS name, community, state_code AS state, kyc_level AS level, phone_verified_at IS NOT NULL AS phone_ok,
            CASE WHEN phone_e164 IS NOT NULL THEN right(phone_e164, 4) END AS phone4
     FROM farmers WHERE status='active' AND (state_code = ANY($1) OR $2) ORDER BY full_name LIMIT 20000`, states, isKitovu(a));
  const commodities = await db.all(`SELECT code, name, max_moisture_pct::float AS max_moisture FROM commodities WHERE storable ORDER BY name`);
  const s = await getSettings();
  return {
    user: { id: a.user.id, name: a.user.full_name, org: a.membership!.org_name },
    warehouses: whs.map((w) => ({ id: w.id, code: w.code, name: w.name, status: w.status, lat: w.lat ? Number(w.lat) : null, lng: w.lng ? Number(w.lng) : null })),
    farmers, commodities, codes: { sms: s['phone_check.sms'], voice: s['phone_check.voice'] }, serverTime: new Date().toISOString(),
  };
}

// ---------- farmer confirmation at the gate (only when the phone has signal) ----------
const farmerByCode = (code: string) => db.get<{ id: string; code: string; full_name: string; phone_e164: string | null; phone_verified_at: Date | null; kyc_level: number; status: string }>(
  `SELECT id, code, full_name, phone_e164, phone_verified_at, kyc_level, status FROM farmers WHERE code=upper($1)`, clean(code, 12));

export async function sendConfirmCode(a: Actor, farmerCode: string, channel: 'sms' | 'voice') {
  need(a);
  const f = await farmerByCode(farmerCode);
  if (!f?.phone_e164 || !f.phone_verified_at) throw new UserError('This farmer has no confirmed phone. Use the paper slip.');
  const s = await getSettings();
  if (!s[channel === 'voice' ? 'phone_check.voice' : 'phone_check.sms']) throw new UserError('That kind of code is switched off.');
  await issueOtp('intake_confirm', f.id, f.phone_e164, (c) => `StorageX: code ${c} confirms you are delivering produce to a Kitovu warehouse now. Give it to the clerk only if you are there.`, channel);
}

export async function verifyConfirmCode(a: Actor, farmerCode: string, intakeId: string, otp: string) {
  need(a);
  if (!UUID.test(intakeId)) throw new UserError('Bad record id.');
  const f = await farmerByCode(farmerCode);
  if (!f) throw new UserError('Farmer not found.');
  const r = await checkOtp('intake_confirm', f.id, otp);
  if (!r.ok) throw new UserError(r.reason);
  const ts = Date.now();
  return `${ts}.${hmac(`intake-confirm:${f.id}:${intakeId}:${ts}`)}`;
}
function tokenValid(token: unknown, farmerId: string, intakeId: string) {
  const [ts, sig] = String(token ?? '').split('.');
  return !!ts && !!sig && sig === hmac(`intake-confirm:${farmerId}:${intakeId}:${ts}`);
}

// ---------- upload ----------
export interface Flag { code: string; detail: string; severity: 'info' | 'review' | 'hold' }
const num = (v: unknown, label: string, lo: number, hi: number, optional = false) => {
  if ((v === null || v === undefined || v === '') && optional) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${label} is missing or out of range.`);
  return n;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
function km(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371, rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export async function ingest(a: Actor, recordJson: string, files: Record<string, Upload>, o: { deviceClock?: string; userAgent?: string } = {}) {
  need(a);
  let rec: any;
  try { rec = JSON.parse(recordJson); } catch { throw new UserError('The record could not be read.'); }
  if (rec?.v !== 1 || !UUID.test(rec.id) || !UUID.test(rec.device_id) || !Number.isInteger(rec.device_seq) || rec.device_seq < 1 || !SHA.test(rec.evidence_hash))
    throw new UserError('The record is incomplete. Update the app and try again.');

  const existing = await db.get<{ evidence_hash: string; ref: string; status: string }>('SELECT evidence_hash, ref, status FROM intakes WHERE id=$1', rec.id);
  if (existing) {
    if (existing.evidence_hash === rec.evidence_hash) return { result: 'duplicate' as const, ref: existing.ref, status: existing.status, flags: [] as Flag[] };
    throw new Conflict('A different record with this id is already stored. Contact Kitovu.');
  }
  if (rec.clerk_user_id !== a.user.id) throw new UserError('This record was captured by another person. They must sign in on this phone to upload it.');

  // Evidence pack: every photo the record names must arrive, be an image, and match its hash.
  if (recordHash(rec) !== rec.evidence_hash) throw new UserError('The record does not match its seal. It may have been changed after it was saved.');
  const photos: { kind: 'scale' | 'moisture' | 'bags' | 'slip'; sha: string }[] = [];
  const weighings = Array.isArray(rec.weighings) ? rec.weighings : [];
  if (!weighings.length || weighings.length > 30) throw new UserError('Record at least one weighing.');
  for (const w of weighings) if (w.photo) photos.push({ kind: 'scale', sha: w.photo });
  if (rec.moisture_photo) photos.push({ kind: 'moisture', sha: rec.moisture_photo });
  for (const p of Array.isArray(rec.bag_photos) ? rec.bag_photos : []) photos.push({ kind: 'bags', sha: p });
  if (rec.slip_photo) photos.push({ kind: 'slip', sha: rec.slip_photo });
  if (photos.length > 40) throw new UserError('Too many photos.');
  for (const p of photos) {
    if (!SHA.test(p.sha)) throw new UserError('A photo reference is malformed.');
    const u = files['p_' + p.sha];
    if (!u) throw new UserError('A photo is missing from the upload. Try again.');
    if (sha256hex(u.data) !== p.sha) throw new UserError('A photo does not match its fingerprint. It may have been changed after it was taken.');
    if (!sniff(u.data)?.startsWith('image/')) throw new UserError('A photo is not an image.');
  }
  if (!photos.some((p) => p.kind === 'scale')) throw new UserError('Add a photo of the scale display.');
  if (!photos.some((p) => p.kind === 'moisture')) throw new UserError('Add a photo of the moisture meter reading.');
  if (!photos.some((p) => p.kind === 'bags')) throw new UserError('Add at least one photo of the bags.');

  // Facts
  const wh = (await warehousesFor(a)).find((w) => w.id === rec.warehouse_id);
  if (!wh) throw new UserError('You cannot record deliveries for that warehouse.');
  const f = await farmerByCode(String(rec.farmer_code ?? ''));
  if (!f || f.status !== 'active') throw new UserError('Unknown or inactive farmer.');
  const com = await db.get<{ code: string; max_moisture_pct: string | null; name: string }>('SELECT code, name, max_moisture_pct FROM commodities WHERE code=$1 AND storable', rec.commodity_code);
  if (!com) throw new UserError('Unknown commodity.');
  let bags = 0, gross = 0;
  for (const w of weighings) { const b = num(w.bags, 'Bags', 1, 10000)!; if (!Number.isInteger(b)) throw new UserError('Bags must be whole numbers.'); bags += b; gross += num(w.gross_kg, 'Scale reading', 0.1, 1_000_000)!; }
  gross = r2(gross);
  const tare = num(rec.tare_per_bag_kg, 'Empty bag weight', 0, 5)!;
  const net = r2(gross - bags * tare);
  if (net <= 0) throw new UserError('Net weight is not positive: check the empty bag weight.');
  const moisture = num(rec.moisture_pct, 'Moisture', 0, 60)!;
  const fm = num(rec.foreign_matter_pct, 'Foreign matter', 0, 100, true);
  const dmg = num(rec.damaged_pct, 'Damaged grain', 0, 100, true);
  const conf = rec.farmer_confirmation;
  if (conf === 'code') { if (!tokenValid(rec.confirm_token, f.id, rec.id)) throw new UserError('The farmer’s confirmation code is not valid for this record.'); }
  else if (conf !== 'paper_slip' || !rec.slip_photo) throw new UserError('Add the photo of the farmer’s signed or thumb-printed slip.');
  const captured = new Date(rec.captured_at), started = rec.started_at ? new Date(rec.started_at) : null;
  if (isNaN(captured.getTime())) throw new UserError('Capture time is missing.');
  const gps = rec.gps && Number.isFinite(rec.gps.lat) && Number.isFinite(rec.gps.lng) ? rec.gps : null;

  // Rules that do not block the upload but tell the reviewer what to look at.
  const flags: Flag[] = [];
  const add = (code: string, detail: string, severity: Flag['severity'] = 'review') => flags.push({ code, detail, severity });
  const now = Date.now();
  const deviceClock = o.deviceClock ? new Date(o.deviceClock) : null;
  const drift = deviceClock && !isNaN(deviceClock.getTime()) ? (deviceClock.getTime() - now) / 60000 : 0;
  if (Math.abs(drift) > 10) add('clock_drift', `The phone clock was ${Math.round(Math.abs(drift))} minutes ${drift > 0 ? 'fast' : 'slow'} at upload; capture time adjusted for review.`);
  const capturedServer = captured.getTime() - drift * 60000;
  if (capturedServer > now + 5 * 60000) add('captured_in_future', 'Capture time is in the future.', 'hold');
  if (now - capturedServer > 7 * 86400000) add('late_upload', `Uploaded ${Math.round((now - capturedServer) / 86400000)} days after capture.`);
  if (started && (captured.getTime() - started.getTime()) < 60000) add('very_fast_capture', 'The whole record took less than a minute to capture.');
  if (com.max_moisture_pct && moisture > Number(com.max_moisture_pct)) add('moisture_over_limit', `Moisture ${moisture}% is above the ${com.max_moisture_pct}% limit for ${com.name}. Dry before storage.`, 'hold');
  const perBag = net / bags;
  if (perBag < 20 || perBag > 150) add('bag_weight_unusual', `Average net ${perBag.toFixed(1)} kg per bag.`);
  if (f.kyc_level < 1) add('farmer_not_verified', 'The farmer’s identity is not checked yet (level 0). A receipt cannot be issued until it is.');
  if (!['certified', 'active'].includes(wh.status)) add('warehouse_not_certified', `Warehouse is ${wh.status}; stock here cannot back loans.`, 'info');
  if (!gps) add('no_gps', rec.gps_note ? `No location: ${clean(rec.gps_note, 80)}` : 'No location recorded.');
  else if (wh.lat && wh.lng) {
    const d = km(gps.lat, gps.lng, Number(wh.lat), Number(wh.lng));
    if (d > 2) add('far_from_warehouse', `Recorded ${d.toFixed(1)} km from the warehouse.`, d > 20 ? 'hold' : 'review');
  }
  const dup = await db.val<string>(
    `SELECT ref FROM intakes WHERE farmer_id=$1 AND warehouse_id=$2 AND commodity_code=$3 AND abs(net_kg - $4) <= $4 * 0.01
       AND captured_at BETWEEN $5::timestamptz - interval '24 hours' AND $5::timestamptz + interval '24 hours' AND status <> 'rejected' LIMIT 1`,
    f.id, wh.id, com.code, net, captured.toISOString());
  if (dup) add('possible_duplicate', `Looks like ${dup} (same farmer, commodity and weight within a day).`, 'hold');

  const stored = await tx(async () => {
    // Phone chain: catches records deleted or altered on the phone before upload.
    await db.run(`INSERT INTO intake_devices (id, first_user_id, user_agent) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, rec.device_id, a.user.id, clean(o.userAgent, 200));
    const dev = (await db.get<{ last_seq: number; last_hash: string | null }>('SELECT last_seq, last_hash FROM intake_devices WHERE id=$1 FOR UPDATE', rec.device_id))!;
    if (rec.device_seq <= dev.last_seq) add('out_of_order', `Record ${rec.device_seq} arrived after record ${dev.last_seq} from the same phone.`);
    else if (rec.device_seq !== dev.last_seq + 1) add('device_chain_gap', `Records ${dev.last_seq + 1}–${rec.device_seq - 1} from this phone never arrived (deleted or lost before upload).`, 'hold');
    else if ((rec.prev_hash ?? null) !== dev.last_hash) add('device_chain_broken', 'This record does not link to the previous record from this phone.', 'hold');
    if (rec.device_seq > dev.last_seq) await db.run('UPDATE intake_devices SET last_seq=$2, last_hash=$3, last_seen_at=now() WHERE id=$1', rec.device_id, rec.device_seq, rec.evidence_hash);

    const ref = `IN-${String(rec.device_id).slice(0, 4).toUpperCase()}-${rec.device_seq}`;
    await db.run(
      `INSERT INTO intakes (id, ref, device_id, device_seq, prev_hash, evidence_hash, warehouse_id, farmer_id, commodity_code, weighings, bags, gross_kg, tare_per_bag_kg, net_kg,
         moisture_pct, foreign_matter_pct, damaged_pct, grade, stack_ref, notes, farmer_confirmation, captured_at, started_at, device_clock_at_upload, lat, lng, gps_accuracy_m, gps_note,
         clerk_user_id, flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      rec.id, ref, rec.device_id, rec.device_seq, rec.prev_hash ?? null, rec.evidence_hash, wh.id, f.id, com.code, JSON.stringify(weighings), bags, gross, tare, net,
      moisture, fm, dmg, clean(rec.grade, 20) || null, clean(rec.stack_ref, 40) || null, clean(rec.notes, 500) || null, conf, captured.toISOString(), started?.toISOString() ?? null,
      deviceClock && !isNaN(deviceClock.getTime()) ? deviceClock.toISOString() : null, gps?.lat ?? null, gps?.lng ?? null, gps?.acc ?? null, clean(rec.gps_note, 120) || null,
      a.user.id, JSON.stringify(flags));
    let idx = 0;
    for (const p of photos) {
      const fileId = await saveFile(files['p_' + p.sha], { kind: 'intake_evidence', entity: 'intake', entityId: rec.id, userId: a.user.id, label: 'Photo' });
      await db.run('INSERT INTO intake_photos (intake_id, idx, kind, file_id, sha256) VALUES ($1,$2,$3,$4,$5)', rec.id, idx++, p.kind, fileId, p.sha);
    }
    await audit(actorOf(a), 'intake.uploaded', { orgId: a.membership!.org_id, entity: 'intake', entityId: rec.id, data: { ref, warehouse: wh.code, farmer: f.code, net_kg: net, flags: flags.map((x) => x.code) } });
    return { result: 'stored' as const, ref, status: 'submitted', flags, farmer: f, net, commodity: com.name, warehouse: wh.name };
  });
  // The inspector compares it with history straight away; anything serious puts it on hold for compliance.
  const ins = await inspect(rec.id);
  if (!ins) return stored;
  return { ...stored, status: ins.held ? 'held' : stored.status, flags: [...stored.flags.filter((x) => !ins.found.some((y) => y.code === x.code)), ...ins.found] };
}

/** After upload: tell the farmer what was recorded, so a wrong record is disputed early. */
export async function notifyFarmer(r: { farmer: { id: string }; ref: string; net: number; commodity: string; warehouse: string }) {
  await notify(r.farmer.id, 'intake_recorded', r.ref, { warehouse: r.warehouse, kg: r.net.toLocaleString('en-NG'), crop: r.commodity, ref: r.ref });
}

// ---------- review ----------
export async function listIntakes(a: Actor, q: { status?: string; warehouse?: string } = {}) {
  if (!can(a.membership, 'stock.manage') && !can(a.membership, 'warehouses.view')) throw new UserError('Not allowed.');
  const scope = isKitovu(a) ? null : a.membership!.org_id;
  return db.all(
    `SELECT i.id, i.ref, i.status, i.net_kg::float, i.bags, i.moisture_pct::float, i.captured_at, i.received_at, i.flags, i.farmer_confirmation,
            f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, w.code AS wh_code, w.name AS wh_name, c.name AS commodity, u.full_name AS clerk
     FROM intakes i JOIN farmers f ON f.id=i.farmer_id JOIN warehouses w ON w.id=i.warehouse_id JOIN commodities c ON c.code=i.commodity_code JOIN users u ON u.id=i.clerk_user_id
     WHERE ($1::uuid IS NULL OR w.operator_org_id=$1) AND ($2 = '' OR i.status=$2) AND ($3 = '' OR w.code=$3)
     ORDER BY (i.status IN ('submitted','held')) DESC, i.received_at DESC LIMIT 300`,
    scope, ['submitted', 'accepted', 'held', 'rejected'].includes(String(q.status)) ? q.status : '', clean(q.warehouse, 20));
}

export async function intakeByRef(a: Actor, ref: string) {
  const scope = isKitovu(a) ? null : a.membership!.org_id;
  const i = await db.get<any>(
    `SELECT i.*, i.net_kg::float AS net, i.gross_kg::float AS gross, f.code AS farmer_code, f.full_name AS farmer_name, f.kyc_level, w.code AS wh_code, w.name AS wh_name,
            w.lat::float AS wh_lat, w.lng::float AS wh_lng, c.name AS commodity, c.max_moisture_pct::float AS max_moisture, u.full_name AS clerk, ru.full_name AS reviewer, cu.full_name AS clearer
     FROM intakes i JOIN farmers f ON f.id=i.farmer_id JOIN warehouses w ON w.id=i.warehouse_id JOIN commodities c ON c.code=i.commodity_code
       JOIN users u ON u.id=i.clerk_user_id LEFT JOIN users ru ON ru.id=i.reviewed_by LEFT JOIN users cu ON cu.id=i.hold_cleared_by
     WHERE i.ref=upper($1) AND ($2::uuid IS NULL OR w.operator_org_id=$2)`, clean(ref, 30), scope);
  if (!i) return undefined;
  i.photos = await db.all('SELECT idx, kind, file_id, sha256 FROM intake_photos WHERE intake_id=$1 ORDER BY idx', i.id);
  return i;
}

export async function reviewIntake(a: Actor, ref: string, decision: 'accept' | 'hold' | 'reject', note: string) {
  if (!isKitovu(a) || !can(a.membership, 'stock.manage')) throw new UserError('Only Kitovu operations review deliveries.');
  const i = await intakeByRef(a, ref);
  if (!i) throw new UserError('Delivery not found.');
  if (i.clerk_user_id === a.user.id) throw new UserError('You recorded this delivery, so someone else must review it.');
  if (!['submitted', 'held'].includes(i.status)) throw new UserError(`This delivery is already ${i.status}.`);
  const n = clean(note, 500);
  if (decision !== 'accept' && n.length < 3) throw new UserError('Say why.');
  const holds = (i.flags as Flag[]).filter((f) => f.severity === 'hold');
  if (decision === 'accept' && holds.length && !i.hold_cleared_by) throw new UserError(`This delivery has ${holds.length} serious flag(s). Compliance must check and clear it before it can be accepted.`);
  if (decision === 'accept' && holds.length && n.length < 3) throw new UserError(`This delivery has ${holds.length} serious flag(s). Explain in the note why it is acceptable.`);
  const status = { accept: 'accepted', hold: 'held', reject: 'rejected' }[decision];
  await tx(async () => {
    await db.run('UPDATE intakes SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1', i.id, status, a.user.id, n || null);
    // Accepted stock enters the stock ledger, on the stack the clerk named.
    if (status === 'accepted') await placeIntake(a.user.id, { id: i.id, warehouse_id: i.warehouse_id, commodity_code: i.commodity_code, net_kg: i.net, bags: i.bags, stack_ref: i.stack_ref });
    await audit(actorOf(a), `intake.${status}`, { entity: 'intake', entityId: i.id, data: { ref: i.ref, note: n || null } });
  });
}

/** Compliance looks into a held delivery (photos, the farmer, the clerk) and clears it for operations to accept.
 *  It does not accept it: operations still review and accept, so a hold always needs two people besides the clerk. */
export async function clearHold(a: Actor, ref: string, note: string) {
  if (!isKitovu(a) || !can(a.membership, 'kyc.review')) throw new UserError('Only Kitovu compliance clears a held delivery.');
  const i = await intakeByRef(a, ref);
  if (!i) throw new UserError('Delivery not found.');
  if (i.clerk_user_id === a.user.id) throw new UserError('You recorded this delivery, so someone else must clear it.');
  if (i.hold_cleared_by) throw new UserError('Already cleared.');
  if (!['submitted', 'held'].includes(i.status)) throw new UserError(`This delivery is already ${i.status}.`);
  const holds = (i.flags as Flag[]).filter((f) => f.severity === 'hold');
  if (!holds.length) throw new UserError('There is nothing serious to clear.');
  const n = clean(note, 500);
  if (n.length < 15) throw new UserError('Say what you checked and why it is genuine (at least a sentence).');
  await db.run(`UPDATE intakes SET hold_cleared_by=$2, hold_cleared_at=now(), hold_clear_note=$3, status='submitted' WHERE id=$1`, i.id, a.user.id, n);
  await audit(actorOf(a), 'intake.hold_cleared', { entity: 'intake', entityId: i.id, data: { ref: i.ref, flags: holds.map((h) => h.code), note: n } });
}

export const deliveriesOf = (farmerId: string) => db.all(
  `SELECT i.ref, i.status, i.net_kg::float AS net, i.captured_at, c.name AS commodity, w.name AS warehouse FROM intakes i
   JOIN commodities c ON c.code=i.commodity_code JOIN warehouses w ON w.id=i.warehouse_id WHERE i.farmer_id=$1 ORDER BY i.captured_at DESC LIMIT 50`, farmerId);

