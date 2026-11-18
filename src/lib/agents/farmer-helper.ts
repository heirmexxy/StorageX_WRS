// Farmer helper: answers "what is my produce worth and what do I owe?" on any phone, in the farmer's language.
// The numbers are worked out here from the records (produce still held × today's reference price; what is owed
// on running loans, interest included). The wording is the approved template for the farmer's language, so a
// Hausa, Yoruba, Igbo or Pidgin answer goes out only after a Kitovu speaker of that language has approved it;
// until then the farmer gets English. USSD shows it on screen; a text can be sent on request. Incoming texts
// (keywords such as BAL, KUDI, OWO, EGO) are answered by smsKeyword() once an inbound SMS number is connected.
import { db } from '../db';
import { fmtNGN } from '../money';
import { position, entriesOf } from '../finance';
import { referencePrice } from '../valuation';
import { render, notifyFarmer, EVENTS } from '../notify';
import { normPhone } from '../util';
import { LIVE } from '../stock';

const short = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const DAY = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
export const KEYWORDS = ['BAL', 'BALANCE', 'KUDI', 'OWO', 'EGO', 'STORAGEX'];

/** The farmer's position in numbers, and the words to fill the template with. */
export async function balance(farmerId: string) {
  const f = await db.get<any>('SELECT id, language, state_code FROM farmers WHERE id=$1', farmerId);
  if (!f) return null;
  const held = await db.all<any>(`SELECT r.commodity_code, c.name AS crop, w.state_code, sum(b.remaining_kg)::float AS kg FROM receipts r JOIN receipt_balances b ON b.receipt_id=r.id
    JOIN commodities c ON c.code=r.commodity_code JOIN warehouses w ON w.id=r.warehouse_id WHERE r.owner_farmer_id=$1 AND r.status::text = ANY($2) AND b.remaining_kg > 0 GROUP BY 1,2,3`, farmerId, LIVE);
  let worth = 0, unpriced = false;
  for (const h of held) { const p = (await referencePrice(h.commodity_code, h.state_code)).kobo_per_kg; if (p == null) unpriced = true; else worth += h.kg * p; }
  const loans = await db.all<any>(`SELECT * FROM loans WHERE farmer_id=$1 AND status='disbursed' ORDER BY due_on`, farmerId);
  let owed = 0;
  for (const ln of loans) owed += position(ln, await entriesOf(ln.id)).outstanding;
  const byCrop = new Map<string, number>(); for (const h of held) byCrop.set(h.crop, (byCrop.get(h.crop) ?? 0) + h.kg);
  const heldText = held.length ? [...byCrop].map(([c, kg]) => `${Math.round(kg).toLocaleString('en-NG')}kg ${c}`).join(', ') : '0kg';
  return {
    language: f.language as string, worth, owed, unpriced, kg: held.reduce((n, h) => n + h.kg, 0),
    vars: { held: heldText, worth: held.length ? (unpriced && !worth ? '?' : short(worth)) : short(0), owed: short(owed), due: loans[0] ? DAY(loans[0].due_on) : '-' },
  };
}

/** The answer in the farmer's approved language (English until a translation is approved). */
export async function answer(farmerId: string) {
  const b = await balance(farmerId);
  if (!b) return null;
  const rows = await db.all<{ language: string; body: string }>(`SELECT language, body FROM message_templates WHERE event='balance_reply' AND status='live' AND language = ANY($1)`, [b.language, 'en']);
  const t = rows.find((r) => r.language === b.language) ?? rows.find((r) => r.language === 'en');
  return { ...b, text: render(t?.body ?? EVENTS.balance_reply.en, b.vars), translated: t?.language === b.language && b.language !== 'en' };
}

/** Send the answer by text (logged like every farmer text). One per farmer per hour. */
export async function textAnswer(farmerId: string) {
  const b = await balance(farmerId);
  if (!b) return { status: 'skipped' as const };
  return notifyFarmer(farmerId, 'balance_reply', `bal:${new Date().toISOString().slice(0, 13)}`, b.vars);
}

/** An incoming text: if it is a helper keyword from a registered farmer's confirmed phone, the reply to send. */
export async function smsKeyword(from: string, text: string) {
  const word = String(text ?? '').trim().toUpperCase().split(/\s+/)[0];
  if (!KEYWORDS.includes(word)) return null;
  const phone = normPhone(from);
  if (!phone) return null;
  const fs = await db.all<{ id: string }>(`SELECT id FROM farmers WHERE phone_e164=$1 AND phone_verified_at IS NOT NULL AND status='active' ORDER BY created_at`, phone);
  if (fs.length !== 1) return fs.length ? 'StorageX: more than one farmer uses this phone. Dial the USSD code to choose whose record.' : null;
  return (await answer(fs[0].id))!.text;
}
