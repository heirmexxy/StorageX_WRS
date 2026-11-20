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
import { saveFile } from './files';
import type { Upload } from './http';

export class NotAllowed extends UserError {}
function need(a: Actor, perm: Permission, msg = 'Your role does not allow this.') { if (!can(a.membership, perm)) throw new NotAllowed(msg); }
const isKitovu = (a: Actor) => a.membership?.org_kind === 'kitovu';

// ---------- farmers ----------
export interface Farmer {
  id: string; code: string; full_name: string; phone_e164: string | null; sex: string | null; state_code: string | null; state_name: string | null;
  community: string | null; commodities: string[]; kyc_level: number; status: string; needs_review: boolean; source: string;
  year_of_birth: number | null; phone_verified_at: Date | null; phone_check_method: 'sms' | 'voice' | 'attested' | null; phone_attestation: any; id_type: string | null; id_last4: string | null; created_at: Date; updated_at: Date;
  registered_by_name?: string | null; open_issues?: number;
  kind: 'individual' | 'agribusiness'; business_reg_no: string | null; contact_person: string | null; contact_role: string | null; profile_photo_id: string | null;
}

/** SQL condition (on alias f) limiting farmers to what the actor may see; $1 is the actor's org id. */
function farmerScope(a: Actor): { where: string; arg: string | null } {
  const m = a.membership!;
  if (m.org_kind === 'kitovu') return { where: '$1::uuid IS NULL', arg: null };
  if (m.org_kind === 'lender') return { where: `EXISTS (SELECT 1 FROM farmer_consents fc WHERE fc.farmer_id=f.id AND fc.org_id=$1 AND fc.withdrawn_at IS NULL)`, arg: m.org_id };
  return {
    where: `(EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id=f.registered_by_user AND mm.org_id=$1)
             OR EXISTS (SELECT 1 FROM field_partners fp WHERE fp.id=f.registered_by_partner AND fp.org_id=$1)
             OR EXISTS (SELECT 1 FROM receipts r WHERE r.owner_farmer_id=f.id AND r.issuer_org_id=$1))`,
    arg: m.org_id,
  };
}

const FARMER_COLS = `f.id, f.code, f.full_name, f.phone_e164, f.sex, f.state_code, s.name AS state_name, f.community, f.commodities, f.kyc_level, f.status,
  f.needs_review, f.source, f.year_of_birth, f.phone_verified_at, f.phone_check_method, f.phone_attestation, f.id_type, f.id_last4, f.created_at, f.updated_at,
  f.kind, f.business_reg_no, f.contact_person, f.contact_role, f.profile_photo_id`;

/** Lists show 100 rows a page; the page number comes from the address. */
export const PAGE_SIZE = 100;
export const pageOffset = (p: unknown) => Math.min(Math.max(0, Math.floor(Number(p) || 0)), 10_000) * PAGE_SIZE;

export async function searchFarmers(a: Actor, q: { text?: string; state?: string; level?: string; review?: string; status?: string; page?: string } = {}) {
  need(a, 'farmers.view');
  const sc = farmerScope(a);
  const text = clean(q.text, 80);
  const phone = normPhone(text);
  return db.all<Farmer>(
    `SELECT ${FARMER_COLS}, (SELECT count(*)::int FROM data_issues di WHERE di.entity='farmer' AND di.entity_id=f.id AND di.resolved_at IS NULL AND di.severity<>'info') AS open_issues, count(*) OVER()::int AS total_rows
     FROM farmers f LEFT JOIN states s ON s.code=f.state_code
     WHERE ${sc.where.replace(/\$1/g, '$6')}
       AND ($1 = '' OR f.full_name ILIKE '%' || $1 || '%' OR f.code = upper($1) OR f.phone_e164 = $2 OR f.community ILIKE '%' || $1 || '%')
       AND ($3 = '' OR f.state_code = $3)
       AND ($4 = '' OR f.kyc_level = ($4)::smallint)
       AND ($5 = '' OR f.needs_review)
       AND f.status = $7
     ORDER BY f.needs_review DESC, f.updated_at DESC, f.code LIMIT 100 OFFSET $8`,
    text, phone, clean(q.state, 2).toUpperCase(), /^[012]$/.test(String(q.level)) ? String(q.level) : '', q.review === '1' ? '1' : '', sc.arg,
    ['active', 'inactive', 'merged', 'excluded'].includes(String(q.status)) ? q.status : 'active', pageOffset(q.page));
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

export interface FarmerInput { kind?: string; business_reg_no?: string; contact_person?: string; contact_role?: string; full_name?: string; phone?: string; sex?: string; state_code?: string; community?: string; commodities?: string | string[]; year_of_birth?: string; field_partner_code?: string; confirm_duplicate?: string }

async function farmerFields(i: FarmerInput) {
  const kind = i.kind === 'agribusiness' ? 'agribusiness' : 'individual';
  const full_name = clean(i.full_name, 120);
  const biz = kind === 'agribusiness';
  if (biz && full_name.length < 3) throw new UserError('Enter the agribusiness’s registered name.');
  if (!biz && (full_name.length < 3 || !/\s/.test(full_name))) throw new UserError('Enter the farmer’s first name and surname.');
  const contact_person = biz ? clean(i.contact_person, 120) : '';
  if (biz && (contact_person.length < 3 || !/\s/.test(contact_person))) throw new UserError('Enter the full name of the person who speaks for the agribusiness.');
  const business_reg_no = biz ? clean(i.business_reg_no, 20).toUpperCase().replace(/\s+/g, ' ') : '';
  if (business_reg_no && !/^[A-Z]{0,4}[ -]?[0-9]{3,10}$/.test(business_reg_no)) throw new UserError('Registration number: as on the certificate, e.g. RC 1348965 or BN 3456789.');
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
  return { kind, full_name, phone_e164: phone, sex: biz ? null : sex, state_code, community: clean(i.community, 120) || null, commodities, year_of_birth: biz ? null : yob,
    business_reg_no: business_reg_no || null, contact_person: contact_person || null, contact_role: biz ? clean(i.contact_role, 60) || null : null };
}

/** Farmers sharing this phone (phones are shared in families, so this warns rather than blocks). */
export const farmersWithPhone = (phone: string, exceptId?: string) =>
  db.all<{ code: string; full_name: string }>(`SELECT code, full_name FROM farmers WHERE phone_e164=$1 AND status='active' AND ($2::uuid IS NULL OR id<>$2)`, phone, exceptId ?? null);

export async function createFarmer(a: Actor, i: FarmerInput, photo?: Upload) {
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
      `INSERT INTO farmers (code, full_name, phone_e164, sex, state_code, community, commodities, year_of_birth, registered_by_user, registered_by_partner, source, kind, business_reg_no, contact_person, contact_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'app',$11,$12,$13,$14) RETURNING id`,
      code, v.full_name, v.phone_e164, v.sex, v.state_code, v.community, v.commodities, v.year_of_birth, a.user.id, partnerId, v.kind, v.business_reg_no, v.contact_person, v.contact_role);
    if (photo && photo.data.length) await attachPhoto(a, id!, photo);
    await audit(actorOf(a), 'farmer.registered', { orgId: a.membership!.org_id, entity: 'farmer', entityId: id!, data: { code, kind: v.kind, state: v.state_code, by_partner: !!partnerId, photo: !!photo?.data.length } });
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
                  kind=$9, business_reg_no=$10, contact_person=$11, contact_role=$12,
                  phone_verified_at = CASE WHEN phone_e164 IS DISTINCT FROM $3 THEN NULL ELSE phone_verified_at END,
                  phone_check_method = CASE WHEN phone_e164 IS DISTINCT FROM $3 AND phone_check_method <> 'attested' THEN NULL ELSE phone_check_method END WHERE id=$1`,
      f.id, v.full_name, v.phone_e164, v.sex, v.state_code, v.community, v.commodities, v.year_of_birth, v.kind, v.business_reg_no, v.contact_person, v.contact_role);
    await audit(actorOf(a), 'farmer.updated', { orgId: a.membership!.org_id, entity: 'farmer', entityId: f.id, data: { code: f.code, changed } });
  });
  return 'Saved.';
}
// ---------- profile photo ----------
// A face photo (or, for an agribusiness, the contact person's photo) so field teams, warehouse staff and lenders
// recognise the person who stores. It is encrypted like every upload and never shown on the public check page.
async function attachPhoto(a: Actor, farmerId: string, photo: Upload) {
  const fileId = await saveFile(photo, { kind: 'profile_photo', entity: 'farmer', entityId: farmerId, userId: a.user.id, label: 'Profile photo' });
  const old = await db.val<string>('SELECT profile_photo_id FROM farmers WHERE id=$1', farmerId);
  await db.run('UPDATE farmers SET profile_photo_id=$2, updated_at=now() WHERE id=$1', farmerId, fileId);
  if (old) await db.run('UPDATE files SET delete_after=current_date WHERE id=$1', old);   // the replaced photo is removed by the retention job
  return fileId;
}
export async function setFarmerPhoto(a: Actor, code: string, photo: Upload | undefined) {
  need(a, 'farmers.edit', 'Your role cannot change farmer records.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  if (!photo || !photo.data.length) throw new UserError('Profile photo: take or choose a photo.');
  await tx(async () => {
    await attachPhoto(a, f.id, photo);
    await audit(actorOf(a), 'farmer.photo_set', { orgId: a.membership!.org_id, entity: 'farmer', entityId: f.id, data: { code: f.code, replaced: !!f.profile_photo_id } });
  });
}
/** Whether this person may see this farmer at all (the same rule as the farmer list). */
export async function canSeeFarmer(a: Actor, farmerId: string) {
  if (!a.membership || !can(a.membership, 'farmers.view')) return false;
  const sc = farmerScope(a);
  return !!(await db.val(`SELECT 1 FROM farmers f WHERE f.id=$2 AND ${sc.where}`, sc.arg, farmerId));
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

export async function openIssues(a: Actor, o: { entity?: string; entityId?: string; includeInfo?: boolean; includeResolved?: boolean; code?: string; limit?: number } = {}) {
  if (!isKitovu(a) || !(can(a.membership, 'farmers.edit') || can(a.membership, 'warehouses.edit'))) throw new NotAllowed('Only Kitovu operations can see the review queue.');
  return db.all<Issue>(
    `SELECT di.id::text, di.entity, di.entity_id, di.legacy_ref, di.severity, di.code, di.detail, di.resolved_at, di.resolved_by,
       COALESCE(f.code || ' ' || f.full_name, fp.code || ' ' || fp.full_name, w.code || ' ' || w.name, r.receipt_no, us.full_name || ' (' || us.email || ')') AS label, di.source,
       CASE WHEN f.id IS NOT NULL THEN '/farmers/' || f.code WHEN fp.id IS NOT NULL THEN '/field-partners#' || fp.code WHEN w.id IS NOT NULL THEN '/warehouses/' || w.code WHEN r.id IS NOT NULL THEN '/receipts/' || r.receipt_no END AS link
     FROM data_issues di
       LEFT JOIN farmers f ON di.entity='farmer' AND f.id=di.entity_id
       LEFT JOIN field_partners fp ON di.entity='field_partner' AND fp.id=di.entity_id
       LEFT JOIN warehouses w ON di.entity='warehouse' AND w.id=di.entity_id
       LEFT JOIN receipts r ON di.entity='receipt' AND r.id=di.entity_id
       LEFT JOIN users us ON di.entity='user' AND us.id=di.entity_id
     WHERE ($1 = '' OR di.entity=$1) AND ($2::uuid IS NULL OR di.entity_id=$2) AND ($3 OR di.severity <> 'info') AND ($4 OR di.resolved_at IS NULL) AND ($5 = '' OR di.code=$5)
     ORDER BY di.resolved_at IS NOT NULL, CASE di.severity WHEN 'blocker' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, di.entity, di.code, label, di.id LIMIT $6`,
    clean(o.entity, 30), o.entityId ?? null, !!o.includeInfo, !!o.includeResolved, clean(o.code, 60), o.limit ?? 500);
}
/** Open items by kind, for the summary at the top of the review queue. */
export async function issueSummary(a: Actor) {
  if (!isKitovu(a)) throw new NotAllowed('Only Kitovu operations can see the review queue.');
  return db.all<{ entity: string; code: string; severity: string; n: number }>(
    `SELECT entity, code, max(severity) AS severity, count(*)::int AS n FROM data_issues WHERE resolved_at IS NULL AND severity <> 'info' GROUP BY entity, code ORDER BY entity, n DESC`);
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
  commodities: string[]; contact_name: string | null; contact_phone: string | null; updated_at: Date; lga_name: string | null; titan_site_id: string | null;
}
const WH_COLS = `w.id, w.code, w.name, w.operator_org_id, o.name AS operator_name, w.tier, w.status, w.state_code, s.name AS state_name, w.town, w.address_text,
  w.lat::text, w.lng::text, w.capacity_kg::text, w.can_back_loans, w.needs_review, w.commodities, w.contact_name, w.contact_phone, w.updated_at,
  (SELECT l.name FROM lgas l WHERE l.id=w.lga_id) AS lga_name, w.titan_site_id`;

/** Lenders, insurers and Kitovu see every warehouse profile (they assess sites); operators see their own. */
function whScope(a: Actor) { const k = a.membership!.org_kind; return ['kitovu', 'lender', 'insurer'].includes(k) ? null : a.membership!.org_id; }   // issuers: their own or linked warehouses

export async function listWarehouses(a: Actor) {
  need(a, 'warehouses.view');
  return db.all<Warehouse>(`SELECT ${WH_COLS} FROM warehouses w JOIN organisations o ON o.id=w.operator_org_id JOIN states s ON s.code=w.state_code
    WHERE wh_access(w.id, $1) ORDER BY w.status='closed', w.name`, whScope(a));
}
export async function warehouseByCode(a: Actor, code: string) {
  need(a, 'warehouses.view');
  return db.get<Warehouse>(`SELECT ${WH_COLS} FROM warehouses w JOIN organisations o ON o.id=w.operator_org_id JOIN states s ON s.code=w.state_code
    WHERE w.code=upper($1) AND wh_access(w.id, $2)`, clean(code, 20), whScope(a));
}
export const policiesFor = (warehouseId: string) => db.all(`SELECT * FROM insurance_policies WHERE warehouse_id=$1 ORDER BY cover_to DESC NULLS LAST`, warehouseId);

/** The checked profile fields shared by adding and editing a warehouse. */
async function warehouseFields(i: Record<string, string | string[] | undefined>, cur?: { status: string; tier: string }) {
  const str = (k: string) => (Array.isArray(i[k]) ? (i[k] as string[]).join(',') : String(i[k] ?? ''));
  const num = (v: string, lo: number, hi: number, label: string) => {
    if (!v.trim()) return null; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${label} is out of range.`); return n;
  };
  const lat = num(str('lat'), 4, 14, 'Latitude (Nigeria is 4–14° N)'), lng = num(str('lng'), 2, 15, 'Longitude (Nigeria is 2–15° E)');
  const cap = num(str('capacity_tonnes'), 1, 1_000_000, 'Capacity');
  const phone = str('contact_phone') ? normPhone(str('contact_phone')) : null;
  if (str('contact_phone') && !phone) throw new UserError('Contact phone does not look right.');
  const status = ['onboarding', 'certified', 'active', 'dormant', 'closed'].includes(str('status')) ? str('status') : cur?.status ?? 'onboarding';
  const tier = ['A', 'B', 'C', 'D'].includes(str('tier')) ? str('tier') : cur?.tier;
  if (!tier) throw new UserError('Choose the warehouse tier.');
  if ((status === 'certified' || status === 'active') && (lat === null || lng === null || cap === null)) throw new UserError('A certified or active warehouse needs GPS coordinates and capacity first.');
  const commodities = [...new Set(str('commodities').split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (commodities.length) {
    const known = await db.all<{ code: string }>('SELECT code FROM commodities WHERE code = ANY($1)', commodities);
    const bad = commodities.filter((c) => !known.some((k) => k.code === c)); if (bad.length) throw new UserError(`Unknown commodity: ${bad.join(', ')}.`);
  }
  return { lat, lng, capacity_kg: cap === null ? null : cap * 1000, contact_name: clean(str('contact_name'), 120) || null, contact_phone: phone, commodities, status, tier,
    town: clean(str('town'), 80) || null, address_text: clean(str('address_text'), 300) || null, lga: clean(str('lga'), 80) || null };
}
/** LGAs are kept as they are first entered for a state, so the same name is one row. */
async function lgaId(state: string, name: string | null) {
  if (!name) return null;
  return db.val<string>(`INSERT INTO lgas (state_code, name) VALUES ($1, $2) ON CONFLICT (state_code, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, state, name.replace(/\b\w/g, (x) => x.toUpperCase()));
}

/** Operators a warehouse can be run by. */
export const warehouseOperators = () => db.all<{ id: string; name: string; kind: string }>(
  `SELECT id, name, kind::text FROM organisations WHERE kind::text IN ('kitovu','warehouse_operator','cooperative','issuer','other') AND status <> 'closed' ORDER BY kind='kitovu' DESC, name`);

/** The short site part of a warehouse code: from what is typed, else the town's first letters (e.g. Iseyin → ISY). */
export function siteCode(typed: string | undefined, town: string | null) {
  const t = String(typed ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t) { if (t.length < 3 || t.length > 6) throw new UserError('Site code: 3 to 6 letters or digits, e.g. ISY.'); return t; }
  const w = String(town ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (w.length < 3) throw new UserError('Enter the town, or a 3-letter site code.');
  const consonants = w[0] + w.slice(1).replace(/[AEIOU]/g, '');
  return (consonants.length >= 3 ? consonants : w).slice(0, 3);
}

/** Kitovu adds a warehouse. It starts as onboarding unless the GPS and capacity are there to certify it. */
export async function createWarehouse(a: Actor, i: Record<string, string | string[] | undefined>) {
  need(a, 'warehouses.edit', 'Your role cannot add warehouses.');
  if (!isKitovu(a)) throw new NotAllowed('Warehouses are added by Kitovu.');
  const name = clean(String(i.name ?? ''), 120);
  if (name.length < 3) throw new UserError('Enter the warehouse name.');
  const state = clean(String(i.state_code ?? ''), 2).toUpperCase();
  if (!(await db.val('SELECT 1 FROM states WHERE code=$1', state))) throw new UserError('Choose the state the warehouse is in.');
  const op = await db.get<{ id: string; name: string }>(`SELECT id, name FROM organisations WHERE id::text=$1`, String(i.operator_org_id ?? ''));
  if (!op) throw new UserError('Choose the company that runs the warehouse (add it under Organisations first if it is new).');
  const v = await warehouseFields(i);
  if (!v.town) throw new UserError('Enter the town the warehouse is in.');
  const site = siteCode(i.site_code as string | undefined, v.town);
  return tx(async () => {
    const prefix = `WH-${state}-${site}-`;
    await db.run('SELECT pg_advisory_xact_lock(hashtext($1))', prefix);
    if (await db.val(`SELECT 1 FROM warehouses WHERE lower(name)=lower($1) AND state_code=$2`, name, state)) throw new UserError(`There is already a warehouse called ${name} in this state.`);
    const n = Number(await db.val(`SELECT count(*) FROM warehouses WHERE code LIKE $1 || '%'`, prefix)) + 1;
    if (n > 99) throw new UserError('That site code is full. Choose another site code.');
    const code = prefix + String(n).padStart(2, '0');
    const id = await db.val<string>(
      `INSERT INTO warehouses (code, name, operator_org_id, tier, status, state_code, lga_id, town, address_text, lat, lng, capacity_kg, contact_name, contact_phone, commodities, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      code, name, op.id, v.tier, v.status, state, await lgaId(state, v.lga), v.town, v.address_text, v.lat, v.lng, v.capacity_kg, v.contact_name, v.contact_phone, v.commodities, a.user.id);
    await audit(actorOf(a), 'warehouse.created', { orgId: op.id, entity: 'warehouse', entityId: id!, data: { code, name, operator: op.name, tier: v.tier, status: v.status } });
    return code;
  });
}

export async function updateWarehouse(a: Actor, code: string, i: Record<string, string>) {
  need(a, 'warehouses.edit', 'Your role cannot edit warehouse profiles.');
  if (!isKitovu(a)) throw new NotAllowed('Warehouse profiles are maintained by Kitovu.');
  const w = await warehouseByCode(a, code);
  if (!w) throw new UserError('Warehouse not found.');
  const v = await warehouseFields(i, w);
  await tx(async () => {
    await db.run(`UPDATE warehouses SET name=$2, town=$3, address_text=$4, lat=$5, lng=$6, capacity_kg=$7, contact_name=$8, contact_phone=$9, commodities=$10, status=$11, tier=$12, lga_id=COALESCE($13, lga_id), updated_at=now() WHERE id=$1`,
      w.id, clean(i.name, 120) || w.name, v.town, v.address_text, v.lat, v.lng, v.capacity_kg, v.contact_name, v.contact_phone, v.commodities, v.status, v.tier, await lgaId(w.state_code, v.lga));
    await audit(actorOf(a), 'warehouse.updated', { orgId: w.operator_org_id, entity: 'warehouse', entityId: w.id, data: { code: w.code, status: [w.status, v.status], tier: [w.tier, v.tier] } });
  });
}

// ---------- commodities (Kitovu keeps the list) ----------
export const CATEGORIES = ['grain', 'legume', 'oilseed', 'tuber', 'vegetable', 'tree_crop', 'oil', 'other'] as const;
export interface Commodity { code: string; name: string; category: string; unit: string; storable: boolean; max_moisture_pct: string | null; max_storage_months: number; active: boolean; farmers: number; receipts: number }
export const commodityTable = () => db.all<Commodity>(`SELECT c.code, c.name, c.category, c.unit, c.storable, c.max_moisture_pct::text, c.max_storage_months, c.active,
    (SELECT count(*)::int FROM farmers f WHERE c.code = ANY(f.commodities)) AS farmers, (SELECT count(*)::int FROM receipts r WHERE r.commodity_code=c.code) AS receipts
  FROM commodities c ORDER BY c.active DESC, c.name`);

function commodityFields(i: Record<string, string>) {
  const name = clean(i.name, 60);
  if (name.length < 3) throw new UserError('Enter the commodity name, e.g. Maize (white).');
  const category = (CATEGORIES as readonly string[]).includes(i.category) ? i.category : null;
  if (!category) throw new UserError('Choose a category.');
  const unit = i.unit === 'l' ? 'l' : 'kg';
  const m = i.max_moisture_pct?.trim() ? Number(i.max_moisture_pct) : null;
  if (m !== null && !(Number.isFinite(m) && m > 0 && m <= 80)) throw new UserError('Maximum moisture must be between 0 and 80%.');
  const months = Number(i.max_storage_months || 6);
  if (!Number.isInteger(months) || months < 1 || months > 6) throw new UserError('Longest storage term must be 1 to 6 months.');
  return { name, category, unit, storable: i.storable === '1', max_moisture_pct: m, max_storage_months: months };
}

export async function createCommodity(a: Actor, i: Record<string, string>) {
  need(a, 'settings.manage', 'Only Kitovu administrators change the commodity list.');
  if (!isKitovu(a)) throw new NotAllowed('The commodity list is kept by Kitovu.');
  const code = clean(i.code, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new UserError('Code: three letters, e.g. GNT for groundnut.');
  const v = commodityFields(i);
  if (await db.val('SELECT 1 FROM commodities WHERE code=$1', code)) throw new UserError(`The code ${code} is already used.`);
  if (await db.val('SELECT 1 FROM commodities WHERE lower(name)=lower($1)', v.name)) throw new UserError(`${v.name} is already on the list.`);
  await db.run(`INSERT INTO commodities (code, name, category, unit, storable, max_moisture_pct, max_storage_months) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    code, v.name, v.category, v.unit, v.storable, v.max_moisture_pct, v.max_storage_months);
  await audit(actorOf(a), 'commodity.created', { entity: 'commodity', entityId: code, data: v });
  return code;
}

export async function updateCommodity(a: Actor, code: string, i: Record<string, string>) {
  need(a, 'settings.manage', 'Only Kitovu administrators change the commodity list.');
  if (!isKitovu(a)) throw new NotAllowed('The commodity list is kept by Kitovu.');
  const cur = await db.get<any>('SELECT * FROM commodities WHERE code=$1', clean(code, 3).toUpperCase());
  if (!cur) throw new UserError('Commodity not found.');
  const v = commodityFields(i);
  if (await db.val('SELECT 1 FROM commodities WHERE lower(name)=lower($1) AND code<>$2', v.name, cur.code)) throw new UserError(`${v.name} is already on the list.`);
  const active = i.active === '1';
  await db.run(`UPDATE commodities SET name=$2, category=$3, unit=$4, storable=$5, max_moisture_pct=$6, max_storage_months=$7, active=$8, updated_at=now() WHERE code=$1`,
    cur.code, v.name, v.category, v.unit, v.storable, v.max_moisture_pct, v.max_storage_months, active);
  await audit(actorOf(a), 'commodity.updated', { entity: 'commodity', entityId: cur.code, data: { ...v, active, was: { name: cur.name, active: cur.active, max_storage_months: cur.max_storage_months } } });
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
/** Commodities offered in forms: active ones only (a retired crop stays on its old records). */
export const commodities = () => db.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE active ORDER BY name');
