#!/usr/bin/env node
// Legacy StorageX (Laravel/MySQL, 2021–2022) -> StorageX WRS (Postgres) importer.
//
// Usage:  node tools/legacy-import/import.mjs <path/to/storagex_laravel_portal.sql> [outDir]
// Output (outDir, default ./out — git-ignored because it holds personal data):
//   legacy_import.sql   idempotent inserts to run after db/migrations and db/seeds
//   data_issues.csv     every flagged record, for the field team to review
//   import_report.md    counts only, no personal data (safe to commit)
//
// The importer never copies passwords, tokens, WealthX tables or test rows.
// IDs are derived deterministically from legacy IDs, so re-running produces the same rows.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , dumpPath, outDirArg] = process.argv;
if (!dumpPath) { console.error('usage: node import.mjs <legacy dump.sql> [outDir]'); process.exit(1); }
const outDir = outDirArg || 'out';
fs.mkdirSync(outDir, { recursive: true });

const raw = fs.readFileSync(dumpPath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(raw).digest('hex');
const RUN_AT = new Date().toISOString();

// ---------- 1. Parse MySQL INSERT statements ----------
function parseTuples(s, start) {
  const rows = []; let i = start; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ';') break;
    if (c !== '(') { i++; continue; }
    i++; const row = []; let cur = ''; let quoted = false;
    for (;;) {
      const ch = s[i];
      if (ch === "'") {                       // quoted string
        cur = ''; quoted = true; i++;
        for (;;) {
          const q = s[i];
          if (q === '\\') { const e = s[i + 1]; cur += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === '0' ? '' : e; i += 2; continue; }
          if (q === "'") { if (s[i + 1] === "'") { cur += "'"; i += 2; continue; } i++; break; }
          cur += q; i++;
        }
        continue;
      }
      if (ch === ',' || ch === ')') {
        let v = quoted ? cur : cur.trim();
        if (!quoted && v.toUpperCase() === 'NULL') v = null;
        row.push(v); cur = ''; quoted = false; i++;
        if (ch === ')') break;
        continue;
      }
      cur += ch; i++;
    }
    rows.push(row);
  }
  return rows;
}
const tables = {};
for (const m of raw.matchAll(/INSERT INTO `(\w+)` \(([^)]*)\) VALUES\s*/g)) {
  const cols = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
  const rows = parseTuples(raw, m.index + m[0].length).map((r) => Object.fromEntries(cols.map((c, k) => [c, r[k]])));
  (tables[m[1]] ||= []).push(...rows);
}
const T = (name) => tables[name] || [];

// ---------- 2. Helpers ----------
const clean = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim() || null);
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (x) => x.toUpperCase());
function uuidFor(kind, legacyId) {           // deterministic v5-style UUID
  const h = crypto.createHash('sha1').update(`storagex-legacy:${kind}:${legacyId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
function phoneE164(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^0[789][01]\d{8}$/.test(d)) return '+234' + d.slice(1);
  if (/^234[789][01]\d{8}$/.test(d)) return '+' + d;
  if (/^[789][01]\d{8}$/.test(d)) return '+234' + d;
  return null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const SUSPECT_EMAIL_DOMAINS = new Set(['ail.com', 'gmail.co', 'gmai.com', 'gmial.com', 'maill.com', 'yahoo.co']);
function email(v) {
  const e = clean(v)?.toLowerCase();
  if (!e) return { value: null };
  if (!EMAIL_RE.test(e)) return { value: null, issue: 'email_invalid' };
  if (SUSPECT_EMAIL_DOMAINS.has(e.split('@')[1])) return { value: null, issue: 'email_suspect_domain' };
  return { value: e };
}
const sql = (v) => (v == null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : `'${String(v).replace(/'/g, "''")}'`);
const sqlArr = (a) => `ARRAY[${a.map(sql).join(',')}]::text[]`;
const sqlJson = (o) => `${sql(JSON.stringify(o))}::jsonb`;
const lagos = (ts) => (clean(ts) ? clean(ts).replace(' ', 'T') + '+01:00' : null);   // legacy timestamps were local time

// Legacy "locations" were registration hubs: a mix of states and towns.
const LOCATION_MAP = {
  1: { state: 'OY', town: 'Saki' }, 2: { state: 'KD', town: null }, 3: { state: 'KN', town: null },
  4: { state: 'BE', town: 'Makurdi' }, 5: { state: 'OY', town: 'Iseyin' }, 6: { state: 'ON', town: 'Akure' },
  7: { state: 'EB', town: 'Abakaliki' }, 8: { state: 'NI', town: 'Minna' }, 9: { state: 'AB', town: 'Umuahia' },
  10: { state: 'TA', town: null }, 11: { state: 'AD', town: null }, 12: { state: 'GO', town: null }, 13: { state: 'BA', town: null },
};
const STATE_WORDS = { taraba: 'TA', adamawa: 'AD', gombe: 'GO', niger: 'NI', bauchi: 'BA', kaduna: 'KD', kano: 'KN', benue: 'BE', oyo: 'OY' };
// Only LGAs that legacy addresses name explicitly. Matched by word; state must agree.
const LGA_WORDS = [
  { re: /\bkarim\b/i, state: 'TA', name: 'Karim Lamido' },
  { re: /\bganye\b/i, state: 'AD', name: 'Ganye' },
  { re: /\bbill?iri\b/i, state: 'GO', name: 'Billiri' },
];
// "G/CORN" and "guinea corn" mean sorghum, so plain "corn" is never read as maize.
const COMMODITY_WORDS = [
  [/rice/i, 'RCE'], [/maize/i, 'MAZ'], [/guinea\s*corn|g\/corn|sorghum/i, 'SGM'], [/soya|soy\s*bean/i, 'SBN'],
  [/\bbeans?\b/i, 'BNS'], [/beni\s*seed|sesame/i, 'SES'], [/millet/i, 'MLT'],
];
function commoditiesFrom(text) {
  const t = String(text || '').replace(/soya\s*beans?|soyabeans?/ig, ' soya ');   // so "soya beans" is not also read as beans
  return COMMODITY_WORDS.filter(([re]) => re.test(t)).map(([, code]) => code).sort();
}

// ---------- 3. Decisions taken by review (documented in docs/migration/legacy-import.md) ----------
const EXCLUDED_FARMERS = { 105: 'test record (placeholder email, nonsense produce and registration number)' };
const EXCLUDED_PARTNERS = { 1: 'test record (placeholder overseas address)' };

// ---------- 4. Transform ----------
const issues = [];
const issue = (entity, entityId, legacyRef, severity, code, detail) => issues.push({ entity, entityId, legacyRef, severity, code, detail });
const out = [];
const emit = (s) => out.push(s);

const batchId = uuidFor('batch', sourceHash);
const KITOVU = "(SELECT id FROM organisations WHERE code='KITOVU')";

// LGAs referenced by addresses
const lgaRows = new Map();

// Farmers
const farmersRaw = T('farmers').map((f) => ({
  id: Number(f.id), reg: clean(f.reg_number), name: clean(f.full_name), loc: Number(f.location_id), photo: clean(f.photo),
  email: f.email, mobile: clean(f.mobile), address: clean(f.address), produce: clean(f.produce_description),
}));
const kept = farmersRaw.filter((f) => !EXCLUDED_FARMERS[f.id]);
// Exact duplicates: same name (case-insensitive) and same phone -> merge into the lowest legacy id.
const byKey = new Map();
for (const f of kept) {
  const k = `${(f.name || '').toLowerCase()}|${phoneE164(f.mobile) || f.mobile}`;
  (byKey.get(k) || byKey.set(k, []).get(k)).push(f);
}
const mergedInto = new Map();
for (const group of byKey.values()) if (group.length > 1) {
  group.sort((a, b) => a.id - b.id);
  for (const d of group.slice(1)) mergedInto.set(d.id, group[0].id);
}
// Shared phones with different names (household phones) -> keep both, note it.
const byPhone = new Map();
for (const f of kept) { const p = phoneE164(f.mobile); if (p && !mergedInto.has(f.id)) (byPhone.get(p) || byPhone.set(p, []).get(p)).push(f.id); }
const sharedPhone = new Set([...byPhone.values()].filter((v) => v.length > 1).flat());

const farmerCounts = { total: farmersRaw.length, imported: 0, merged: 0, excluded: 0, needs_review: 0, by_state: {} };
for (const f of farmersRaw) {
  const id = uuidFor('farmer', f.id); const code = `SXF-${String(f.id).padStart(6, '0')}`; const ref = `farmers.id=${f.id}`;
  const loc = LOCATION_MAP[f.loc] || {};
  let review = false;
  const isMerged = mergedInto.has(f.id);   // merged rows only carry the merge note; the kept row carries any issues
  const flag = (sev, c, d) => { if (isMerged) return; issue('farmer', id, ref, sev, c, d); if (sev !== 'info') review = true; };

  if (EXCLUDED_FARMERS[f.id]) { farmerCounts.excluded++; issue('farmer', null, ref, 'info', 'excluded_test_record', EXCLUDED_FARMERS[f.id]); continue; }

  const phone = phoneE164(f.mobile);
  if (!phone) flag('review', 'phone_invalid', 'Phone could not be normalised to +234 format');
  if (sharedPhone.has(f.id)) flag('info', 'phone_shared', 'Phone is shared with another farmer of a different name (likely a household phone)');
  const em = email(f.email);
  if (em.issue) flag('review', em.issue, 'Email not imported; check the address with the farmer');

  const commodities = commoditiesFrom(f.produce);
  if (!commodities.length) flag('review', 'commodity_unrecognised', 'Produce description did not match any commodity');

  const state = loc.state || null;
  if (!state) flag('review', 'state_unknown', 'Legacy location could not be mapped to a state');
  const addrState = Object.entries(STATE_WORDS).find(([w]) => new RegExp(`\\b${w}\\b`, 'i').test(f.address || ''))?.[1];
  if (addrState && state && addrState !== state) flag('review', 'state_conflict', `Registration hub says ${state} but the address names ${addrState}`);

  let lgaName = null;
  for (const l of LGA_WORDS) if (l.re.test(f.address || '')) {
    if (l.state === state) { lgaName = l.name; lgaRows.set(`${l.state}|${l.name}`, { state: l.state, name: l.name }); }
    else flag('review', 'lga_state_conflict', `Address names ${l.name} LGA (${l.state}) but farmer state is ${state}`);
  }
  const addrIsOnlyState = /^(\w+)(\s+state)?$/i.test(f.address || '') && STATE_WORDS[(f.address || '').split(/\s+/)[0].toLowerCase()];
  const community = f.address && !addrIsOnlyState ? titleCase(f.address.replace(/\b(lga|state)\b/ig, '').replace(/\s*,\s*$/, '').trim()) : null;
  if (!lgaName && state) flag('info', 'lga_missing', 'LGA not recorded in legacy data; confirm during re-verification');

  const merged = mergedInto.get(f.id);
  const status = merged ? 'merged' : 'active';
  if (merged) { farmerCounts.merged++; issue('farmer', id, ref, 'info', 'merged_duplicate', `Same name and phone as legacy farmer ${merged}; merged`); }
  else { farmerCounts.imported++; farmerCounts.by_state[state] = (farmerCounts.by_state[state] || 0) + 1; if (review) farmerCounts.needs_review++; }

  const legacy = { system: 'storagex-laravel-2022', id: f.id, reg_number: f.reg, location_id: f.loc, photo_file: f.photo, raw_produce: f.produce, raw_mobile: f.mobile, raw_email: clean(f.email), batch: batchId };
  emit(`INSERT INTO farmers (id, code, full_name, phone_e164, email, state_code, lga_id, community, address_text, commodities, kyc, status, merged_into, needs_review, source, legacy)
VALUES (${sql(id)}, ${sql(code)}, ${sql(titleCase(f.name || 'Unknown'))}, ${sql(phone)}, ${sql(em.value)}, ${sql(state)}, ${lgaName ? `(SELECT id FROM lgas WHERE state_code=${sql(state)} AND name=${sql(lgaName)})` : 'NULL'}, ${sql(community)}, ${sql(f.address)}, ${sqlArr(commodities)}, 'not_started', ${sql(status)}, ${merged ? sql(uuidFor('farmer', merged)) : 'NULL'}, ${sql(review && !merged)}, 'legacy_import', ${sqlJson(legacy)})
ON CONFLICT (code) DO NOTHING;`);
}

// Field partners (legacy users with the Agent role). Passwords and tokens are never copied.
const roles = Object.fromEntries(T('user_roles').map((r) => [r.id, clean(r.role_code)]));
const agentCounts = { imported: 0, skipped_non_agent_accounts: 0 };
for (const u of T('users')) {
  if (roles[u.role_id] !== 'AGENT') { agentCounts.skipped_non_agent_accounts++; continue; }
  const id = uuidFor('agent', u.id); const ref = `users.id=${u.id}`;
  const phone = phoneE164(u.phone); const em = email(u.email);
  if (!phone) issue('field_partner', id, ref, 'review', 'phone_invalid', 'Phone could not be normalised');
  if (em.issue) issue('field_partner', id, ref, 'review', em.issue, 'Email not imported');
  agentCounts.imported++;
  emit(`INSERT INTO field_partners (id, code, full_name, phone_e164, email, org_id, status, source, legacy)
VALUES (${sql(id)}, ${sql(`SXA-${String(u.id).padStart(5, '0')}`)}, ${sql(titleCase(clean(u.full_name) || 'Unknown'))}, ${sql(phone)}, ${sql(em.value)}, ${KITOVU}, 'legacy_unverified', 'legacy_import', ${sqlJson({ system: 'storagex-laravel-2022', id: Number(u.id), created_at: clean(u.created_at), batch: batchId })})
ON CONFLICT (code) DO NOTHING;`);
}

// Warehouses
const WAREHOUSE_MAP = {
  1: { code: 'WH-NI-MNA-01', name: 'Limawa Warehouse, Minna', state: 'NI', town: 'Minna' },
  2: { code: 'WH-GO-BLR-01', name: 'Billiri Warehouse', state: 'GO', town: 'Billiri', lga: 'Billiri' },
};
const warehouseIds = {};
for (const w of T('warehouses')) {
  const m = WAREHOUSE_MAP[w.id]; const id = uuidFor('warehouse', w.id); warehouseIds[w.id] = { id, ...m };
  const ref = `warehouses.id=${w.id}`;
  if (m.lga) lgaRows.set(`${m.state}|${m.lga}`, { state: m.state, name: m.lga });
  issue('warehouse', id, ref, 'review', 'status_unconfirmed', 'Imported as dormant, Tier A (Kitovu-operated). Confirm whether the site is still leased and operating');
  issue('warehouse', id, ref, 'review', 'profile_incomplete', 'Capacity, GPS coordinates and supported commodities were not recorded; capture on the next site visit');
  emit(`INSERT INTO warehouses (id, code, name, operator_org_id, tier, status, state_code, lga_id, town, address_text, needs_review, legacy)
VALUES (${sql(id)}, ${sql(m.code)}, ${sql(m.name)}, ${KITOVU}, 'A', 'dormant', ${sql(m.state)}, ${m.lga ? `(SELECT id FROM lgas WHERE state_code=${sql(m.state)} AND name=${sql(m.lga)})` : 'NULL'}, ${sql(m.town)}, ${sql(clean(w.description))}, true, ${sqlJson({ system: 'storagex-laravel-2022', id: Number(w.id), name: clean(w.name), location_id: Number(w.location_id), created_at: clean(w.created_at), batch: batchId })})
ON CONFLICT (code) DO NOTHING;`);
  if (clean(w.insurance)) {
    issue('insurance_policy', null, ref, 'review', 'policy_unverified', 'Legacy policy imported as unverified; obtain the schedule and current cover dates from the insurer');
    emit(`INSERT INTO insurance_policies (id, warehouse_id, insurer_name, policy_number, status, legacy)
VALUES (${sql(uuidFor('policy', w.id))}, ${sql(id)}, ${sql(clean(w.insurance))}, ${sql(clean(w.policy_number))}, 'unverified', ${sqlJson({ source: 'warehouses.insurance', batch: batchId })})
ON CONFLICT (id) DO NOTHING;`);
  }
}

// Receipts: every legacy stock has been liquidated, so each becomes a closed historical receipt with two events.
const COMMODITY_BY_LEGACY_ID = Object.fromEntries(T('commodities').map((c) => [c.id, clean(c.code)]));
const receiptCounts = { imported: 0 };
const seqByWhDay = {};
for (const r of T('farmer_storages')) {
  const id = uuidFor('receipt', r.id); const ref = `farmer_storages.id=${r.id}`;
  const wh = warehouseIds[r.ware_house_id]; const commodity = COMMODITY_BY_LEGACY_ID[r.commodity_id];
  const issued = lagos(r.date_receipt_generated);
  const ymd = issued.slice(2, 10).replace(/-/g, '');
  const key = `${wh.code}|${ymd}`; seqByWhDay[key] = (seqByWhDay[key] || 0) + 1;
  const receiptNo = `SX-${wh.code.slice(3, 5)}-${wh.code.split('-')[2]}-${ymd}-${String(seqByWhDay[key]).padStart(4, '0')}`;
  const kg = Number(r.qty); const priceKobo = Math.round(Number(r.price) * 100); const valueKobo = Math.round(Number(r.value_amount) * 100);
  if (Math.abs(Math.round(kg * Number(r.price) * 100) - valueKobo) > 100) issue('receipt', id, ref, 'review', 'value_mismatch', 'Recorded value does not equal quantity x price');
  const farmerLegacy = mergedInto.get(Number(r.farmer_id)) || Number(r.farmer_id);
  const farmer = uuidFor('farmer', farmerLegacy);
  issue('receipt', id, ref, 'info', 'closed_on_import', 'Stock liquidated before migration; sale date and proceeds were not recorded in the legacy system');
  issue('receipt', id, ref, 'info', 'quality_not_recorded', 'Grade, moisture and bag count were not captured in 2022');
  receiptCounts.imported++;
  emit(`INSERT INTO receipts (id, receipt_no, depositor_farmer_id, owner_farmer_id, warehouse_id, commodity_code, net_weight_kg, unit_price_kobo, value_kobo, status, issued_at, closed_at, closed_reason, source, legacy)
VALUES (${sql(id)}, ${sql(receiptNo)}, ${sql(farmer)}, ${sql(farmer)}, ${sql(wh.id)}, ${sql(commodity)}, ${kg.toFixed(2)}, ${priceKobo}, ${valueKobo}, 'closed', ${sql(issued)}, ${sql(RUN_AT)}, 'Liquidated before migration to StorageX WRS; sale date not recorded', 'legacy_import', ${sqlJson({ system: 'storagex-laravel-2022', id: Number(r.id), receipt: clean(r.receipt), farmer_id: Number(r.farmer_id), created_by: Number(r.created_by), batch: batchId })})
ON CONFLICT (receipt_no) DO NOTHING;`);
  emit(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data)
SELECT ${sql(id)}, 'issued', ${sql(issued)}, 'system:legacy_import', ${sqlJson({ legacy_receipt: clean(r.receipt), net_weight_kg: kg, unit_price_kobo: priceKobo, value_kobo: valueKobo })}
WHERE NOT EXISTS (SELECT 1 FROM receipt_events WHERE receipt_id=${sql(id)} AND event_type='issued');`);
  emit(`INSERT INTO receipt_events (receipt_id, event_type, occurred_at, actor, data)
SELECT ${sql(id)}, 'closed', ${sql(RUN_AT)}, 'system:legacy_import', ${sqlJson({ reason: 'liquidated_before_migration', sale_date_known: false })}
WHERE NOT EXISTS (SELECT 1 FROM receipt_events WHERE receipt_id=${sql(id)} AND event_type='closed');`);
}

// Partners table held one test row only.
for (const p of T('partners')) if (EXCLUDED_PARTNERS[p.id]) issue('organisation', null, `partners.id=${p.id}`, 'info', 'excluded_test_record', EXCLUDED_PARTNERS[p.id]);

// ---------- 5. Write outputs ----------
const summary = { farmers: farmerCounts, field_partners: agentCounts, warehouses: Object.keys(warehouseIds).length, receipts: receiptCounts, issues: issues.length };
const lgaSql = [...lgaRows.values()].map((l) => `INSERT INTO lgas (state_code, name, source) VALUES (${sql(l.state)}, ${sql(l.name)}, 'legacy_import') ON CONFLICT (state_code, name) DO NOTHING;`);
const issueSql = issues.map((i) => `INSERT INTO data_issues (batch_id, entity, entity_id, legacy_ref, severity, code, detail) VALUES (${sql(batchId)}, ${sql(i.entity)}, ${sql(i.entityId)}, ${sql(i.legacyRef)}, ${sql(i.severity)}, ${sql(i.code)}, ${sql(i.detail)});`);
const header = `-- Generated by tools/legacy-import/import.mjs at ${RUN_AT}\n-- Source sha256: ${sourceHash}\n-- Contains personal data. Do not commit.\nBEGIN;\n`;
const batchSql = `INSERT INTO import_batches (id, source, source_hash, summary) VALUES (${sql(batchId)}, 'storagex_laravel_portal.sql', ${sql(sourceHash)}, ${sqlJson(summary)}) ON CONFLICT (id) DO NOTHING;
DELETE FROM data_issues WHERE batch_id=${sql(batchId)} AND resolved_at IS NULL;`;
fs.writeFileSync(path.join(outDir, 'legacy_import.sql'), [header, batchSql, ...lgaSql, ...out, ...issueSql, 'COMMIT;', ''].join('\n'));

const names = Object.fromEntries(farmersRaw.map((f) => [`farmers.id=${f.id}`, f.name]));
const csv = [['severity', 'entity', 'legacy_ref', 'name', 'code', 'detail'].join(',')]
  .concat(issues.sort((a, b) => ['blocker', 'review', 'info'].indexOf(a.severity) - ['blocker', 'review', 'info'].indexOf(b.severity))
    .map((i) => [i.severity, i.entity, i.legacyRef, names[i.legacyRef] || '', i.code, i.detail].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
fs.writeFileSync(path.join(outDir, 'data_issues.csv'), csv.join('\n') + '\n');

const countBy = (sev) => Object.entries(issues.filter((i) => i.severity === sev).reduce((a, i) => ((a[`${i.entity}: ${i.code}`] = (a[`${i.entity}: ${i.code}`] || 0) + 1), a), {}));
const report = `# Legacy import report

Generated ${RUN_AT}. Source dump sha256 \`${sourceHash.slice(0, 16)}…\`. This report holds counts only.

| Entity | Result |
| --- | --- |
| Farmers in legacy dump | ${farmerCounts.total} |
| Farmers imported (active) | ${farmerCounts.imported} |
| Merged exact duplicates (same name and phone) | ${farmerCounts.merged} |
| Excluded test records | ${farmerCounts.excluded} |
| Active farmers flagged for review | ${farmerCounts.needs_review} |
| Field partners imported (status legacy_unverified) | ${agentCounts.imported} |
| Legacy admin/partner accounts not imported | ${agentCounts.skipped_non_agent_accounts} |
| Warehouses imported (dormant, Tier A) | ${summary.warehouses} |
| Receipts imported (closed) | ${receiptCounts.imported} |

Active farmers by state: ${Object.entries(farmerCounts.by_state).map(([s, n]) => `${s} ${n}`).join(', ')}.

## Issues needing review

| Issue | Count |
| --- | --- |
${countBy('review').map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| none | 0 |'}

## Informational

| Note | Count |
| --- | --- |
${countBy('info').map(([k, v]) => `| ${k} | ${v} |`).join('\n')}
`;
fs.writeFileSync(path.join(outDir, 'import_report.md'), report);
console.log(JSON.stringify(summary, null, 2));
