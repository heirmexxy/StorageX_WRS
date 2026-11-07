// Identity pre-check agent. It reads the ID photo, the face photo and the record, and reports what it sees so the
// Kitovu reviewer can decide faster and more consistently. It never approves or rejects, never writes out a full
// ID number, and does not judge whether the face photo and the ID show the same person: that stays with the
// human reviewer (or, later, a licensed face-match provider).
// The traffic-light flag is computed here in code from the findings, not chosen by the model.
import { db } from '../db';
import { config } from '../config';
import { audit, systemActor } from '../audit';
import { fileRow, readFile } from '../files';
import { similar } from '../registry';
import { getSettings } from '../settings';
import { defaultModel, type ModelCall } from './model';
export type { ModelCall } from './model';

export const PROMPT_VERSION = 'kyc-screen-1';

export interface Findings {
  document: {
    type_seen: 'nin_slip' | 'nin_card' | 'voters_card' | 'drivers_licence' | 'intl_passport' | 'other' | 'unreadable';
    legible: boolean;
    name_on_document: string | null;
    name_match: 'exact' | 'close' | 'different' | 'unreadable';
    last4_seen: string | null;
    year_of_birth_seen: number | null;
    expiry_date: string | null;
    original_capture: 'yes' | 'no' | 'unsure';
    original_note: string;
  };
  face_photo: { one_clear_face: boolean; live_capture: 'yes' | 'no' | 'unsure'; quality_note: string };
  concerns: string[];
  suggested_reject_reason: 'unreadable' | 'mismatch_name' | 'not_original' | 'expired' | 'other' | null;
}

const TYPE_FOR: Record<string, Findings['document']['type_seen'][]> = {
  nin: ['nin_slip', 'nin_card'], voters_card: ['voters_card'], drivers_licence: ['drivers_licence'], intl_passport: ['intl_passport'],
};

const SYSTEM = `You help a compliance officer at Kitovu, a Nigerian agricultural company, check identity submissions for smallholder farmers.
You receive two photos taken by a field agent on a phone: image 1 should be a Nigerian identity document, image 2 should be a fresh photo of the farmer's face.
You also receive what the agent typed into the record.

Report only what you can see. Rules:
- Never write out a full identity number. You may report the last 4 characters you can read, nothing more.
- Do not decide whether the face photo and the document photo show the same person, and do not identify anyone. Only describe photo quality.
- Nigerian names may appear in a different order on the document (surname first) or with a middle name; that still counts as "exact" if the same names are present. Use "close" for small spelling differences, "different" when the names do not belong to the same person, "unreadable" when you cannot read the name.
- original_capture: "no" if image 1 looks like a photocopy, a printout of a scan, or a photo of a screen; "unsure" if you cannot tell.
- live_capture: "no" if image 2 looks like a photo of a printed photo, an ID card, or a screen.
- expiry_date: as YYYY-MM-DD if a printed expiry date is readable, else null. The NIN slip has no expiry.
- concerns: short plain-English notes for the reviewer (at most 5). Empty if none.
Answer with one JSON object only, no other text, in exactly this shape:
{"document":{"type_seen":"nin_slip|nin_card|voters_card|drivers_licence|intl_passport|other|unreadable","legible":true,"name_on_document":"…|null","name_match":"exact|close|different|unreadable","last4_seen":"…|null","year_of_birth_seen":1980,"expiry_date":"YYYY-MM-DD|null","original_capture":"yes|no|unsure","original_note":"…"},"face_photo":{"one_clear_face":true,"live_capture":"yes|no|unsure","quality_note":"…"},"concerns":[],"suggested_reject_reason":"unreadable|mismatch_name|not_original|expired|other|null"}`;

export interface Record4Screen { full_name: string; id_type: string; id_last4: string; year_of_birth: number | null; state_name: string | null }

/** Deterministic flag from the findings: red = a likely reason to reject; amber = a person must look closely. */
export function flagOf(f: Findings, r: Record4Screen, today = new Date()): { flag: 'green' | 'amber' | 'red'; reasons: string[] } {
  const red: string[] = [], amber: string[] = [];
  const d = f.document;
  if (d.type_seen === 'unreadable' || !d.legible) red.push('ID photo is not readable');
  else if (!TYPE_FOR[r.id_type]?.includes(d.type_seen)) red.push(`Document looks like ${d.type_seen.replace(/_/g, ' ')}, not the ID type entered`);
  if (d.name_match === 'different') red.push('Name on the ID differs from the record');
  else if (d.name_match === 'close') amber.push('Name spelling differs slightly');
  else if (d.name_match === 'unreadable') amber.push('Name on the ID could not be read');
  if (d.name_on_document && d.name_match === 'exact' && !similar(d.name_on_document, r.full_name)) amber.push('Model says the names match, but they share few words: check');
  if (d.last4_seen && d.last4_seen.toUpperCase() !== r.id_last4.toUpperCase()) red.push(`Last 4 on the ID (${d.last4_seen}) differ from the number entered (${r.id_last4})`);
  else if (!d.last4_seen) amber.push('ID number not readable on the photo');
  if (d.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(d.expiry_date) && new Date(d.expiry_date) < today) red.push(`ID expired on ${d.expiry_date}`);
  if (d.original_capture === 'no') red.push('ID looks like a copy or a screen');
  else if (d.original_capture === 'unsure') amber.push('Cannot tell if the ID photo is of the original');
  if (r.year_of_birth && d.year_of_birth_seen && Math.abs(d.year_of_birth_seen - r.year_of_birth) > 1) amber.push(`Year of birth on the ID (${d.year_of_birth_seen}) differs from the record (${r.year_of_birth})`);
  if (!f.face_photo.one_clear_face) red.push('Face photo does not show one clear face');
  if (f.face_photo.live_capture === 'no') red.push('Face photo looks like a photo of a photo or a screen');
  else if (f.face_photo.live_capture === 'unsure') amber.push('Cannot tell if the face photo was taken live');
  return red.length ? { flag: 'red', reasons: [...red, ...amber] } : amber.length ? { flag: 'amber', reasons: amber } : { flag: 'green', reasons: [] };
}

export function parseFindings(text: string): Findings {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in the answer');
  const f = JSON.parse(m[0]);
  if (!f?.document || !f?.face_photo) throw new Error('answer is missing document or face_photo');
  const d = f.document;
  const s = (v: unknown) => (v == null || v === 'null' ? null : String(v).slice(0, 120));
  return {
    document: {
      type_seen: d.type_seen ?? 'unreadable', legible: !!d.legible, name_on_document: s(d.name_on_document),
      name_match: ['exact', 'close', 'different', 'unreadable'].includes(d.name_match) ? d.name_match : 'unreadable',
      // Keep at most 4 characters even if the model wrote more.
      last4_seen: s(d.last4_seen)?.replace(/[\s-]/g, '').slice(-4) || null,
      year_of_birth_seen: Number.isInteger(d.year_of_birth_seen) ? d.year_of_birth_seen : null,
      expiry_date: s(d.expiry_date), original_capture: ['yes', 'no', 'unsure'].includes(d.original_capture) ? d.original_capture : 'unsure', original_note: String(d.original_note ?? '').slice(0, 300),
    },
    face_photo: { one_clear_face: !!f.face_photo.one_clear_face, live_capture: ['yes', 'no', 'unsure'].includes(f.face_photo.live_capture) ? f.face_photo.live_capture : 'unsure', quality_note: String(f.face_photo.quality_note ?? '').slice(0, 300) },
    concerns: Array.isArray(f.concerns) ? f.concerns.slice(0, 5).map((c: unknown) => String(c).slice(0, 200)) : [],
    suggested_reject_reason: ['unreadable', 'mismatch_name', 'not_original', 'expired', 'other'].includes(f.suggested_reject_reason) ? f.suggested_reject_reason : null,
  };
}

/** Runs the pre-check for one submission and stores the result. Never throws: a failure is recorded and the human reviews as usual. */
export async function screenSubmission(submissionId: string, call: ModelCall | null = defaultModel()) {
  const s = await db.get<Record4Screen & { id_doc_file_id: string; selfie_file_id: string; farmer_id: string; status: string }>(
    `SELECT k.id_doc_file_id, k.selfie_file_id, k.farmer_id, k.status, k.id_type, k.id_last4, f.full_name, f.year_of_birth, st.name AS state_name
     FROM kyc_submissions k JOIN farmers f ON f.id=k.farmer_id LEFT JOIN states st ON st.code=f.state_code WHERE k.id=$1`, submissionId);
  if (!s || s.status !== 'pending') return null;
  const save = (status: string, o: { result?: unknown; flag?: string | null; error?: string; tin?: number; tout?: number } = {}) => db.run(
    `INSERT INTO kyc_ai_checks (submission_id, status, model, prompt_version, result, flag, error, tokens_in, tokens_out) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    submissionId, status, call ? config.aiModel : null, PROMPT_VERSION, o.result ?? null, o.flag ?? null, o.error ?? null, o.tin ?? null, o.tout ?? null);
  // Off if either the server file or the admin setting says so.
  if (config.kycAiMode === 'off' || (await getSettings())['kyc.ai_mode'] === 'off') return null;
  if (!call) { await save('skipped', { error: 'No ANTHROPIC_API_KEY on this server' }); return null; }
  try {
    const files = await Promise.all([fileRow(s.id_doc_file_id), fileRow(s.selfie_file_id)]);
    const content: unknown[] = files.map((f) => ({ type: 'image', source: { type: 'base64', media_type: f!.mime, data: readFile(f!).toString('base64') } }));
    content.push({ type: 'text', text: `Record typed by the field agent:\n- Full name: ${s.full_name}\n- ID type: ${s.id_type}\n- Last 4 of ID number: ${s.id_last4}\n- Year of birth: ${s.year_of_birth ?? 'not recorded'}\n- State: ${s.state_name ?? 'not recorded'}\nImage 1 is the ID document. Image 2 is the face photo.` });
    const r = await call(SYSTEM, content);
    const findings = parseFindings(r.text);
    const { flag, reasons } = flagOf(findings, s);
    await save('done', { result: { ...findings, reasons }, flag, tin: r.tin, tout: r.tout });
    await db.run('UPDATE kyc_submissions SET ai_flag=$2 WHERE id=$1', submissionId, flag);
    await audit(systemActor('kyc-screen'), 'kyc.ai_screened', { entity: 'farmer', entityId: s.farmer_id, data: { submission: submissionId, flag, model: config.aiModel, prompt: PROMPT_VERSION } });
    return flag;
  } catch (e: any) {
    await save('failed', { error: String(e?.message || e).slice(0, 300) });
    return null;
  }
}

export const latestCheck = (submissionId: string) =>
  db.get<{ status: string; flag: string | null; result: any; error: string | null; model: string | null; created_at: Date }>(
    'SELECT status, flag, result, error, model, created_at FROM kyc_ai_checks WHERE submission_id=$1 ORDER BY created_at DESC LIMIT 1', submissionId);
