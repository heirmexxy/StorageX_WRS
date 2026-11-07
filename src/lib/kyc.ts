// Tiered identity checks for farmers, built so it works without a paid provider:
//   Level 0  registered (name, phone, place)
//   Level 1  phone confirmed by SMS code + photo of an ID + selfie, approved by a second Kitovu person (maker-checker)
//   Level 2  a lender confirms it has opened an account for the farmer (its own BVN/NIN checks are then done)
// Full ID numbers are never stored: only a keyed hash (to catch the same ID on two records) and the last 4 characters.
// A paid lookup (NIN match) can be plugged in through `provider` later without changing this flow.
import { db, tx } from './db';
import { config } from './config';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { saveFile } from './files';
import { issueOtp, checkOtp } from './otp';
import { farmerByCode, NotAllowed, type Farmer } from './registry';
import { hashIdNumber, clean, normPhone } from './util';
import { getSettings } from './settings';
import { latestCheck } from './agents/kyc-screen';
import type { Upload } from './http';

export const ID_TYPES: Record<string, { label: string; re: RegExp; hint: string }> = {
  nin: { label: 'National ID (NIN)', re: /^\d{11}$/, hint: '11 digits' },
  voters_card: { label: 'Voter’s card (VIN)', re: /^[0-9A-Z]{19}$/, hint: '19 letters and digits' },
  drivers_licence: { label: 'Driver’s licence', re: /^[0-9A-Z]{8,20}$/, hint: '8–20 letters and digits' },
  intl_passport: { label: 'International passport', re: /^[A-Z]\d{8}$/, hint: 'a letter then 8 digits' },
};
const normId = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');

// ---------- optional paid provider ----------
export interface LookupResult { provider: string; ref: string; match: 'match' | 'partial' | 'no_match' | 'not_found'; detail: Record<string, unknown> }
interface Provider { name: string; lookup(idType: string, idNumber: string, f: Farmer): Promise<LookupResult | null> }
const providers: Record<string, Provider> = {
  none: { name: 'none', lookup: async () => null },
  // smile_id / dojah / youverify: add here once a provider is chosen and contracted. Store their reference and
  // a summary of the match only; never the returned photo or full record.
};
export const provider = () => providers[config.kycProvider] ?? providers.none;

// ---------- step 1: phone (or witnessed presence) ----------
// Why check the phone at all: it is where the farmer later gets receipt, sale and payment messages and where
// consent codes go. Without a check, an agent can register farmers on his own number and every alert reaches
// him instead. Which methods are on, and whether the step is required, are switches in Settings.
export type PhoneMethod = 'sms' | 'voice' | 'attested';

export async function phoneMethods() {
  const s = await getSettings();
  return { required: s['phone_check.required'], sms: s['phone_check.sms'], voice: s['phone_check.voice'], attested: s['phone_check.attested'] };
}

export async function sendPhoneCode(a: Actor, code: string, channel: 'sms' | 'voice' = 'sms') {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot run identity checks.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  if (!f.phone_e164) throw new UserError('Add the farmer’s phone number first.');
  const m = await phoneMethods();
  if (!m[channel]) throw new UserError(`${channel === 'sms' ? 'Text-message' : 'Voice-call'} codes are switched off. Ask a Kitovu administrator.`);
  await issueOtp('farmer_phone', f.id, f.phone_e164, (c) => `StorageX: your code is ${c}. Give it only to the Kitovu field partner registering you. It expires in 10 minutes.`, channel);
  await audit(actorOf(a), 'farmer.phone_code_sent', { entity: 'farmer', entityId: f.id, data: { code: f.code, channel } });
}

export async function confirmPhone(a: Actor, code: string, otp: string) {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot run identity checks.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  const r = await checkOtp('farmer_phone', f.id, otp);
  if (!r.ok) throw new UserError(r.reason);
  if (r.phone !== f.phone_e164) throw new UserError('The phone number changed after the code was sent. Send a new code.');
  await db.run(`UPDATE farmers SET phone_verified_at=now(), phone_check_method=$2, phone_attestation=NULL, updated_at=now() WHERE id=$1`, f.id, r.channel);
  await audit(actorOf(a), 'farmer.phone_verified', { entity: 'farmer', entityId: f.id, data: { code: f.code, channel: r.channel } });
}

/** For farmers with no working phone or no signal: the field partner and a named local witness vouch that they met the farmer. */
export async function attestPresence(a: Actor, code: string, i: { witness_name?: string; witness_role?: string; witness_phone?: string; reason?: string; declare?: string }) {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot run identity checks.');
  if (!(await phoneMethods()).attested) throw new UserError('Witnessed attestation is switched off. Ask a Kitovu administrator.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  if (f.phone_verified_at) throw new UserError('This farmer’s phone is already confirmed.');
  const name = clean(i.witness_name, 120), role = clean(i.witness_role, 80), reason = clean(i.reason, 40);
  if (name.length < 3 || !/\s/.test(name)) throw new UserError('Enter the witness’s full name.');
  if (!role) throw new UserError('Say who the witness is (e.g. cooperative chairman, village head, extension officer).');
  if (!['no_phone', 'no_signal', 'code_not_received', 'shared_phone'].includes(reason)) throw new UserError('Choose why a code could not be used.');
  const wphone = i.witness_phone ? normPhone(i.witness_phone) : null;
  if (!wphone) throw new UserError('Enter the witness’s phone so Kitovu can call them to confirm.');
  if (wphone === f.phone_e164) throw new UserError('The witness must be someone other than the farmer.');
  if (wphone === a.user.phone_e164) throw new UserError('The witness must be someone other than you.');
  if (i.declare !== '1') throw new UserError('Tick the declaration.');
  const att = { witness_name: name, witness_role: role, witness_phone: wphone, reason, by: a.user.id, by_name: a.user.full_name, at: new Date().toISOString() };
  await db.run(`UPDATE farmers SET phone_check_method='attested', phone_attestation=$2, updated_at=now() WHERE id=$1`, f.id, att);
  await audit(actorOf(a), 'farmer.presence_attested', { entity: 'farmer', entityId: f.id, data: { code: f.code, reason, witness_role: role } });
}

/** How many active farmers share this phone: one number on many records is a sign of registration on an agent's phone. */
export const recordsOnPhone = async (phone: string | null) => (phone ? Number(await db.val(`SELECT count(*) FROM farmers WHERE phone_e164=$1 AND status='active'`, phone)) : 0);

// ---------- step 2: ID + selfie, submitted for review ----------
export async function submitLevel1(a: Actor, code: string, i: { id_type?: string; id_number?: string }, files: { id_doc?: Upload; selfie?: Upload }) {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot run identity checks.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  if (f.status !== 'active') throw new UserError('This record is not active.');
  if (f.kyc_level >= 1) throw new UserError('This farmer’s identity is already checked.');
  const pm = await phoneMethods();
  const checked = !!f.phone_verified_at || (f.phone_check_method === 'attested' && pm.attested);
  if (pm.required && !checked) throw new UserError('Confirm the farmer’s phone with a code first (or record a witnessed attestation if they have no working phone).');
  const t = ID_TYPES[String(i.id_type)];
  if (!t) throw new UserError('Choose the type of ID.');
  const num = normId(i.id_number);
  if (!t.re.test(num)) throw new UserError(`${t.label}: the number should be ${t.hint}.`);
  const hash = hashIdNumber(String(i.id_type), num);
  const clash = await db.get<{ code: string }>(
    `SELECT f.code FROM farmers f WHERE f.id<>$3 AND f.status='active' AND f.id_type=$1 AND f.id_number_hash=$2
     UNION SELECT f.code FROM kyc_submissions k JOIN farmers f ON f.id=k.farmer_id WHERE k.farmer_id<>$3 AND k.status='pending' AND k.id_type=$1 AND k.id_number_hash=$2 LIMIT 1`,
    i.id_type, hash, f.id);
  if (clash) throw new UserError(`This ID number is already on farmer ${clash.code}. If they are the same person, ask Kitovu to merge the records.`);
  if (await db.val(`SELECT 1 FROM kyc_submissions WHERE farmer_id=$1 AND status='pending'`, f.id)) throw new UserError('A check is already waiting for review.');
  const looked = await provider().lookup(String(i.id_type), num, f).catch(() => null);
  return tx(async () => {
    const idDoc = await saveFile(files.id_doc, { kind: 'id_document', entity: 'farmer', entityId: f.id, userId: a.user.id, label: 'Photo of the ID' });
    const selfie = await saveFile(files.selfie, { kind: 'selfie', entity: 'farmer', entityId: f.id, userId: a.user.id, label: 'Photo of the farmer' });
    const id = await db.val<string>(
      `INSERT INTO kyc_submissions (farmer_id, id_type, id_number_hash, id_last4, id_doc_file_id, selfie_file_id, phone_verified, submitted_by, provider, provider_ref, provider_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      f.id, i.id_type, hash, num.slice(-4), idDoc, selfie, !!f.phone_verified_at, a.user.id, looked?.provider ?? null, looked?.ref ?? null, looked ? { match: looked.match, ...looked.detail } : null);
    await db.run('UPDATE kyc_submissions SET phone_check_method=$2 WHERE id=$1', id, f.phone_verified_at ? f.phone_check_method : f.phone_check_method === 'attested' ? 'attested' : null);
    await db.run(`UPDATE farmers SET kyc='pending', updated_at=now() WHERE id=$1`, f.id);
    await audit(actorOf(a), 'kyc.submitted', { entity: 'farmer', entityId: f.id, data: { code: f.code, submission: id, id_type: i.id_type, last4: num.slice(-4), provider: looked?.match ?? 'none' } });
    return id!;
  });
}

export interface Submission {
  id: string; farmer_id: string; farmer_code: string; full_name: string; phone_e164: string | null; state_name: string | null; community: string | null; year_of_birth: number | null;
  id_type: string; id_last4: string; id_doc_file_id: string; selfie_file_id: string; submitted_by: string; submitted_by_name: string; submitted_at: Date;
  status: string; reviewed_by_name: string | null; reviewed_at: Date | null; review_note: string | null; provider_result: any;
  ai_flag: string | null; phone_check_method: string | null; phone_attestation: any; records_on_phone: number; ai?: any;
}
const SUB_SQL = `SELECT k.id, k.farmer_id, f.code AS farmer_code, f.full_name, f.phone_e164, s.name AS state_name, f.community, f.year_of_birth,
  k.id_type, k.id_last4, k.id_doc_file_id, k.selfie_file_id, k.submitted_by, su.full_name AS submitted_by_name, k.submitted_at,
  k.status, ru.full_name AS reviewed_by_name, k.reviewed_at, k.review_note, k.provider_result, k.ai_flag, k.phone_check_method, f.phone_attestation,
  (SELECT count(*)::int FROM farmers f2 WHERE f2.phone_e164=f.phone_e164 AND f2.status='active') AS records_on_phone
  FROM kyc_submissions k JOIN farmers f ON f.id=k.farmer_id LEFT JOIN states s ON s.code=f.state_code
  JOIN users su ON su.id=k.submitted_by LEFT JOIN users ru ON ru.id=k.reviewed_by`;

export async function reviewQueue(a: Actor) {
  if (!can(a.membership, 'kyc.review')) throw new NotAllowed('Only compliance can review identity checks.');
  const rows = await db.all<Submission>(`${SUB_SQL} WHERE k.status='pending' ORDER BY k.submitted_at LIMIT 100`);
  for (const r of rows) r.ai = await latestCheck(r.id);
  return rows;
}
export const submissionsFor = (farmerId: string) => db.all<Submission>(`${SUB_SQL} WHERE k.farmer_id=$1 ORDER BY k.submitted_at DESC`, farmerId);

export const REJECT_REASONS: Record<string, string> = {
  unreadable: 'ID photo unreadable',
  mismatch_name: 'Name on ID does not match the record',
  mismatch_face: 'Selfie does not match the ID photo',
  not_original: 'Photo of a photocopy or a screen',
  expired: 'ID expired',
  other: 'Other (see note)',
};

export async function review(a: Actor, submissionId: string, decision: 'approve' | 'reject', o: { reason?: string; note?: string; checks?: string[] }) {
  if (!can(a.membership, 'kyc.review')) throw new NotAllowed('Only compliance can review identity checks.');
  const k = await db.get<{ id: string; farmer_id: string; submitted_by: string; status: string; id_type: string; id_number_hash: string; id_last4: string; id_doc_file_id: string; selfie_file_id: string; ai_flag: string | null }>(
    'SELECT * FROM kyc_submissions WHERE id=$1', submissionId);
  if (!k || k.status !== 'pending') throw new UserError('This check is no longer waiting for review.');
  if (k.submitted_by === a.user.id) throw new NotAllowed('You submitted this check, so someone else must review it.');
  const note = clean(o.note, 500);
  if (decision === 'approve') {
    const need = ['name_matches', 'face_matches', 'id_original'];
    const missing = need.filter((c) => !(o.checks ?? []).includes(c));
    if (missing.length) throw new UserError('Tick all three checks (name, face and original ID) before approving.');
  } else if (!REJECT_REASONS[String(o.reason)] || (o.reason === 'other' && note.length < 5)) throw new UserError('Choose why the check failed (and add a note for “Other”).');
  const keepUntil = new Date(Date.now() + config.idDocRetentionDays * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await tx(async () => {
    if (decision === 'approve') {
      const clash = await db.val<string>(`SELECT code FROM farmers WHERE id<>$1 AND status='active' AND id_type=$2 AND id_number_hash=$3`, k.farmer_id, k.id_type, k.id_number_hash);
      if (clash) throw new UserError(`The same ID number was approved on ${clash} meanwhile. Reject this one and merge the records.`);
      await db.run(`UPDATE kyc_submissions SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1`, k.id, a.user.id, note || null);
      await db.run(`UPDATE farmers SET kyc_level=GREATEST(kyc_level,1), kyc='verified', id_type=$2, id_number_hash=$3, id_last4=$4, photo_file_id=$5, updated_at=now() WHERE id=$1`,
        k.farmer_id, k.id_type, k.id_number_hash, k.id_last4, k.selfie_file_id);
      // The ID photo is only needed as evidence for a while; the selfie stays as the record's photo.
      await db.run(`UPDATE files SET delete_after=$2 WHERE id=$1`, k.id_doc_file_id, keepUntil);
    } else {
      await db.run(`UPDATE kyc_submissions SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1`, k.id, a.user.id, `${REJECT_REASONS[o.reason!]}${note ? ': ' + note : ''}`);
      await db.run(`UPDATE farmers SET kyc='failed', updated_at=now() WHERE id=$1`, k.farmer_id);
      await db.run(`UPDATE files SET delete_after=$3 WHERE id IN ($1,$2)`, k.id_doc_file_id, k.selfie_file_id, soon);
    }
    // Track how often people agree with the AI flag (green→approve, red→reject), to judge it before relying on it more.
    const agreed = k.ai_flag === 'green' ? decision === 'approve' : k.ai_flag === 'red' ? decision === 'reject' : null;
    await db.run('UPDATE kyc_submissions SET reviewer_agreed_with_ai=$2 WHERE id=$1', k.id, agreed);
    await audit(actorOf(a), `kyc.${decision === 'approve' ? 'approved' : 'rejected'}`, { entity: 'farmer', entityId: k.farmer_id, data: { submission: k.id, reason: o.reason ?? null } });
  });
}

// ---------- consent to share with a lender ----------
export const CONSENT_TEXT = (lender: string) =>
  `I agree that Kitovu may share my StorageX record (name, phone, location, identity check result and stored produce) with ${lender} so they can consider me for a loan. I can withdraw this at any time by calling Kitovu.`;

export async function lenders() { return db.all<{ id: string; name: string }>(`SELECT id, name FROM organisations WHERE kind='lender' AND status IN ('active','onboarding') ORDER BY name`); }

export async function sendConsentCode(a: Actor, code: string, orgId: string, channel: 'sms' | 'voice' = 'sms') {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot record consent.');
  const f = await farmerByCode(a, code);
  if (!f?.phone_e164 || !f.phone_verified_at) throw new UserError('Consent by code needs a confirmed phone. Use the signed paper form instead.');
  if (!(await phoneMethods())[channel]) throw new UserError(`${channel === 'sms' ? 'Text-message' : 'Voice-call'} codes are switched off.`);
  const lender = await db.get<{ name: string }>(`SELECT name FROM organisations WHERE id=$1 AND kind='lender'`, orgId);
  if (!lender) throw new UserError('Choose a lender.');
  await issueOtp('farmer_consent', f.id, f.phone_e164, (c) => `StorageX: code ${c} lets Kitovu share your record with ${lender.name} for a loan. Give it only if you agree. Withdraw any time: call Kitovu.`, channel);
}

export async function recordConsent(a: Actor, code: string, i: { org_id?: string; method?: string; otp?: string; read_aloud?: string }, evidence?: Upload) {
  if (!can(a.membership, 'farmers.edit')) throw new NotAllowed('Your role cannot record consent.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  const lender = await db.get<{ id: string; name: string }>(`SELECT id, name FROM organisations WHERE id=$1 AND kind='lender'`, i.org_id);
  if (!lender) throw new UserError('Choose a lender.');
  if (i.read_aloud !== '1') throw new UserError('Confirm you read the consent statement to the farmer in a language they understand.');
  const method = String(i.method);
  if (method === 'sms_code') {
    const r = await checkOtp('farmer_consent', f.id, String(i.otp ?? ''));
    if (!r.ok) throw new UserError(r.reason);
  } else if (method !== 'paper_form') throw new UserError('Choose how the farmer agreed.');
  if (await db.val(`SELECT 1 FROM farmer_consents WHERE farmer_id=$1 AND org_id=$2 AND withdrawn_at IS NULL`, f.id, lender.id)) throw new UserError(`Consent for ${lender.name} is already on record.`);
  await tx(async () => {
    const fileId = method === 'paper_form'
      ? await saveFile(evidence, { kind: 'consent_evidence', entity: 'farmer', entityId: f.id, userId: a.user.id, allowPdf: true, label: 'Photo of the signed or thumb-printed form' })
      : null;
    const id = await db.val<string>(`INSERT INTO farmer_consents (farmer_id, org_id, method, evidence_file_id, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, f.id, lender.id, method, fileId, a.user.id);
    await audit(actorOf(a), 'consent.recorded', { orgId: lender.id, entity: 'farmer', entityId: f.id, data: { consent: id, method, lender: lender.name } });
  });
}

export async function withdrawConsent(a: Actor, consentId: string, reason: string) {
  if (!can(a.membership, 'farmers.edit') || a.membership?.org_kind !== 'kitovu') throw new NotAllowed('Consent is withdrawn by Kitovu when the farmer asks.');
  const c = await db.get<{ farmer_id: string; org_id: string }>('SELECT farmer_id, org_id FROM farmer_consents WHERE id=$1 AND withdrawn_at IS NULL', consentId);
  if (!c) throw new UserError('That consent is not active.');
  await tx(async () => {
    await db.run('UPDATE farmer_consents SET withdrawn_at=now(), withdrawn_by=$2 WHERE id=$1', consentId, a.user.id);
    await audit(actorOf(a), 'consent.withdrawn', { orgId: c.org_id, entity: 'farmer', entityId: c.farmer_id, data: { consent: consentId, reason: clean(reason, 200) } });
  });
}

export const consentsFor = (farmerId: string) => db.all<{ id: string; org_id: string; org_name: string; method: string; evidence_file_id: string | null; given_at: Date; recorded_by_name: string; withdrawn_at: Date | null }>(
  `SELECT c.id, c.org_id, o.name AS org_name, c.method, c.evidence_file_id, c.given_at, u.full_name AS recorded_by_name, c.withdrawn_at
   FROM farmer_consents c JOIN organisations o ON o.id=c.org_id JOIN users u ON u.id=c.recorded_by WHERE c.farmer_id=$1 ORDER BY c.given_at DESC`, farmerId);

// ---------- level 2: lender confirms the account ----------
export async function lenderVerify(a: Actor, code: string, customerRef: string) {
  const m = a.membership;
  if (!m || m.org_kind !== 'lender' || !can(m, 'farmers.verify_account')) throw new NotAllowed('Only a lender’s credit staff can confirm an account.');
  const f = await farmerByCode(a, code);   // lenders only see farmers who consented to them
  if (!f) throw new UserError('Farmer not found, or they have not agreed to share their record with you.');
  if (f.kyc_level < 1) throw new UserError('Kitovu has not checked this farmer’s identity yet.');
  const ref = clean(customerRef, 40);
  if (!/^[\w\-/.]{3,40}$/.test(ref)) throw new UserError('Enter your customer reference (3–40 letters, digits, - / .).');
  if (/^\d{10}$/.test(ref)) throw new UserError('That looks like a bank account number. Enter your internal customer reference instead; StorageX never stores account numbers.');
  if (await db.val('SELECT 1 FROM lender_verifications WHERE farmer_id=$1 AND org_id=$2 AND revoked_at IS NULL', f.id, m.org_id)) throw new UserError('You have already confirmed this farmer.');
  await tx(async () => {
    await db.run('INSERT INTO lender_verifications (farmer_id, org_id, customer_ref, verified_by) VALUES ($1,$2,$3,$4)', f.id, m.org_id, ref, a.user.id);
    await db.run('UPDATE farmers SET kyc_level=2, updated_at=now() WHERE id=$1', f.id);
    await audit(actorOf(a), 'kyc.lender_verified', { orgId: m.org_id, entity: 'farmer', entityId: f.id, data: { code: f.code } });
  });
}

export async function lenderRevoke(a: Actor, code: string) {
  const m = a.membership;
  if (!m || m.org_kind !== 'lender' || !can(m, 'farmers.verify_account')) throw new NotAllowed('Only a lender’s credit staff can do this.');
  const f = await farmerByCode(a, code);
  if (!f) throw new UserError('Farmer not found.');
  await tx(async () => {
    const n = await db.run('UPDATE lender_verifications SET revoked_at=now(), revoked_by=$3 WHERE farmer_id=$1 AND org_id=$2 AND revoked_at IS NULL', f.id, m.org_id, a.user.id);
    if (!n) throw new UserError('There is no confirmation from you to withdraw.');
    await db.run(`UPDATE farmers SET kyc_level = CASE WHEN EXISTS (SELECT 1 FROM lender_verifications WHERE farmer_id=$1 AND revoked_at IS NULL) THEN 2 ELSE LEAST(kyc_level,1) END, updated_at=now() WHERE id=$1`, f.id);
    await audit(actorOf(a), 'kyc.lender_revoked', { orgId: m.org_id, entity: 'farmer', entityId: f.id, data: { code: f.code } });
  });
}

/** Lenders see only their own reference; Kitovu sees which lenders confirmed (never anyone's account details). */
export const verificationsFor = (a: Actor, farmerId: string) => db.all<{ org_name: string; customer_ref: string | null; verified_at: Date; revoked_at: Date | null }>(
  `SELECT o.name AS org_name, CASE WHEN v.org_id=$2 THEN v.customer_ref END AS customer_ref, v.verified_at, v.revoked_at
   FROM lender_verifications v JOIN organisations o ON o.id=v.org_id WHERE v.farmer_id=$1 AND ($3 OR v.org_id=$2) ORDER BY v.verified_at DESC`,
  farmerId, a.membership!.org_id, a.membership!.org_kind === 'kitovu');

// ---------- who may open an uploaded file ----------
export async function canOpenFile(a: Actor, f: { kind: string; entity: string; entity_id: string }) {
  const m = a.membership;
  // Delivery photos: Kitovu, and the operator of the warehouse where the delivery was recorded.
  if (f.kind === 'intake_evidence' && m && m.org_kind !== 'kitovu')
    return can(m, 'stock.manage') && !!(await db.val(`SELECT 1 FROM intakes i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=$1 AND w.operator_org_id=$2`, f.entity_id, m.org_id));
  if (!m || m.org_kind !== 'kitovu') return false;           // identity documents never leave Kitovu
  if (f.kind === 'id_document') return can(m, 'kyc.review');
  if (f.kind === 'selfie' || f.kind === 'consent_evidence') return can(m, 'kyc.review') || can(m, 'farmers.edit');
  if (f.kind === 'intake_evidence') return can(m, 'stock.manage') || can(m, 'warehouses.view');
  return can(m, 'warehouses.edit');
}
