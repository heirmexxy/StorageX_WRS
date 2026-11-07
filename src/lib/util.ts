// Small shared helpers: tokens, hashing, signing, secret encryption, passwords.
import crypto from 'node:crypto';
import { config } from './config';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s: string) => crypto.createHmac('sha256', config.secret).update(s).digest('base64url');
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// AES-256-GCM with a key derived from APP_SECRET. Used for 2FA secrets at rest.
const encKey = () => crypto.createHash('sha256').update('storagex:enc:' + config.secret).digest();
export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
export function decrypt(box: string) {
  const [v, iv, tag, data] = box.split('.');
  if (v !== 'v1') throw new Error('unknown cipher version');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

export function encryptBuffer(plain: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from('SXE1'), iv, c.getAuthTag(), data]);
}
export function decryptBuffer(box: Buffer) {
  if (box.subarray(0, 4).toString() !== 'SXE1') throw new Error('unknown file cipher');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), box.subarray(4, 16));
  d.setAuthTag(box.subarray(16, 32));
  return Buffer.concat([d.update(box.subarray(32)), d.final()]);
}

/** Keyed hash of an identity number: equal numbers give equal hashes (duplicate checks), but it cannot be reversed. */
export const hashIdNumber = (type: string, normalised: string) => crypto.createHmac('sha256', 'storagex:id:' + config.secret).update(`${type}:${normalised}`).digest('hex');

/** scrypt password hashing: scrypt$N$r$p$salt$hash (same format as ComboTrader). */
export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}
/** Returns a problem to show, or null if the password is acceptable. */
export function passwordProblem(pw: string, email = '') {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) return 'Do not use your email name in the password.';
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|password)/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}

export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
export const hoursFromNow = (h: number) => minutesFromNow(h * 60);

/** Nigerian-first phone normalisation to E.164: 0803..., 803..., 234803..., +234803... and other +country numbers. */
export function normPhone(raw: unknown): string | null {
  let p = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
  if (p.startsWith('00')) return normPhone('+' + p.slice(2));
  if (/^234\d{10}$/.test(p)) return '+' + p;
  if (/^0[789]\d{9}$/.test(p)) return '+234' + p.slice(1);
  if (/^[789]\d{9}$/.test(p)) return '+234' + p;
  return null;
}
export const clean = (v: unknown, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
