// Data steward: a daily sweep of the registry for problems people fix: likely duplicate farmers, missing
// locations, agents registering farmers on their own phone, warehouses with stock but no insurance, dormant
// accounts. It opens one review item per problem, refreshes it while the problem lasts and closes it when the
// problem is gone. If a person closes an item as "not a problem", the steward does not raise the same thing again.
import { db, tx } from '../db';
import { audit, systemActor } from '../audit';
import { getSettings } from '../settings';
import { similar } from '../registry';

export const ACTOR = 'system:data-steward';
type Sev = 'info' | 'review' | 'blocker';
interface Finding { entity: 'farmer' | 'warehouse' | 'field_partner' | 'receipt' | 'user'; id: string; code: string; severity: Sev; detail: string }

/** What each finding means, for the review queue. */
export const EXPLAIN: Record<string, string> = {
  farmer_possible_duplicate: 'Two records may be the same person. Merge them, or close the item if they are different people.',
  farmer_no_state: 'No state recorded, so prices and reports cannot place this farmer.',
  farmer_single_name: 'Only one name recorded. Lenders and ID checks need the full name.',
  farmer_phone_unconfirmed_with_stock: 'Has produce in store but the phone is not confirmed, so the farmer gets no texts about it.',
  farmer_unverified_with_delivery: 'Delivered over a week ago but the identity is still not checked, so no receipt can be issued.',
  farmer_inactive_with_stock: 'The record is not active but still owns produce in store.',
  field_partner_shares_farmer_phone: 'A field partner’s phone is on farmer records: farmers may have been registered on the agent’s number.',
  warehouse_no_location: 'No map location, so the gate app cannot check deliveries are recorded at the warehouse.',
  warehouse_no_capacity: 'No capacity recorded, so the intake inspector cannot spot more stock than the building holds.',
  warehouse_uninsured_with_stock: 'Holds stock with no current, checked insurance policy.',
  warehouse_insurance_expiring: 'The insurance policy ends within 30 days.',
  warehouse_count_overdue: 'Holds stock but has not been counted within the count interval.',
  user_dormant: 'Has access but has not signed in for 90 days. Remove the access if it is no longer needed.',
};

async function findings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const s = await getSettings();
  const LIVE = `('issued','partially_released','pledged','financed','sale_approved','under_exception')`;

  // Possible duplicates: same phone with a similar name, or the same name in the same community and state.
  const fs = await db.all<any>(`SELECT id, code, full_name, phone_e164, community, state_code, created_at FROM farmers WHERE status='active' ORDER BY created_at, code`);
  const byPhone = new Map<string, any[]>(), byPlace = new Map<string, any[]>();
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
  for (const f of fs) {
    if (f.phone_e164) byPhone.set(f.phone_e164, [...(byPhone.get(f.phone_e164) ?? []), f]);
    if (f.community && f.state_code) { const k = `${norm(f.full_name)}|${norm(f.community)}|${f.state_code}`; byPlace.set(k, [...(byPlace.get(k) ?? []), f]); }
  }
  const dupOf = new Map<string, string>();
  for (const group of byPhone.values()) for (let k = 1; k < group.length; k++) {
    const older = group.slice(0, k).find((g) => similar(g.full_name, group[k].full_name));
    if (older) dupOf.set(group[k].id, `${older.code} ${older.full_name} has the same phone and a similar name.`);
  }
  for (const group of byPlace.values()) for (let k = 1; k < group.length; k++)
    if (!dupOf.has(group[k].id)) dupOf.set(group[k].id, `${group[0].code} has the same name in the same community.`);
  for (const [id, detail] of dupOf) out.push({ entity: 'farmer', id, code: 'farmer_possible_duplicate', severity: 'review', detail });

  for (const f of fs) {
    if (!f.state_code) out.push({ entity: 'farmer', id: f.id, code: 'farmer_no_state', severity: 'review', detail: 'No state recorded.' });
    if (f.full_name.trim().split(/\s+/).length < 2) out.push({ entity: 'farmer', id: f.id, code: 'farmer_single_name', severity: 'review', detail: `Name recorded as “${f.full_name}”.` });
  }
  for (const r of await db.all<any>(`SELECT DISTINCT f.id FROM farmers f JOIN receipts r ON r.owner_farmer_id=f.id WHERE r.status IN ${LIVE} AND f.status='active' AND f.phone_verified_at IS NULL AND COALESCE(f.phone_check_method,'') <> 'attested'`))
    out.push({ entity: 'farmer', id: r.id, code: 'farmer_phone_unconfirmed_with_stock', severity: 'review', detail: 'Owns produce in store; phone not confirmed.' });
  for (const r of await db.all<any>(`SELECT f.id, min(i.ref) AS ref FROM farmers f JOIN intakes i ON i.farmer_id=f.id WHERE f.kyc_level=0 AND i.status IN ('submitted','held','accepted')
      AND i.captured_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.intake_id=i.id) GROUP BY f.id`))
    out.push({ entity: 'farmer', id: r.id, code: 'farmer_unverified_with_delivery', severity: 'review', detail: `Delivery ${r.ref} is waiting for the identity check.` });
  for (const r of await db.all<any>(`SELECT f.id, f.status, count(*)::int AS n FROM farmers f JOIN receipts r ON r.owner_farmer_id=f.id WHERE r.status IN ${LIVE} AND f.status<>'active' GROUP BY f.id, f.status`))
    out.push({ entity: 'farmer', id: r.id, code: 'farmer_inactive_with_stock', severity: 'blocker', detail: `Record is ${r.status} but owns ${r.n} live receipt(s).` });

  for (const r of await db.all<any>(`SELECT fp.id, fp.code, count(DISTINCT f.id)::int AS n FROM field_partners fp JOIN farmers f ON f.phone_e164=fp.phone_e164 AND f.status='active'
      WHERE fp.phone_e164 IS NOT NULL AND fp.status='active' GROUP BY fp.id, fp.code`))
    out.push({ entity: 'field_partner', id: r.id, code: 'field_partner_shares_farmer_phone', severity: 'blocker', detail: `${r.n} farmer record(s) use this field partner’s phone number.` });

  const whs = await db.all<any>(`SELECT w.id, w.lat, w.capacity_kg, w.status,
      (SELECT COALESCE(sum(b.remaining_kg),0)::float FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id WHERE r.warehouse_id=w.id AND r.status IN ${LIVE}) AS kg,
      (SELECT max(cover_to) FROM insurance_policies p WHERE p.warehouse_id=w.id AND p.status='active' AND (p.cover_from IS NULL OR p.cover_from <= current_date) AND p.cover_to >= current_date) AS cover_to,
      (SELECT max(counted_at) FROM stock_counts c WHERE c.warehouse_id=w.id) AS counted
    FROM warehouses w WHERE w.status IN ('onboarding','certified','active')`);
  for (const w of whs) {
    if (w.lat == null) out.push({ entity: 'warehouse', id: w.id, code: 'warehouse_no_location', severity: 'review', detail: 'No map location.' });
    if (w.capacity_kg == null) out.push({ entity: 'warehouse', id: w.id, code: 'warehouse_no_capacity', severity: 'review', detail: 'No capacity recorded.' });
    if (w.kg > 0 && !w.cover_to) out.push({ entity: 'warehouse', id: w.id, code: 'warehouse_uninsured_with_stock', severity: 'blocker', detail: `${Math.round(w.kg).toLocaleString('en-NG')} kg in store, no current checked policy.` });
    else if (w.cover_to && new Date(w.cover_to).getTime() - Date.now() < 30 * 86_400_000)
      out.push({ entity: 'warehouse', id: w.id, code: 'warehouse_insurance_expiring', severity: 'review', detail: `Cover ends ${new Date(w.cover_to).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` });
    if (w.kg > 0 && (!w.counted || Date.now() - new Date(w.counted).getTime() > s['stock.count_every_days'] * 86_400_000))
      out.push({ entity: 'warehouse', id: w.id, code: 'warehouse_count_overdue', severity: 'review', detail: w.counted ? `Last counted ${new Date(w.counted).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : 'Never counted.' });
  }

  for (const u of await db.all<any>(`SELECT u.id, u.last_login_at FROM users u WHERE u.status='active' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.status='active')
      AND COALESCE(u.last_login_at, u.created_at) < now() - interval '90 days'`))
    out.push({ entity: 'user', id: u.id, code: 'user_dormant', severity: 'info', detail: u.last_login_at ? `Last signed in ${new Date(u.last_login_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'Has never signed in.' });
  return out;
}

/** One sweep. Safe to run at any time; running twice in a row changes nothing. */
export async function runSteward(startedBy = 'cron') {
  const found = await findings();
  return tx(async () => {
    const run = (await db.val<number>(`INSERT INTO steward_runs (started_by) VALUES ($1) RETURNING id`, startedBy))!;
    const open = await db.all<any>(`SELECT id, entity, entity_id, code, detail FROM data_issues WHERE source='steward' AND resolved_at IS NULL`);
    const key = (e: string, id: string, code: string) => `${e}|${id}|${code}`;
    const openMap = new Map(open.map((o) => [key(o.entity, o.entity_id, o.code), o]));
    const dismissed = new Set((await db.all<any>(`SELECT entity, entity_id, code, detail FROM data_issues WHERE source='steward' AND resolved_at IS NOT NULL AND resolved_by <> $1`, ACTOR))
      .map((d) => key(d.entity, d.entity_id, d.code) + '|' + d.detail));
    let opened = 0, closed = 0;
    const seen = new Set<string>();
    const byCode: Record<string, number> = {};
    for (const f of found) {
      const k = key(f.entity, f.id, f.code);
      if (seen.has(k)) continue;
      seen.add(k);
      byCode[f.code] = (byCode[f.code] ?? 0) + 1;
      const o = openMap.get(k);
      if (o) { await db.run(`UPDATE data_issues SET last_seen_at=now(), detail=$2 WHERE id=$1`, o.id, f.detail); continue; }
      if (dismissed.has(k + '|' + f.detail)) continue;      // a person already said this one is fine
      await db.run(`INSERT INTO data_issues (entity, entity_id, severity, code, detail, source) VALUES ($1,$2,$3,$4,$5,'steward')`, f.entity, f.id, f.severity, f.code, f.detail);
      if (f.entity === 'farmer' && f.severity !== 'info') await db.run('UPDATE farmers SET needs_review=true WHERE id=$1', f.id);
      opened++;
    }
    for (const o of open) if (!seen.has(key(o.entity, o.entity_id, o.code))) {
      await db.run(`UPDATE data_issues SET resolved_at=now(), resolved_by=$2, resolved_note='No longer found by the data steward.' WHERE id=$1`, o.id, ACTOR);
      if (o.entity === 'farmer' && !(await db.val(`SELECT 1 FROM data_issues WHERE entity='farmer' AND entity_id=$1 AND resolved_at IS NULL AND severity<>'info'`, o.entity_id)))
        await db.run('UPDATE farmers SET needs_review=false WHERE id=$1', o.entity_id);
      closed++;
    }
    const stillOpen = Number(await db.val(`SELECT count(*) FROM data_issues WHERE source='steward' AND resolved_at IS NULL`));
    await db.run(`UPDATE steward_runs SET finished_at=now(), opened=$2, closed=$3, still_open=$4, by_code=$5 WHERE id=$1`, run, opened, closed, stillOpen, JSON.stringify(byCode));
    await audit(systemActor('data-steward'), 'steward.run', { data: { run, opened, closed, by: startedBy } });
    return { run, opened, closed, open: stillOpen, byCode };
  });
}

export const lastRun = () => db.get<any>(`SELECT * FROM steward_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`);
