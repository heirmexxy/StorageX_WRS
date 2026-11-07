// The registry: farmers, field partners, warehouses and the data-quality review queue.
// Who sees which farmer:
//   Kitovu staff with farmers.view       every farmer
//   a lender                             only farmers with an active consent to share with that lender
//   a field partner network / co-op      farmers registered by its own people or its field partners
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can, type Permission } from './rbac';
import { UserError } from './errors';
import { normPhone, clean } from './util';

export class NotAllowed extends UserError {}
function need(a: Actor, perm: Permission, msg = 'Your role does not allow this.') { if (!can(a.membership, perm)) throw new NotAllowed(msg); }
const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';

// ---------- farmers ----------
export interface Farmer {
  id: string; code: string; full_name: string; phone_e164: string | null; sex: string | null; state_code: string | null; state_name: string | null;
  community: string | null; commodities: string[]; kyc_level: number; status: string; needs_review: boolean; source: string;
  year_of_birth: number | null; phone_verified_at: Date | null; phone_check_method: 'sms' | 'voice' | 'attested' | null; phone_attestation: any; id_type: string | null; id_last4: string | null; created_at: Date; updated_at: Date;
  registered_by_name?: string | null; open_issues?: number;
}

/** SQL condition (on alias f) limiting farmers to what the actor may see; $1 is the actor's org id. */
function farmerScope(a: Actor): { where: string; arg: string | null } {
  const m = a.membership!;
  if (m.org_kind === 'kitovu') return { where: '$1::uuid IS NULL', arg: null };
  if (m.org_kind === 'lender') return { where: `EXISTS (SELECT 1 FROM farmer_consents fc WHERE fc.farmer_id=f.id AND fc.org_id=$1 AND fc.withdrawn_at IS NULL)`, arg: m.org_id };
  return {
    where: `(EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id=f.registered_by_user AND mm.org_id=$1)
             OR EXISTS (SELECT 1 FROM field_partners fp WHERE fp.id=f.registered_by_partner AND fp.org_id=$1))`,
    arg: m.org_id,
  };
}

const FARMER_COLS = `f.id, f.code, f.full_name, f.phone_e164, f.sex, f.state_code, s.name AS state_name, f.community, f.commodities, f.kyc_level, f.status,
  f.needs_review, f.source, f.year_of_birth, f.phone_verified_at, f.phone_check_method, f.phone_attestation, f.id_type, f.id_last4, f.created_at, f.updated_at`;

export async function searchFarmers(a: Actor, q: { text?: string; state?: string; level?: string; review?: string; status?: string } = {}) {
  need(a, 'farmers.view');
  const sc = farmerScope(a);
  const text = clean(q.text, 80);
  const phone = normPhone(text);
  return db.all<Farmer>(
    `SELECT ${FARMER_COLS}, (SELECT count(*)::int FROM data_issues di WHERE di.entity='farmer' AND di.entity_id=f.id AND di.resolved_at IS NULL AND di.severity<>'info') AS open_issues
     FROM farmers f LEFT JOIN states s ON s.code=f.state_code
     WHERE ${sc.where.replace(/\$1/g, '$6')}
       AND ($1 = '' OR f.full_name ILIKE '%' || $1 || '%' OR f.code = upper($1) OR f.phone_e164 = $2 OR f.community ILIKE '%' || $1 || '%')
       AND ($3 = '' OR f.state_code = $3)
       AND ($4 = '' OR f.kyc_level = ($4)::smallint)
       AND ($5 = '' OR f.needs_review)
       AND f.status = $7
     ORDER BY f.needs_review DESC, f.updated_at DESC LIMIT 200`,
    text, phone, clean(q.state, 2).toUpperCase(), /^[012]$/.test(String(q.level)) ? String(q.level) : '', q.review === '1' ? '1' : '', sc.arg,
    ['active', 'inactive', 'merged', 'excluded'].includes(String(q.status)) ? q.status : 'active');
}

export async function farmerByCode(a: Actor, code: string) {
  need(a, 'farmers.view');
  if (!/^SXF-\d{6}$/i.test(code)) return undefined;
  const sc = farmerScope(a);
  return db.get<Farmer>(
    `SELECT ${FARMER_COLS}, COALESCE(u.full_name, fp.full_name) AS registered_by_name
     FROM farmers f LEFT JOIN states s ON s.code=f.state_code LEFT JOIN users u ON u.id=f.registered_by_user LEFT JOIN field_partners fp ON fp.id=f.registered_by_partner
     WHERE f.code=upper($2) AND ${sc.where}`, sc.arg, code);
}

export interface FarmerInput { full_name?: string; phone?: string; sex?: string; state_code?: string; community?: string; commodities?: string | string[]; year_of_birth?: string; field_partner_code?: string; confirm_duplicate?: string }

async function farmerFields(i: FarmerInput) {
  const full_name = clean(i.full_name, 120);
  if (full_name.length < 3 || !/\s/.test(full_name)) throw new UserError('Enter the farmer’s first name and surname.');
  const phone = i.phone ? normPhone(i.phone) : null;
  if (i.phone && !phone) throw new UserError('That phone number does not look right. Use the 11-digit form, e.g. 08031234567.');
  const sex = ['female', 'male'].includes(String(i.sex)) ? String(i.sex) : null;
  const state_code = clean(i.state_code, 2).toUpperCase() || null;
  if (state_code && !(await db.val('SELECT 1 FROM states WHERE code=$1', state_code))) throw new UserError('Choose a state from the list.');
  const raw = Array.isArray(i.commodities) ? i.commodities : String(i.commodities ?? '').split(/[,\s]+/);
  const commodities = [...new Set(raw.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (commodities.length) {
    const known = await db.all<{ code: string }>('SELECT code FROM commodities WHERE code = ANY($1)', commodities);
    const bad = commodities.filter((c) => !known.some((k) => k.code === c));
    if (bad.length) throw new UserError(`Unknown commodity: ${bad.join(', ')}.`);
  }
  const yob = i.year_of_birth ? Number(i.year_of_birth) : null;
  const thisYear = new Date().getFullYear();
  if (yob !== null && !(Number.isInteger(yob) && yob >= thisYear - 100 && yob <= thisYear - 16)) throw new UserError('Year of birth must be a real year, and the farmer at least 16.');
  return { full_name, phone_e164: phone, sex, state_code, community: clean(i.community, 120) || null, commodities, year_of_birth: yob };
}

/** Farmers sharing this phone (phones are shared in families, so this warns rather than blocks). */
export const farmersWithPhone = (phone: string, exceptId?: string) =>
  db.all<{ code: string; full_name: string }>(`SELECT code, full_name FROM farmers WHERE phone_e164=$1 AND status='active' AND ($2::uuid IS NULL OR id<>$2)`, phone, exceptId ?? null);

export async function createFarmer(a: Actor, i: FarmerInput) {
  need(a, 'farmers.edit', 'Your role cannot register farmers.');
  const v = await farmerFields(i);
  let partnerId: string | null = null;
  if (i.field_partner_code) {
    const fp = await db.get<{ id: string; org_id: string | null; status: string }>('SELECT id, org_id, status FROM field_partners WHERE code=upper($1)', clean(i.field_partner_code, 12));
    if (!fp || fp.status !== 'active') throw new UserError('That field partner code is not an active field partner.');
    if (!isKitovu(a) && fp.org_id !== a.membership!.org_id) throw new UserError('That field partner is not in your network.');
    partnerId = fp.id;
  }
  if (v.phone_e164 && i.confirm_duplicate !== '1') {
    const same = (await farmersWithPhone(v.phone_e164)).filter((f) => similar(f.full_name, v.full_name));
    if (same.length) throw new DuplicateWarning(same);
  }
  return tx(async () => {
    const code = 'SXF-' + String(await db.val<string>(`SELECT nextval('farmer_code_seq')`)).padStart(6, '0');
    const id = await db.val<string>(
      `INSERT INTO farmers (code, full_name, phone_e164, sex, state_code, community, commodities, year_of_birth, registered_by_user, registered_by_partner, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'app') RETURNING id`,
      code, v.full_name, v.phone_e164, v.sex, v.state_code, v.community, v.commodities, v.year_of_birth, a.user.id, partnerId);
    await audit(actorOf(a), 'farmer.registered', { orgId: a.membership!.org_id, entity: 'farmer', entityId: id!, data: { code, state: v.state_code, by_partner: !!partnerId } });
    return code;
  });
}

export class DuplicateWarning extends UserError {
  constructor(public matches: { code: string; full_name: string }[]) {
    super(`A farmer with this phone and a similar name already exists (${matches.map((m) => `${m.code} ${m.full_name}`).join('; ')}). Open that record instead, or tick “This is a different person” and save again.`);
  }
}
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((w) => w.length > 1));
export function similar(a: string, b: string) { const x = words(a), y = words(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n >= Math.min(2, x.size, y.size); }

export async function updateFarmer(a: Actor, code: string, i: FarmerInput) {
  need(a, 'farmers.edit', 'Your role cannot edit farmers.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  const v = await farmerFields(i);
  const changed: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(v) as (keyof typeof v)[]) {
    const before = (f as any)[k]; const after = v[k];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changed[k] = [k === 'phone_e164' && before ? mask(before) : before, k === 'phone_e164' && after ? mask(after as string) : after];
  }
  if (!Object.keys(changed).length) return 'Nothing changed.';
  await tx(async () => {
    // A new phone number must be confirmed again; an identity check already approved stays valid.
    await db.run(`UPDATE farmers SET full_name=$2, phone_e164=$3, sex=$4, state_code=$5, community=$6, commodities=$7, year_of_birth=$8, updated_at=now(),
                  phone_verified_at = CASE WHEN phone_e164 IS DISTINCT FROM $3 THEN NULL ELSE phone_verified_at END,
                  phone_check_method = CASE WHEN phone_e164 IS DISTINCT FROM $3 AND phone_check_method <> 'attested' THEN NULL ELSE phone_check_method END WHERE id=$1`,
      f.id, v.full_name, v.phone_e164, v.sex, v.state_code, v.community, v.commodities, v.year_of_birth);
    await audit(actorOf(a), 'farmer.updated', { orgId: a.membership!.org_id, entity: 'farmer', entityId: f.id, data: { code: f.code, changed } });
  });
  return 'Saved.';
}
export const mask = (p: string) => p.slice(0, 7) + '•••' + p.slice(-2);

export async function setFarmerStatus(a: Actor, code: string, status: 'active' | 'inactive', reason: string) {
  need(a, 'farmers.edit');
  if (!isKitovu(a)) throw new NotAllowed('Only Kitovu can deactivate a farmer record.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  if (!clean(reason)) throw new UserError('Give a reason.');
  await db.run('UPDATE farmers SET status=$2, updated_at=now() WHERE id=$1', f.id, status);
  await audit(actorOf(a), `farmer.${status === 'active' ? 'reactivated' : 'deactivated'}`, { entity: 'farmer', entityId: f.id, data: { code: f.code, reason: clean(reason) } });
}

// ---------- data-quality review queue ----------
export interface Issue { id: string; entity: string; entity_id: string | null; legacy_ref: string | null; severity: string; code: string; detail: string; resolved_at: Date | null; resolved_by: string | null; label: string | null; link: string | null }

export async function openIssues(a: Actor, o: { entity?: string; entityId?: string; includeInfo?: boolean; includeResolved?: boolean } = {}) {
  if (!isKitovu(a) || !(can(a.membership, 'farmers.edit') || can(a.membership, 'warehouses.edit'))) throw new NotAllowed('Only Kitovu operations can see the review queue.');
  return db.all<Issue>(
    `SELECT di.id::text, di.entity, di.entity_id, di.legacy_ref, di.severity, di.code, di.detail, di.resolved_at, di.resolved_by,
       COALESCE(f.code || ' ' || f.full_name, fp.code || ' ' || fp.full_name, w.code || ' ' || w.name, r.receipt_no) AS label,
       CASE WHEN f.id IS NOT NULL THEN '/farmers/' || f.code WHEN fp.id IS NOT NULL THEN '/field-partners#' || fp.code WHEN w.id IS NOT NULL THEN '/warehouses/' || w.code END AS link
     FROM data_issues di
       LEFT JOIN farmers f ON di.entity='farmer' AND f.id=di.entity_id
       LEFT JOIN field_partners fp ON di.entity='field_partner' AND fp.id=di.entity_id
       LEFT JOIN warehouses w ON di.entity='warehouse' AND w.id=di.entity_id
       LEFT JOIN receipts r ON di.entity='receipt' AND r.id=di.entity_id
     WHERE ($1 = '' OR di.entity=$1) AND ($2::uuid IS NULL OR di.entity_id=$2) AND ($3 OR di.severity <> 'info') AND ($4 OR di.resolved_at IS NULL)
     ORDER BY di.resolved_at IS NOT NULL, CASE di.severity WHEN 'blocker' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, di.entity, di.id LIMIT 500`,
    clean(o.entity, 30), o.entityId ?? null, !!o.includeInfo, !!o.includeResolved);
}

export async function resolveIssue(a: Actor, issueId: string, note: string) {
  if (!isKitovu(a) || !(can(a.membership, 'farmers.edit') || can(a.membership, 'warehouses.edit'))) throw new NotAllowed('Only Kitovu operations can resolve review items.');
  const n = clean(note, 300);
  if (n.length < 3) throw new UserError('Say briefly how it was resolved.');
  const i = await db.get<{ entity: string; entity_id: string | null; code: string }>('SELECT entity, entity_id, code FROM data_issues WHERE id=$1 AND resolved_at IS NULL', issueId);
  if (!i) throw new UserError('That item is already resolved.');
  await tx(async () => {
    await db.run('UPDATE data_issues SET resolved_at=now(), resolved_by=$2 WHERE id=$1', issueId, `user:${a.user.email} — ${n}`);
    // Clear the record's review flag once nothing needing review is left on it.
    const table = ({ farmer: 'farmers', warehouse: 'warehouses' } as Record<string, string>)[i.entity];
    if (table && i.entity_id && !(await db.val(`SELECT 1 FROM data_issues WHERE entity=$1 AND entity_id=$2 AND resolved_at IS NULL AND severity<>'info'`, i.entity, i.entity_id)))
      await db.run(`UPDATE ${table} SET needs_review=false WHERE id=$1`, i.entity_id);
    await audit(actorOf(a), 'data_issue.resolved', { entity: i.entity, entityId: i.entity_id ?? undefined, data: { issue: issueId, code: i.code, note: n } });
  });
}

// ---------- field partners ----------
export interface FieldPartner { id: string; code: string; full_name: string; phone_e164: string | null; email: string | null; org_id: string | null; org_name: string | null; status: string; state_code: string | null; community: string | null; verified_at: Date | null; farmers: number }

export async function listFieldPartners(a: Actor) {
  need(a, 'field_partners.manage');
  const scope = isKitovu(a) ? null : a.membership!.org_id;
  return db.all<FieldPartner>(
    `SELECT fp.id, fp.code, fp.full_name, fp.phone_e164, fp.email, fp.org_id, o.name AS org_name, fp.status, fp.state_code, fp.community, fp.verified_at,
       (SELECT count(*)::int FROM farmers f WHERE f.registered_by_partner=fp.id) AS farmers
     FROM field_partners fp LEFT JOIN organisations o ON o.id=fp.org_id
     WHERE ($1::uuid IS NULL OR fp.org_id=$1) ORDER BY fp.status='active' DESC, fp.status, fp.full_name`, scope);
}

export async function createFieldPartner(a: Actor, i: { full_name?: string; phone?: string; email?: string; state_code?: string; community?: string; org_id?: string }) {
  need(a, 'field_partners.manage');
  const full_name = clean(i.full_name, 120);
  if (full_name.length < 3) throw new UserError('Enter the field partner’s full name.');
  const phone = normPhone(i.phone);
  if (!phone) throw new UserError('A field partner needs a working phone number (e.g. 08031234567).');
  const email = clean(i.email, 120).toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new UserError('That email address does not look right.');
  const orgId = isKitovu(a) ? (i.org_id || null) : a.membership!.org_id;
  if (orgId && isKitovu(a) && !(await db.val(`SELECT 1 FROM organisations WHERE id=$1 AND kind IN ('field_partner_network','cooperative','kitovu')`, orgId))) throw new UserError('Choose a field partner network or co-operative.');
  const state = clean(i.state_code, 2).toUpperCase() || null;
  return tx(async () => {
    const code = 'SXA-' + String(await db.val<string>(`SELECT nextval('field_partner_code_seq')`)).padStart(5, '0');
    // Kitovu staff vouch for the person when they add them; a network's own additions wait for Kitovu to verify.
    const status = isKitovu(a) ? 'active' : 'invited';
    const id = await db.val<string>(
      `INSERT INTO field_partners (code, full_name, phone_e164, email, org_id, status, state_code, community, verified_at, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $6='active' THEN now() END, CASE WHEN $6='active' THEN $9::uuid END) RETURNING id`,
      code, full_name, phone, email, orgId, status, state, clean(i.community, 120) || null, a.user.id);
    await audit(actorOf(a), 'field_partner.added', { orgId: orgId ?? undefined, entity: 'field_partner', entityId: id!, data: { code, status } });
    return code;
  });
}

export async function setFieldPartnerStatus(a: Actor, id: string, status: 'active' | 'suspended') {
  need(a, 'field_partners.manage');
  if (!isKitovu(a)) throw new NotAllowed('Only Kitovu can verify or suspend field partners.');
  const fp = await db.get<{ code: string; status: string; phone_e164: string | null }>('SELECT code, status, phone_e164 FROM field_partners WHERE id=$1', id);
  if (!fp) throw new UserError('Field partner not found.');
  if (status === 'active' && !fp.phone_e164) throw new UserError('Add a working phone number before verifying this field partner.');
  await db.run(`UPDATE field_partners SET status=$2, verified_at=CASE WHEN $2='active' THEN now() ELSE verified_at END, verified_by=CASE WHEN $2='active' THEN $3::uuid ELSE verified_by END WHERE id=$1`, id, status, a.user.id);
  await audit(actorOf(a), status === 'active' ? 'field_partner.verified' : 'field_partner.suspended', { entity: 'field_partner', entityId: id, data: { code: fp.code, from: fp.status } });
}

// ---------- warehouses ----------
export interface Warehouse {
  id: string; code: string; name: string; operator_org_id: string; operator_name: string; tier: string; status: string; state_code: string; state_name: string;
  town: string | null; address_text: string | null; lat: string | null; lng: string | null; capacity_kg: string | null; can_back_loans: boolean; needs_review: boolean;
  commodities: string[]; contact_name: string | null; contact_phone: string | null; updated_at: Date;
}
const WH_COLS = `w.id, w.code, w.name, w.operator_org_id, o.name AS operator_name, w.tier, w.status, w.state_code, s.name AS state_name, w.town, w.address_text,
  w.lat::text, w.lng::text, w.capacity_kg::text, w.can_back_loans, w.needs_review, w.commodities, w.contact_name, w.contact_phone, w.updated_at`;

/** Lenders, insurers and Kitovu see every warehouse profile (they assess sites); operators see their own. */
function whScope(a: Actor) { const k = a.membership!.org_kind; return ['kitovu', 'lender', 'insurer'].includes(k) ? null : a.membership!.org_id; }

export async function listWarehouses(a: Actor) {
  need(a, 'warehouses.view');
  return db.all<Warehouse>(`SELECT ${WH_COLS} FROM warehouses w JOIN organisations o ON o.id=w.operator_org_id JOIN states s ON s.code=w.state_code
    WHERE ($1::uuid IS NULL OR w.operator_org_id=$1) ORDER BY w.status='closed', w.name`, whScope(a));
}
export async function warehouseByCode(a: Actor, code: string) {
  need(a, 'warehouses.view');
  return db.get<Warehouse>(`SELECT ${WH_COLS} FROM warehouses w JOIN organisations o ON o.id=w.operator_org_id JOIN states s ON s.code=w.state_code
    WHERE w.code=upper($1) AND ($2::uuid IS NULL OR w.operator_org_id=$2)`, clean(code, 20), whScope(a));
}
export const policiesFor = (warehouseId: string) => db.all(`SELECT * FROM insurance_policies WHERE warehouse_id=$1 ORDER BY cover_to DESC NULLS LAST`, warehouseId);

export async function updateWarehouse(a: Actor, code: string, i: Record<string, string>) {
  need(a, 'warehouses.edit', 'Your role cannot edit warehouse profiles.');
  if (!isKitovu(a)) throw new NotAllowed('Warehouse profiles are maintained by Kitovu.');
  const w = await warehouseByCode(a, code);
  if (!w) throw new UserError('Warehouse not found.');
  const num = (v: string | undefined, lo: number, hi: number, label: string) => {
    if (!v?.trim()) return null; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${label} is out of range.`); return n;
  };
  const lat = num(i.lat, 4, 14, 'Latitude (Nigeria is 4–14° N)'), lng = num(i.lng, 2, 15, 'Longitude (Nigeria is 2–15° E)');
  const cap = num(i.capacity_tonnes, 1, 1_000_000, 'Capacity');
  const phone = i.contact_phone ? normPhone(i.contact_phone) : null;
  if (i.contact_phone && !phone) throw new UserError('Contact phone does not look right.');
  const status = ['onboarding', 'certified', 'active', 'dormant', 'closed'].includes(i.status) ? i.status : w.status;
  const tier = ['A', 'B', 'C', 'D'].includes(i.tier) ? i.tier : w.tier;
  if ((status === 'certified' || status === 'active') && (lat === null || lng === null || cap === null)) throw new UserError('A certified or active warehouse needs GPS coordinates and capacity first.');
  const commodities = [...new Set(String(i.commodities ?? '').split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (commodities.length) {
    const known = await db.all<{ code: string }>('SELECT code FROM commodities WHERE code = ANY($1)', commodities);
    const bad = commodities.filter((c) => !known.some((k) => k.code === c)); if (bad.length) throw new UserError(`Unknown commodity: ${bad.join(', ')}.`);
  }
  await tx(async () => {
    await db.run(`UPDATE warehouses SET name=$2, town=$3, address_text=$4, lat=$5, lng=$6, capacity_kg=$7, contact_name=$8, contact_phone=$9, commodities=$10, status=$11, tier=$12, updated_at=now() WHERE id=$1`,
      w.id, clean(i.name, 120) || w.name, clean(i.town, 80) || null, clean(i.address_text, 300) || null, lat, lng, cap === null ? null : cap * 1000, clean(i.contact_name, 120) || null, phone, commodities, status, tier);
    await audit(actorOf(a), 'warehouse.updated', { orgId: w.operator_org_id, entity: 'warehouse', entityId: w.id, data: { code: w.code, status: [w.status, status], tier: [w.tier, tier] } });
  });
}

export async function addPolicy(a: Actor, code: string, i: Record<string, string>) {
  need(a, 'warehouses.edit');
  if (!isKitovu(a)) throw new NotAllowed('Insurance records are maintained by Kitovu.');
  const w = await warehouseByCode(a, code);
  if (!w) throw new UserError('Warehouse not found.');
  const insurer = clean(i.insurer_name, 120);
  if (!insurer) throw new UserError('Enter the insurer’s name.');
  const from = i.cover_from || null, to = i.cover_to || null;
  if (!from || !to || !(new Date(to) > new Date(from))) throw new UserError('Enter cover dates; the end must be after the start.');
  const sum = i.sum_insured_naira ? Math.round(Number(i.sum_insured_naira.replace(/,/g, '')) * 100) : null;
  if (sum !== null && !(sum >= 0)) throw new UserError('Sum insured must be a number.');
  const perils = String(i.perils ?? '').split(',').map((p) => clean(p, 40).toLowerCase()).filter(Boolean);
  await tx(async () => {
    const id = await db.val<string>(`INSERT INTO insurance_policies (warehouse_id, insurer_name, policy_number, sum_insured_kobo, cover_from, cover_to, perils, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified') RETURNING id`, w.id, insurer, clean(i.policy_number, 60) || null, sum, from, to, perils);
    await audit(actorOf(a), 'insurance.added', { orgId: w.operator_org_id, entity: 'insurance_policy', entityId: id!, data: { warehouse: w.code, insurer, to } });
  });
}

/** A second Kitovu person confirms the schedule against the insurer before cover counts. */
export async function verifyPolicy(a: Actor, policyId: string) {
  need(a, 'warehouses.edit');
  if (!isKitovu(a)) throw new NotAllowed('Only Kitovu can verify insurance.');
  const p = await db.get<{ id: string; status: string; cover_to: Date | null; warehouse_id: string }>('SELECT id, status, cover_to, warehouse_id FROM insurance_policies WHERE id=$1', policyId);
  if (!p || p.status !== 'unverified') throw new UserError('Only an unverified policy can be verified.');
  if (!p.cover_to || p.cover_to < new Date()) throw new UserError('This policy has no current cover dates. Add the current schedule as a new policy.');
  const addedBy = await db.val<string>(`SELECT actor_user_id FROM audit_log WHERE action='insurance.added' AND entity_id=$1 ORDER BY id LIMIT 1`, policyId);
  if (addedBy && addedBy === a.user.id) throw new NotAllowed('Someone other than the person who entered the policy must verify it.');
  await db.run(`UPDATE insurance_policies SET status='active' WHERE id=$1`, policyId);
  await audit(actorOf(a), 'insurance.verified', { entity: 'insurance_policy', entityId: policyId, data: { warehouse_id: p.warehouse_id } });
}

export const states = () => db.all<{ code: string; name: string }>('SELECT code, name FROM states ORDER BY name');
export const commodities = () => db.all<{ code: string; name: string }>('SELECT code, name FROM commodities ORDER BY name');
