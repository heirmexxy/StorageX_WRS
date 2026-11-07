// Ed25519 signing key for receipts, derived from APP_SECRET so it survives restarts without another secret to
// manage. Partners (ComboTrader, TradeChainX, lenders' apps) can check a receipt offline with the public key
// published at /.well-known/storagex-receipt-key.json.
import crypto from 'node:crypto';
import { config } from './config';

let cached: { priv: crypto.KeyObject; pub: crypto.KeyObject; kid: string } | null = null;
function keys() {
  if (cached) return cached;
  const seed = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(config.secret), Buffer.from('storagex'), Buffer.from('receipt-signing-ed25519-v1'), 32));
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const raw = pub.export({ format: 'jwk' }).x as string;
  cached = { priv, pub, kid: 'sx-r1-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8) };
  return cached;
}
export const keyId = () => keys().kid;
export const sign = (msg: string) => crypto.sign(null, Buffer.from(msg), keys().priv).toString('base64url');
export function verify(msg: string, sig: string) {
  try { return crypto.verify(null, Buffer.from(msg), keys().pub, Buffer.from(sig, 'base64url')); } catch { return false; }
}
export const publicJwk = () => ({ ...keys().pub.export({ format: 'jwk' }), kid: keys().kid, use: 'sig', alg: 'EdDSA' });
