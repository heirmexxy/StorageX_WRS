// Live price feed. Each morning (before the daily valuation) StorageX reads PRICE_FEED_URL and adds what it
// finds as pending prices from the source "Live price feed". A Kitovu person approves them like any other
// price, so a broken feed can never move a loan's value on its own.
//
// Format (JSON), any provider that can produce it, or a small adapter in front of one:
//   { "prices": [ { "commodity_code": "MAZ", "state_code": "OY", "market": "Bodija", "observed_on": "2026-11-19",
//                   "naira_per_kg": 610 } ] }     (or "kobo_per_kg": 61000)
import { db } from './db';
import { config } from './config';
import { audit, systemActor } from './audit';

type Fetch = (url: string, init: any) => Promise<{ status: number; json(): Promise<any> }>;
export const connected = () => !!config.priceFeedUrl;

export async function importFeed(send: Fetch = fetch as any) {
  if (!connected()) return { read: 0, added: 0, skipped: 0, error: 'not configured' };
  const r = await send(config.priceFeedUrl, { headers: { Accept: 'application/json', ...(config.priceFeedToken ? { Authorization: `Bearer ${config.priceFeedToken}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (r.status !== 200) {
    await audit(systemActor('price-feed'), 'prices.feed_failed', { data: { http: r.status } });
    return { read: 0, added: 0, skipped: 0, error: `HTTP ${r.status}` };
  }
  const j = await r.json().catch(() => null);
  const rows: any[] = Array.isArray(j?.prices) ? j.prices.slice(0, 5000) : [];
  const src = (await db.val<string>(`SELECT id FROM price_sources WHERE name='Live price feed'`))!;
  const sys = (await db.val<string>(`SELECT id FROM users WHERE email='system@storagex.invalid'`))!;
  const crops = new Set((await db.all<{ code: string }>('SELECT code FROM commodities')).map((x) => x.code));
  const states = new Set((await db.all<{ code: string }>('SELECT code FROM states')).map((x) => x.code));
  let added = 0, skipped = 0;
  for (const p of rows) {
    const code = String(p.commodity_code ?? '').toUpperCase(), st = p.state_code ? String(p.state_code).toUpperCase() : null;
    const kobo = p.kobo_per_kg != null ? Math.round(Number(p.kobo_per_kg)) : Math.round(Number(p.naira_per_kg) * 100);
    const day = String(p.observed_on ?? '');
    const market = String(p.market ?? '').trim().slice(0, 120);
    const age = (Date.now() - new Date(day + 'T12:00:00Z').getTime()) / 86_400_000;
    if (!crops.has(code) || (st && !states.has(st)) || !(kobo > 0 && kobo < 100_000_000) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || age < -1 || age > 30 || market.length < 2) { skipped++; continue; }
    const n = await db.run(`INSERT INTO price_observations (commodity_code, state_code, market, source_id, observed_on, unit, price_quoted_kobo, kobo_per_kg, note, entered_by)
      VALUES ($1,$2,$3,$4,$5,'kg',$6,$6,$7,$8) ON CONFLICT DO NOTHING`, code, st, market, src, day, kobo, `feed: ${String(p.source ?? 'live feed').slice(0, 80)}`, sys);
    if (n) added++; else skipped++;
  }
  await audit(systemActor('price-feed'), 'prices.feed_imported', { data: { read: rows.length, added, skipped } });
  return { read: rows.length, added, skipped, error: null };
}
export const lastImport = () => db.get<{ at: Date; data: any }>(`SELECT at, data FROM audit_log WHERE action IN ('prices.feed_imported','prices.feed_failed') ORDER BY at DESC LIMIT 1`).catch(() => null);
