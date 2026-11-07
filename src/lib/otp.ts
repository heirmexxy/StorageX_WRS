// One-time 6-digit codes by SMS: farmer phone checks and the SMS second step. Hashes only; 10 minutes; 5 tries;
// at most 3 codes per subject per 15 minutes.
import { UserError } from './errors';
import crypto from 'node:crypto';
import { db } from './db';
import { hmac, minutesFromNow } from './util';
import { rateLimit } from './auth';
import { sendSms, sendVoiceCode } from './sms';

export type OtpPurpose = 'farmer_phone' | 'farmer_consent' | 'login_sms';
export class OtpError extends UserError {}

const codeHash = (id: string, code: string) => hmac(`otp:${id}:${code}`);

export async function issueOtp(purpose: OtpPurpose, subjectId: string, phone: string, message: (code: string) => string, channel: 'sms' | 'voice' = 'sms') {
  if (!(await rateLimit(`otp:${purpose}:${subjectId}`, 3, 15 * 60))) throw new OtpError('Three codes were sent in the last 15 minutes. Wait a little, then try again.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.run(`UPDATE otp_codes SET used_at=now() WHERE purpose=$1 AND subject_id=$2 AND used_at IS NULL`, purpose, subjectId);
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO otp_codes (id, purpose, subject_id, phone_e164, code_hash, expires_at, channel) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    id, purpose, subjectId, phone, codeHash(id, code), minutesFromNow(10), channel);
  const r = channel === 'voice' ? await sendVoiceCode(phone, code) : await sendSms(phone, message(code));
  if (!r.ok) { await db.run('UPDATE otp_codes SET used_at=now() WHERE id=$1', id); throw new OtpError(`The ${channel === 'voice' ? 'call' : 'text message'} could not be sent (${r.error}).`); }
}

/** True once for the newest unexpired code; wrong guesses count against it and five end it. */
export async function checkOtp(purpose: OtpPurpose, subjectId: string, codeIn: string) {
  const code = String(codeIn || '').replace(/\D/g, '');
  const row = await db.get<{ id: string; code_hash: string; attempts: number; phone_e164: string; channel: 'sms' | 'voice' }>(
    `SELECT id, code_hash, attempts, phone_e164, channel FROM otp_codes WHERE purpose=$1 AND subject_id=$2 AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`, purpose, subjectId);
  if (!row) return { ok: false as const, reason: 'No active code. Send a new one.' };
  if (code.length === 6 && crypto.timingSafeEqual(Buffer.from(codeHash(row.id, code)), Buffer.from(row.code_hash))) {
    await db.run('UPDATE otp_codes SET used_at=now() WHERE id=$1', row.id);
    return { ok: true as const, phone: row.phone_e164, channel: row.channel };
  }
  const n = row.attempts + 1;
  await db.run(`UPDATE otp_codes SET attempts=$2::smallint, used_at=CASE WHEN $2::smallint >= 5 THEN now() ELSE NULL END WHERE id=$1`, row.id, n);
  return { ok: false as const, reason: n >= 5 ? 'Too many wrong codes. Send a new one.' : 'That code is not right.' };
}
