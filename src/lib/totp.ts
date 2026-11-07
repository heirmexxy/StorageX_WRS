// RFC 6238 TOTP (30s, 6 digits, SHA-1) — compatible with Google Authenticator, Authy, etc.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secret: string, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret: string | null | undefined, code: string, window = 1) {
  if (!secret) return false;
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) if (totpCode(secret, Date.now() + w * 30000) === c) return true;
  return false;
}
export function otpauthUrl(secret: string, email: string) {
  return `otpauth://totp/StorageX:${encodeURIComponent(email)}?secret=${secret}&issuer=StorageX&digits=6&period=30`;
}
