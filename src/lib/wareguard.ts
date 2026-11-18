// WareGuard readings in StorageX. Titan (Build 13) will deliver devices and readings through recordReadings();
// until then nothing calls it outside the tests, and every screen shows "not connected yet".
// Each new reading is checked against the limits in Settings. A condition outside them opens one sensor alert,
// which the explainer turns into advice, and Kitovu, the warehouse operator and every lender with stock pledged
// there are alerted. The alert closes itself when conditions are back inside the limits.
import { db } from './db';
import { audit, systemActor } from './audit';
import { getSettings } from './settings';
import { raise } from './alerts';
import { explain, type SensorKind, type Advice } from './agents/wareguard-explainer';
import { LIVE } from './stock';

export interface Reading { at: string | Date; temp_c?: number | null; rh_pct?: number | null; door_open?: boolean | null; battery_pct?: number | null }

/** Add (or refresh) a device. Titan sends these; Kitovu can also add one by hand for a trial. */
export async function upsertDevice(warehouseId: string, deviceRef: string, label: string) {
  return (await db.val<string>(`INSERT INTO sensor_devices (warehouse_id, device_ref, label) VALUES ($1,$2,$3)
    ON CONFLICT (device_ref) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id, label=EXCLUDED.label RETURNING id`, warehouseId, deviceRef.slice(0, 80), label.slice(0, 120)))!;
}

/** Store readings for one device (duplicates are ignored) and check the latest against the limits. */
export async function recordReadings(deviceRef: string, readings: Reading[], now = new Date()) {
  const d = await db.get<{ id: string }>('SELECT id FROM sensor_devices WHERE device_ref=$1 AND active', deviceRef);
  if (!d) throw new Error(`unknown WareGuard device ${deviceRef}`);
  let stored = 0;
  for (const r of readings) {
    const at = new Date(r.at);
    if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 5 * 60_000) continue;   // no readings from the future
    stored += await db.run(`INSERT INTO sensor_readings (device_id, at, temp_c, rh_pct, door_open, battery_pct) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      d.id, at, r.temp_c ?? null, r.rh_pct ?? null, r.door_open ?? null, r.battery_pct ?? null);
  }
  await db.run(`UPDATE sensor_devices SET last_seen_at=GREATEST(COALESCE(last_seen_at,'epoch'), (SELECT max(at) FROM sensor_readings WHERE device_id=$1)) WHERE id=$1`, d.id);
  await evaluate(d.id, now);
  return { stored };
}

async function situation(whId: string, deviceLabel: string | null, kind: SensorKind, value: number | null, limit: number, minutes: number) {
  const w = (await db.get<{ name: string }>('SELECT name FROM warehouses WHERE id=$1', whId))!;
  const crops = await db.all<any>(`SELECT c.name, sum(b.remaining_kg)::float AS kg, max(r.moisture_pct)::float AS moisture FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id
    JOIN commodities c ON c.code=r.commodity_code WHERE r.warehouse_id=$1 AND r.status::text = ANY($2) AND b.remaining_kg > 0 GROUP BY c.name ORDER BY 2 DESC`, whId, LIVE);
  const pledged = Number(await db.val(`SELECT COALESCE(sum(b.remaining_kg),0) FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id JOIN liens li ON li.receipt_id=r.id AND li.released_at IS NULL WHERE r.warehouse_id=$1`, whId));
  const rel = !!(await db.val(`SELECT 1 FROM releases x JOIN receipts r ON r.id=x.receipt_id WHERE r.warehouse_id=$1 AND x.status='ordered'`, whId));
  return { kind, warehouse: w.name, device: deviceLabel, value, limit, minutes, crops: crops.map((c) => ({ name: c.name, kg: c.kg, moisture: c.moisture })), pledged_kg: pledged, release_ordered: rel };
}

/** Open (or keep open) a sensor alert and tell the people concerned once; or close it. */
async function setCondition(whId: string, deviceId: string | null, deviceLabel: string | null, kind: SensorKind, on: boolean, startedAt: Date, value: number | null, limit: number, now: Date) {
  const open = await db.get<any>(`SELECT * FROM sensor_alerts WHERE warehouse_id=$1 AND device_id IS NOT DISTINCT FROM $2 AND kind=$3 AND ended_at IS NULL`, whId, deviceId, kind);
  if (!on) { if (open) await db.run('UPDATE sensor_alerts SET ended_at=$2 WHERE id=$1', open.id, now); return null; }
  const minutes = Math.max(0, (now.getTime() - startedAt.getTime()) / 60_000);
  const advice: Advice = await explain(await situation(whId, deviceLabel, kind, value, limit, minutes));
  if (open) {
    const escalated = open.severity === 'warn' && advice.urgency === 'urgent';
    await db.run(`UPDATE sensor_alerts SET peak=GREATEST(COALESCE(peak,$2), $2), severity=$3, advice=$4 WHERE id=$1`, open.id, value ?? 0, advice.urgency, JSON.stringify(advice));
    if (escalated) await tell(whId, kind, advice, `${open.id}:urgent`);
    return open.id;
  }
  const id = (await db.val<string>(`INSERT INTO sensor_alerts (warehouse_id, device_id, kind, severity, started_at, peak, advice) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    whId, deviceId, kind, advice.urgency, startedAt, value, JSON.stringify(advice)))!;
  await tell(whId, kind, advice, id);
  return id;
}

async function tell(whId: string, kind: SensorKind, a: Advice, key: string) {
  const w = (await db.get<{ code: string; operator_org_id: string }>('SELECT code, operator_org_id FROM warehouses WHERE id=$1', whId))!;
  const alertKind = kind === 'offline' ? 'warehouse_offline' : 'warehouse_condition';
  const level = a.urgency === 'urgent' ? 'urgent' as const : 'warn' as const;
  await raise(w.operator_org_id, { kind: alertKind, level, title: a.headline, body: `${a.note ?? a.why} What to do: ${a.actions.map((x, i) => `${i + 1}) ${x}`).join(' ')}`, link: `/stock-watch/${w.code}`, key: `wg:${key}` });
  const lenders = await db.all<{ lender_org_id: string }>(`SELECT DISTINCT li.lender_org_id FROM liens li JOIN receipts r ON r.id=li.receipt_id WHERE r.warehouse_id=$1 AND li.released_at IS NULL`, whId);
  for (const l of lenders) await raise(l.lender_org_id, { kind: alertKind, level, title: a.headline, body: `${a.why} ${a.for_lenders}`, link: `/stock-watch/${w.code}`, key: `wg:${key}` });
}

/** Check one device's latest readings against the limits. */
export async function evaluate(deviceId: string, now = new Date()) {
  const s = await getSettings();
  const d = (await db.get<any>('SELECT * FROM sensor_devices WHERE id=$1', deviceId))!;
  const last = await db.get<any>('SELECT * FROM sensor_readings WHERE device_id=$1 ORDER BY at DESC LIMIT 1', deviceId);
  if (!last) return;
  // When did the reading first cross the limit in the current run? (the earliest reading since the last one inside it)
  const since = async (cond: string, lim: number) => {
    const lastOk = await db.val<Date>(`SELECT max(at) FROM sensor_readings WHERE device_id=$1 AND NOT (${cond})`, deviceId, lim);
    return (await db.val<Date>(`SELECT min(at) FROM sensor_readings WHERE device_id=$1 AND (${cond}) AND ($3::timestamptz IS NULL OR at > $3)`, deviceId, lim, lastOk)) ?? last.at;
  };
  const tMax = s['wareguard.max_temp_c'], hMax = s['wareguard.max_rh_pct'], doorMin = s['wareguard.door_open_minutes'];
  const hot = last.temp_c != null && Number(last.temp_c) > tMax;
  await setCondition(d.warehouse_id, d.id, d.label, 'high_temperature', hot, hot ? new Date(await since('temp_c > $2', tMax)) : now, hot ? Number(last.temp_c) : null, tMax, now);
  const damp = last.rh_pct != null && Number(last.rh_pct) > hMax;
  await setCondition(d.warehouse_id, d.id, d.label, 'high_humidity', damp, damp ? new Date(await since('rh_pct > $2', hMax)) : now, damp ? Number(last.rh_pct) : null, hMax, now);
  const doorFrom = last.door_open ? new Date(await since('door_open AND $2::int IS NOT NULL', 0)) : null;
  const doorLong = !!doorFrom && (now.getTime() - doorFrom.getTime()) / 60_000 >= doorMin;
  await setCondition(d.warehouse_id, d.id, d.label, 'door_open', doorLong, doorFrom ?? now, null, doorMin, now);
  await setCondition(d.warehouse_id, d.id, d.label, 'offline', false, now, null, s['wareguard.offline_minutes'], now);
}

/** Every few minutes once Titan is connected: devices that have gone quiet. */
export async function sweepOffline(now = new Date()) {
  const s = await getSettings();
  const quiet = await db.all<any>(`SELECT * FROM sensor_devices WHERE active AND last_seen_at IS NOT NULL AND last_seen_at < $1`, new Date(now.getTime() - s['wareguard.offline_minutes'] * 60_000));
  for (const d of quiet) await setCondition(d.warehouse_id, d.id, d.label, 'offline', true, new Date(d.last_seen_at), null, s['wareguard.offline_minutes'], now);
  if (quiet.length) await audit(systemActor('wareguard'), 'wareguard.offline_sweep', { data: { quiet: quiet.length } });
  return quiet.length;
}

export const CONNECTED = async () => Number(await db.val('SELECT count(*) FROM sensor_devices WHERE active')) > 0;

/** What a screen needs about one or more warehouses: devices, latest readings, open alerts, last two days. */
export async function health(whIds: string[], hours = 48) {
  if (!whIds.length) return [];
  const s = await getSettings();
  const offlineAfter = s['wareguard.offline_minutes'] * 60_000;
  const out = [];
  for (const id of whIds) {
    const devices = await db.all<any>(`SELECT d.*, (SELECT row_to_json(x) FROM (SELECT at, temp_c::float, rh_pct::float, door_open, battery_pct::float FROM sensor_readings r WHERE r.device_id=d.id ORDER BY at DESC LIMIT 1) x) AS last
      FROM sensor_devices d WHERE d.warehouse_id=$1 AND d.active ORDER BY d.label`, id);
    const alerts = await db.all<any>(`SELECT a.*, d.label AS device FROM sensor_alerts a LEFT JOIN sensor_devices d ON d.id=a.device_id WHERE a.warehouse_id=$1 AND a.ended_at IS NULL ORDER BY a.started_at`, id);
    const series = await db.all<any>(`SELECT date_trunc('hour', r.at) AS h, avg(r.temp_c)::float AS t, avg(r.rh_pct)::float AS rh, bool_or(r.door_open) AS door FROM sensor_readings r
      JOIN sensor_devices d ON d.id=r.device_id WHERE d.warehouse_id=$1 AND r.at > now() - make_interval(hours => $2::int) GROUP BY 1 ORDER BY 1`, id, hours);
    const doorEvents = Number(await db.val(`SELECT count(*) FROM (SELECT door_open, lag(door_open) OVER (PARTITION BY device_id ORDER BY at) AS prev FROM sensor_readings r JOIN sensor_devices d ON d.id=r.device_id
      WHERE d.warehouse_id=$1 AND r.at > now() - interval '24 hours') z WHERE door_open AND prev IS DISTINCT FROM true`, id));
    const online = devices.filter((d) => d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < offlineAfter).length;
    const lasts = devices.map((d) => d.last).filter(Boolean);
    const avg = (k: string) => { const v = lasts.map((l: any) => l[k]).filter((x: any) => x != null); return v.length ? v.reduce((a: number, b: number) => a + b, 0) / v.length : null; };
    out.push({ warehouse_id: id, devices: devices.length, online, temp_c: avg('temp_c'), rh_pct: avg('rh_pct'), door_open_now: lasts.some((l: any) => l.door_open), door_events_24h: doorEvents,
      last_at: lasts.length ? lasts.map((l: any) => l.at).sort().at(-1) : null, alerts, series,
      state: !devices.length ? 'none' : alerts.some((a) => a.severity === 'urgent') ? 'bad' : alerts.length || online < devices.length ? 'warn' : 'ok', limits: { temp: s['wareguard.max_temp_c'], rh: s['wareguard.max_rh_pct'] } });
  }
  return out;
}
