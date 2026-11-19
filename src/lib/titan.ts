// Titan: Kitovu's IoT platform, where WareGuard devices report. StorageX reads from Titan with a key Titan issues
// (kept in the server's settings as TITAN_API_KEY), and Titan tells StorageX straight away of new readings, alerts and
// device changes by signed webhook to /hooks/titan. The every-10-minutes job also fetches anything a webhook missed.
//
//   Titan site  ->  StorageX warehouse   (the site's external reference is the warehouse code, e.g. WH-OY-ISY-01;
//                                         or the same name; or chosen on the warehouse page)
//   Titan device -> WareGuard device     (sensor_devices.device_ref = Titan's device id, e.g. WG-000123)
//   readings     -> sensor_readings      (air.temperature, air.humidity, security.door, power.battery_soc)
//   Titan alerts -> WareGuard alerts     (tamper, intruder, power lost, sensor error; StorageX checks heat, damp,
//                                         doors and silence itself against its own limits)
import crypto from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { audit, systemActor } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { encrypt, decrypt, clean } from './util';
import { upsertDevice, recordReadings, externalCondition, type Reading } from './wareguard';
import type { SensorKind } from './agents/wareguard-explainer';

export const connected = () => !!config.titanKey;
type Send = (url: string, init: any) => Promise<{ status: number; ok: boolean; json(): Promise<any>; text(): Promise<string> }>;
let send: Send = fetch as any;
/** Tests replace the network. */
export const setTransport = (s: Send) => { send = s; };

export const METRICS = ['air.temperature', 'air.humidity', 'security.door', 'power.battery_soc'];
export const EVENTS = ['reading.created', 'alert.opened', 'alert.resolved', 'device.online', 'device.offline'];

async function titan(path: string, method = 'GET', body?: unknown) {
  if (!connected()) throw new UserError('Titan is not connected yet: add TITAN_API_KEY to the server settings.');
  const r = await send(`${config.titanBase.replace(/\/$/, '')}${path}`, {
    method, signal: AbortSignal.timeout(30_000), body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${config.titanKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new UserError(`Titan answered ${r.status}${j?.error ? ` (${j.error}${j.message ? `: ${j.message}` : ''})` : ''}.`);
  return j;
}
/** Titan lists come as an array or wrapped ({ data | items | sites | devices | readings: [...] }). */
const list = (j: any, ...keys: string[]): any[] => Array.isArray(j) ? j : (['data', 'items', ...keys].map((k) => j?.[k]).find(Array.isArray) ?? []);
const str = (...v: unknown[]) => { const x = v.find((y) => y !== undefined && y !== null && String(y) !== ''); return x === undefined ? '' : String(x); };

// ---------- sites and devices ----------
export interface Site { id: string; name: string; externalRef: string | null }
export const sites = async (): Promise<Site[]> => list(await titan('/sites'), 'sites').map((s) => ({ id: str(s.id, s.siteId), name: str(s.name), externalRef: s.externalRef ?? s.external_ref ?? null }));

/** Match Titan sites to warehouses: by external reference (the warehouse code), then by the same name. Hand-made links are kept. */
export async function matchSites(all: Site[]) {
  const whs = await db.all<{ id: string; code: string; name: string; titan_site_id: string | null }>(`SELECT id, code, name, titan_site_id FROM warehouses WHERE status <> 'closed'`);
  const matched: { site: Site; wh: string }[] = [], unmatched: Site[] = [];
  for (const s of all) {
    const linked = whs.find((w) => w.titan_site_id === s.id);
    const w = linked ?? whs.find((x) => !x.titan_site_id && s.externalRef && x.code === s.externalRef.trim().toUpperCase())
      ?? whs.find((x) => !x.titan_site_id && x.name.trim().toLowerCase() === s.name.trim().toLowerCase());
    if (!w) { unmatched.push(s); continue; }
    if (!linked) { await db.run('UPDATE warehouses SET titan_site_id=$2 WHERE id=$1', w.id, s.id); w.titan_site_id = s.id; }
    matched.push({ site: s, wh: w.id });
  }
  return { matched, unmatched };
}

async function syncDevices(siteId: string, whId: string) {
  const devs = list(await titan(`/devices?site=${encodeURIComponent(siteId)}`), 'devices');
  for (const d of devs) {
    const ref = str(d.id, d.deviceId, d.dev, d.ref);
    if (!ref) continue;
    await upsertDevice(whId, ref, str(d.name, d.label, d.location, ref));
    await db.run('UPDATE sensor_devices SET active=$2 WHERE device_ref=$1', ref.slice(0, 80), d.status !== 'disabled');
  }
  return devs.length;
}

// ---------- readings ----------
/** Turn Titan reading rows into one reading per device per moment. Several air sensors on one device at the same
 *  moment: the worst (highest) value counts, since limits are about the worst spot. Faulty values are dropped. */
export function toReadings(rows: any[]) {
  const by = new Map<string, Map<string, Reading>>();
  for (const x of rows) {
    if (x.quality === 'fault' || x.q === 'fault') continue;
    const dev = str(x.device, x.deviceId, x.dev), metric = str(x.metric, x.m);
    const t = x.time ?? x.at ?? x.ts ?? x.t;
    const at = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : new Date(String(t));
    const v = Number(x.value ?? x.v ?? x.avg);
    if (!dev || !Number.isFinite(at.getTime()) || !Number.isFinite(v)) continue;
    const per = by.get(dev) ?? new Map<string, Reading>(); by.set(dev, per);
    const key = at.toISOString();
    const r = per.get(key) ?? { at: key }; per.set(key, r);
    const hi = (a: number | null | undefined, b: number) => (a == null ? b : Math.max(a, b));
    if (metric === 'air.temperature') r.temp_c = hi(r.temp_c, v);
    else if (metric === 'air.humidity') r.rh_pct = hi(r.rh_pct, v);
    else if (metric === 'security.door') r.door_open = !!r.door_open || v >= 0.5;
    else if (metric === 'power.battery_soc') r.battery_pct = v;
  }
  return [...by].map(([device, m]) => ({ device, readings: [...m.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))) }));
}

async function store(groups: ReturnType<typeof toReadings>) {
  let stored = 0; const unknown: string[] = [];
  for (const g of groups) {
    if (!(await db.val('SELECT 1 FROM sensor_devices WHERE device_ref=$1 AND active', g.device))) { unknown.push(g.device); continue; }
    stored += (await recordReadings(g.device, g.readings)).stored;
  }
  return { stored, unknown };
}

async function syncReadings(siteId: string, whId: string, now: Date) {
  const from = (await db.val<Date>('SELECT titan_synced_to FROM warehouses WHERE id=$1', whId)) ?? new Date(now.getTime() - 24 * 3_600_000);
  const q = new URLSearchParams({ site: siteId, metric: METRICS.join(','), from: new Date(from).toISOString(), to: now.toISOString(), interval: 'raw', limit: '10000' });
  const rows = list(await titan(`/readings?${q}`), 'readings');
  const r = await store(toReadings(rows));
  // Next time, start a few minutes back: readings buffered on a device can arrive late with their original times.
  await db.run('UPDATE warehouses SET titan_synced_to=$2 WHERE id=$1', whId, new Date(now.getTime() - 15 * 60_000));
  return { rows: rows.length, ...r };
}

// ---------- alerts ----------
const ALERT_KIND: Record<string, SensorKind> = { tamper: 'tamper', intruder_detected: 'intruder', power_lost: 'power_lost', sensor_error: 'sensor_error' };

/** One Titan alert, opened or resolved. Alerts StorageX works out itself (thresholds, doors, offline) are skipped. */
export async function applyAlert(a: any, resolved: boolean) {
  const kind = ALERT_KIND[str(a.code, a.type)];
  if (!kind) return false;
  const siteId = str(a.site, a.siteId, a.site_id, a.site?.id);
  const devRef = str(a.device, a.deviceId, a.device_id, a.device?.id);
  const dev = devRef ? await db.get<{ id: string; label: string; warehouse_id: string }>('SELECT id, label, warehouse_id FROM sensor_devices WHERE device_ref=$1', devRef) : undefined;
  const whId = dev?.warehouse_id ?? (siteId ? await db.val<string>('SELECT id FROM warehouses WHERE titan_site_id=$1', siteId) : undefined);
  if (!whId) return false;
  const at = new Date(str(a.openedAt, a.opened_at, a.createdAt, a.created_at, a.at) || Date.now());
  await externalCondition(whId, dev?.id ?? null, dev?.label ?? null, kind, !resolved, Number.isFinite(at.getTime()) ? at : new Date());
  return true;
}

async function syncAlerts(siteId: string) {
  let n = 0;
  for (const a of list(await titan(`/alerts?site=${encodeURIComponent(siteId)}&status=open`), 'alerts')) if (await applyAlert({ site: siteId, ...a }, false)) n++;
  return n;
}

// ---------- the job ----------
/** Every 10 minutes (with the WareGuard sweep): sites, devices, readings since last time, open Titan alerts. */
export async function sync(now = new Date()) {
  if (!connected()) return null;
  const result: any = { at: now.toISOString(), sites: 0, matched: 0, unmatched: [] as string[], devices: 0, readings: 0, stored: 0, unknown: [] as string[], alerts: 0, errors: [] as string[] };
  try {
    const all = await sites(); result.sites = all.length;
    const m = await matchSites(all);
    result.matched = m.matched.length; result.unmatched = m.unmatched.map((s) => `${s.name}${s.externalRef ? ` (${s.externalRef})` : ''}`);
    for (const { site, wh } of m.matched) {
      try {
        result.devices += await syncDevices(site.id, wh);
        const r = await syncReadings(site.id, wh, now); result.readings += r.rows; result.stored += r.stored; result.unknown.push(...r.unknown);
        result.alerts += await syncAlerts(site.id).catch(() => 0);
      } catch (e: any) { result.errors.push(`${site.name}: ${e.message}`); }
    }
  } catch (e: any) { result.errors.push(e.message); }
  await db.run(`INSERT INTO titan_link (id, last_sync_at, last_result) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET last_sync_at=$1, last_result=$2`, now, JSON.stringify(result));
  return result;
}

// ---------- webhook ----------
/** Ask Titan to tell StorageX of changes. Run once after the key is in place; again replaces the old subscription. */
export async function subscribe() {
  const url = `${config.baseUrl.replace(/\/$/, '')}/hooks/titan`;
  if (!url.startsWith('https://')) throw new UserError('Titan sends webhooks only to https addresses: set BASE_URL to the live https address first.');
  const old = await db.val<string>('SELECT webhook_id FROM titan_link WHERE id=1');
  if (old) await titan(`/webhooks/${encodeURIComponent(old)}`, 'DELETE').catch(() => undefined);
  const r = await titan('/webhooks', 'POST', { url, events: EVENTS });
  const secret = str(r.secret, r.data?.secret), id = str(r.id, r.data?.id);
  if (!secret) throw new UserError('Titan did not return a signing secret for the webhook.');
  await db.run(`INSERT INTO titan_link (id, webhook_id, secret_enc, connected_at) VALUES (1, $1, $2, now())
    ON CONFLICT (id) DO UPDATE SET webhook_id=$1, secret_enc=$2, connected_at=now()`, id || null, encrypt(secret));
  await audit(systemActor('titan'), 'titan.webhook_subscribed', { data: { url, events: EVENTS, webhook: id || null } });
  return { url, id };
}

/** Titan signs each call: X-Titan-Signature t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">, within 5 minutes. */
export async function validSignature(raw: string, header: string, now = Date.now()) {
  const box = await db.val<string>('SELECT secret_enc FROM titan_link WHERE id=1');
  if (!box) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t), v1 = String(parts.v1 ?? '');
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const want = crypto.createHmac('sha256', decrypt(box)).update(`${t}.${raw}`).digest();
  return crypto.timingSafeEqual(want, Buffer.from(v1, 'hex'));
}

/** One webhook call from Titan. Each event is handled once. */
export async function handleEvent(e: any, raw: string) {
  const type = str(e?.event, e?.type);
  const d = e?.data ?? {};
  const key = str(d.id, d.alertId, d.seq && `${str(d.dev, d.device)}:${d.seq}`) || crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  const fresh = await db.val(`INSERT INTO provider_events (provider, event_key, type) VALUES ('titan', $1, $2) ON CONFLICT DO NOTHING RETURNING 1`, `${type}:${key}`, type);
  if (!fresh) return 'duplicate';
  if (type === 'reading.created') {
    // A reading message: { dev, ts, r: [{ m, v, ch }] } or rows like the readings API.
    const dev = str(d.dev, d.device, d.deviceId);
    const ts = d.ts ?? d.time ?? d.at;
    const rows = Array.isArray(d.r) ? d.r.map((x: any) => (Array.isArray(x) ? { m: x[0], v: x[1] } : x)).map((x: any) => ({ ...x, dev, ts: x.ts ?? ts }))
      : Array.isArray(d.readings) ? d.readings.map((x: any) => ({ dev, ...x })) : [{ dev, ...d, ts }];
    const r = await store(toReadings(rows));
    return `stored ${r.stored}`;
  }
  if (type === 'alert.opened' || type === 'alert.resolved') return (await applyAlert(d, type === 'alert.resolved')) ? 'applied' : 'not for StorageX';
  if (type === 'device.online' || type === 'device.offline') {
    const dev = str(d.id, d.deviceId, d.device, d.dev);
    if (dev && type === 'device.online') await db.run('UPDATE sensor_devices SET last_seen_at=GREATEST(COALESCE(last_seen_at, \'epoch\'), now()) WHERE device_ref=$1', dev);
    return 'noted';   // offline is worked out by StorageX's own sweep, against its own limit
  }
  return 'ignored';
}

// ---------- linking by hand, and status ----------
export async function linkSite(a: Actor, whCode: string, siteId: string) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'warehouses.edit')) throw new UserError('Only Kitovu links warehouses to Titan.');
  const id = clean(siteId, 80);
  const w = await db.get<{ id: string; code: string }>('SELECT id, code FROM warehouses WHERE code=upper($1)', clean(whCode, 20));
  if (!w) throw new UserError('Warehouse not found.');
  if (id && (await db.val('SELECT 1 FROM warehouses WHERE titan_site_id=$1 AND id<>$2', id, w.id))) throw new UserError('That Titan site is already linked to another warehouse.');
  await db.run('UPDATE warehouses SET titan_site_id=$2, titan_synced_to=NULL WHERE id=$1', w.id, id || null);
  await audit(actorOf(a), 'titan.site_linked', { entity: 'warehouse', entityId: w.id, data: { code: w.code, site: id || null } });
}
export const status = () => db.get<{ webhook_id: string | null; has_secret: boolean; last_sync_at: Date | null; last_result: any }>(
  'SELECT webhook_id, secret_enc IS NOT NULL AS has_secret, last_sync_at, last_result FROM titan_link WHERE id=1');
