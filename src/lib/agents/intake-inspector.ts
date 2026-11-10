// Intake inspector: looks at each delivery against everything recorded before it, for patterns a single record
// cannot show (the same photo used twice, one farmer at two warehouses on the same day, copied weights, a clerk
// typing the same moisture all day, more stock than the warehouse holds). Rules are in code and explained in
// plain words; it never accepts or rejects. Anything serious puts the delivery on hold, and only compliance can
// clear a hold before operations accept the delivery.
import { db } from '../db';
import { audit, systemActor } from '../audit';
import { getSettings } from '../settings';
import type { Flag } from '../intake';

export const VERSION = 'inspector-1';
export const CODES = ['photo_reused', 'farmer_two_places', 'over_capacity', 'clerk_burst', 'repeated_weights', 'moisture_constant', 'farmer_volume_jump', 'night_capture', 'round_weights'] as const;

const km = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};
const fmtKg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function inspect(intakeId: string) {
  const i = await db.get<any>(`SELECT i.*, i.net_kg::float AS net, i.moisture_pct::float AS moisture, w.lat::float AS wlat, w.lng::float AS wlng, w.capacity_kg::float AS capacity, w.name AS wh_name
    FROM intakes i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=$1`, intakeId);
  if (!i) return null;
  const s = await getSettings();
  const found: Flag[] = [];
  const add = (code: string, detail: string, severity: Flag['severity'] = 'review') => found.push({ code, detail, severity });
  const checks: string[] = [];

  // 1. A photo already used on another delivery: the strongest sign of a made-up record.
  checks.push('photo_reused');
  const reused = await db.all<{ kind: string; ref: string }>(`SELECT DISTINCT p.kind, o.ref FROM intake_photos p JOIN intake_photos q ON q.sha256=p.sha256 AND q.intake_id<>p.intake_id
    JOIN intakes o ON o.id=q.intake_id WHERE p.intake_id=$1 ORDER BY o.ref LIMIT 5`, intakeId);
  if (reused.length) add('photo_reused', `The same ${[...new Set(reused.map((r) => r.kind))].join(' and ')} photo is on ${[...new Set(reused.map((r) => r.ref))].join(', ')}.`, 'hold');

  // 2. The same farmer delivering at another warehouse within 6 hours.
  checks.push('farmer_two_places');
  const elsewhere = await db.all<any>(`SELECT o.ref, w.name, w.lat::float AS lat, w.lng::float AS lng FROM intakes o JOIN warehouses w ON w.id=o.warehouse_id
    WHERE o.farmer_id=$1 AND o.id<>$2 AND o.warehouse_id<>$3 AND o.status<>'rejected' AND abs(extract(epoch FROM o.captured_at - $4::timestamptz)) < 6*3600`, i.farmer_id, i.id, i.warehouse_id, i.captured_at);
  for (const o of elsewhere) {
    const d = i.wlat != null && o.lat != null ? km(i.wlat, i.wlng, o.lat, o.lng) : null;
    if (d === null || d > 30) { add('farmer_two_places', `Same farmer recorded at ${o.name} (${o.ref}) within 6 hours${d ? `, ${Math.round(d)} km away` : ''}.`, 'hold'); break; }
  }

  // 3. More stock than the warehouse can hold.
  checks.push('over_capacity');
  if (i.capacity) {
    const held = Number(await db.val(`SELECT COALESCE(sum(b.remaining_kg),0)::float FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id
      WHERE r.warehouse_id=$1 AND r.status NOT IN ('closed','settled','cancelled','expired','rejected')`, i.warehouse_id));
    const waiting = Number(await db.val(`SELECT COALESCE(sum(net_kg),0)::float FROM intakes o WHERE o.warehouse_id=$1 AND o.id<>$2 AND (o.status IN ('submitted','held')
      OR (o.status='accepted' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.intake_id=o.id)))`, i.warehouse_id, i.id));
    if (held + waiting + i.net > i.capacity * 1.02)
      add('over_capacity', `With this delivery the warehouse would hold ${fmtKg(held + waiting + i.net)}, more than its ${fmtKg(i.capacity)} capacity.`, 'hold');
  }

  // 4. Many records from one clerk in a short time.
  checks.push('clerk_burst');
  const burst = Number(await db.val(`SELECT count(*) FROM intakes WHERE clerk_user_id=$1 AND abs(extract(epoch FROM captured_at - $2::timestamptz)) <= 15*60`, i.clerk_user_id, i.captured_at));
  if (burst >= 6) add('clerk_burst', `The clerk recorded ${burst} deliveries within 15 minutes of this one. Each needs weighing and photos; check they were real.`);

  // 5. Exactly the same weighings as another farmer's delivery.
  checks.push('repeated_weights');
  const grosses = (i.weighings as any[]).map((w) => Number(w.gross_kg)).sort((a, b) => a - b);
  if (grosses.length) {
    const twins = await db.all<{ ref: string }>(`SELECT o.ref FROM intakes o WHERE o.warehouse_id=$1 AND o.id<>$2 AND o.farmer_id<>$3 AND o.captured_at > $4::timestamptz - interval '14 days'
      AND (SELECT array_agg((x->>'gross_kg')::numeric ORDER BY (x->>'gross_kg')::numeric) FROM jsonb_array_elements(o.weighings) x) = $5::numeric[] LIMIT 3`,
      i.warehouse_id, i.id, i.farmer_id, i.captured_at, grosses);
    if (twins.length) add('repeated_weights', `Every scale reading matches another farmer's delivery (${twins.map((t) => t.ref).join(', ')}).`);
  }

  // 6. The clerk types the same moisture every time.
  checks.push('moisture_constant');
  const ms = (await db.all<{ m: number }>(`SELECT moisture_pct::float AS m FROM intakes WHERE clerk_user_id=$1 AND captured_at <= $2 ORDER BY captured_at DESC LIMIT 10`, i.clerk_user_id, i.captured_at)).map((r) => r.m);
  if (ms.length >= 8 && ms.every((m) => m === ms[0])) add('moisture_constant', `The clerk's last ${ms.length} deliveries all show ${ms[0]}% moisture. Meters vary; check readings are being taken.`);

  // 7. Much more than this farmer usually brings.
  checks.push('farmer_volume_jump');
  const prior = (await db.all<{ n: number }>(`SELECT net_kg::float AS n FROM intakes WHERE farmer_id=$1 AND id<>$2 AND status<>'rejected' AND captured_at < $3`, i.farmer_id, i.id, i.captured_at)).map((r) => r.n);
  const month = Number(await db.val(`SELECT COALESCE(sum(net_kg),0)::float FROM intakes WHERE farmer_id=$1 AND status<>'rejected' AND captured_at > $2::timestamptz - interval '30 days' AND captured_at <= $2`, i.farmer_id, i.captured_at));
  if (prior.length >= 3 && i.net > 4 * median(prior)) add('farmer_volume_jump', `${fmtKg(i.net)} is over four times this farmer's usual delivery (${fmtKg(median(prior))}). They may be delivering for others.`);
  else if (month > s['inspector.farmer_30d_kg']) add('farmer_volume_jump', `This farmer has delivered ${fmtKg(month)} in 30 days, more than ${fmtKg(s['inspector.farmer_30d_kg'])}. Confirm it is their own produce.`);

  // 8. Captured at night.
  checks.push('night_capture');
  const hour = Number(new Date(i.captured_at).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }));
  if (hour >= 21 || hour < 5) add('night_capture', `Recorded at ${String(hour).padStart(2, '0')}:00 at night.`);

  // 9. Every reading a round number.
  checks.push('round_weights');
  if (grosses.length >= 3 && grosses.every((g) => g % 10 === 0)) add('round_weights', 'Every scale reading is a round 10 kg. Real readings rarely are; compare with the photos.', 'info');

  // Already accepted (a late check): what is found is shown for follow-up but cannot undo the acceptance.
  if (i.status === 'accepted' && !i.hold_cleared_by) for (const f of found) if (f.severity === 'hold') { f.severity = 'review'; f.detail = `Found after acceptance: ${f.detail}`; }
  const flags = [...(i.flags as Flag[]).filter((f) => !(CODES as readonly string[]).includes(f.code)), ...found];
  const holds = flags.filter((f) => f.severity === 'hold');
  const inspection = { version: VERSION, at: new Date().toISOString(), checks, found: found.map((f) => f.code) };
  const hold = holds.length > 0 && i.status === 'submitted' && !i.hold_cleared_by;
  await db.run(`UPDATE intakes SET flags=$2, inspection=$3${hold ? `, status='held', review_note=$4` : ''} WHERE id=$1`,
    ...[intakeId, JSON.stringify(flags), JSON.stringify(inspection)], ...(hold ? [`Held by the intake inspector: ${holds.map((h) => h.code.replace(/_/g, ' ')).join(', ')}. Compliance must clear it.`] : []));
  if (found.length || hold) await audit(systemActor('intake-inspector'), hold ? 'intake.held_by_inspector' : 'intake.inspected', { entity: 'intake', entityId: intakeId, data: { ref: i.ref, found: found.map((f) => f.code) } });
  return { found, held: hold, holds: holds.length };
}
