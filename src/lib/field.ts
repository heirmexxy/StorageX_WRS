// Field app: farmers and agribusinesses registered on a phone with no network, uploaded later.
// One upload = one farmer: the record (made on the phone, with its own id), a face photo, and optionally the ID photo
// and number for the identity check and a witnessed phone check. The farmer is created first; the checks that follow
// are attempted and, if refused, reported back without losing the registration.
import { db } from './db';
import type { Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import type { Upload } from './http';
import { createFarmer, setFarmerPhoto, commodities, states, DuplicateWarning } from './registry';
import { submitLevel1, attestPresence, phoneMethods, ID_TYPES } from './kyc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the phone needs to register farmers offline. */
export async function registerBoot(a: Actor) {
  if (!can(a.membership, 'farmers.edit')) return null;
  const pm = await phoneMethods();
  return {
    states: await states(), crops: await commodities(),
    idTypes: Object.entries(ID_TYPES).map(([k, t]) => ({ code: k, label: t.label, hint: t.hint })),
    canCheckId: can(a.membership, 'farmers.edit'), witnessed: pm.attested,
  };
}

export async function registerOffline(a: Actor, json: string, files: Record<string, Upload | undefined>) {
  if (!can(a.membership, 'farmers.edit')) throw new UserError('Your role cannot register farmers.');
  let r: any;
  try { r = JSON.parse(json); } catch { throw new UserError('The record could not be read.'); }
  if (!UUID.test(String(r?.id))) throw new UserError('The record has no id.');
  const done = await db.val<string>('SELECT code FROM farmers WHERE offline_ref=$1', r.id);
  if (done) return { result: 'duplicate' as const, code: done, warnings: [] as string[] };

  let code: string;
  try {
  code = await createFarmer(a, {
    kind: r.kind, full_name: r.full_name, phone: r.phone, sex: r.sex, year_of_birth: r.year_of_birth, state_code: r.state_code,
    community: r.community, commodities: Array.isArray(r.commodities) ? r.commodities : [], business_reg_no: r.business_reg_no,
    contact_person: r.contact_person, contact_role: r.contact_role, field_partner_code: r.field_partner_code, confirm_duplicate: r.not_duplicate ? '1' : '',
  } as any);
  } catch (e) {
    if (e instanceof DuplicateWarning) return { result: 'duplicate_suspected' as const, matches: e.matches.map((m: any) => `${m.full_name} (${m.code})`), warnings: [] as string[] };
    throw e;
  }
  await db.run('UPDATE farmers SET offline_ref=$2 WHERE code=$1', code, r.id);
  const lga = String(r.lga ?? '').trim().slice(0, 80);
  if (lga) await db.run(`WITH f AS (SELECT id, state_code FROM farmers WHERE code=$1 AND state_code IS NOT NULL),
      l AS (INSERT INTO lgas (state_code, name) SELECT state_code, initcap($2) FROM f ON CONFLICT (state_code, name) DO UPDATE SET name=EXCLUDED.name RETURNING id)
    UPDATE farmers SET lga_id=(SELECT id FROM l) WHERE id=(SELECT id FROM f) AND lga_id IS NULL`, code, lga);

  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { if (!(e instanceof UserError)) throw e; warnings.push(`${what}: ${e.message}`); } };
  if (files.photo?.data.length) await attempt('Profile photo', () => setFarmerPhoto(a, code, files.photo));
  if (r.witness?.witness_name) await attempt('Witnessed phone check', () => attestPresence(a, code, { ...r.witness, declare: r.witness.declare ? '1' : '' }));
  if (r.id_type && r.id_number) await attempt('Identity check', () => submitLevel1(a, code, { id_type: r.id_type, id_number: r.id_number }, { id_doc: files.id_doc, selfie: files.photo }));
  return { result: 'stored' as const, code, warnings };
}
