// Money is integer kobo everywhere (₦1 = 100 kobo). These are the only places that convert to or from text.

const MAX = Number.MAX_SAFE_INTEGER;

/** Parse "₦1,234.50", "1234.5" or "1234" into kobo. Throws on anything ambiguous. */
export function toKobo(input: string | number): number {
  const s = String(input).replace(/[₦,\s]/g, '').replace(/^NGN/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Not a naira amount: ${input}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const kobo = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(kobo) || kobo > MAX) throw new Error('Amount too large');
  return neg ? -kobo : kobo;
}

/** Format kobo as "₦1,234.50". Kobo from Postgres bigint columns arrives as a string; both are accepted. */
export function fmtNGN(kobo: number | string | bigint, o: { decimals?: boolean } = {}) {
  const k = typeof kobo === 'number' ? kobo : Number(kobo);
  if (!Number.isSafeInteger(k)) throw new Error('Invalid kobo value');
  const neg = k < 0, abs = Math.abs(k);
  const naira = Math.floor(abs / 100), rem = abs % 100;
  const body = naira.toLocaleString('en-NG') + (o.decimals === false ? '' : '.' + String(rem).padStart(2, '0'));
  return `${neg ? '-' : ''}₦${body}`;
}

/** value of `kg` at `perKgKobo`, rounded half-up to the kobo. */
export function valueKobo(kg: number | string, perKgKobo: number) {
  const grams = Math.round(Number(kg) * 1000);
  return Math.round((grams * perKgKobo) / 1000);
}

/** basis points (1% = 100 bp) of an amount, rounded down so advances never exceed the limit. */
export const bpOf = (kobo: number, bp: number) => Math.floor((kobo * bp) / 10_000);
