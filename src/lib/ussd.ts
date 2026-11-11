// USSD status menu for farmers, in the Africa's Talking format: the gateway posts the session id, the phone number
// and everything typed so far joined by '*'; we answer "CON ..." to show a screen and wait, or "END ..." to finish.
// Nothing is kept between steps, so the PIN is checked again on every step. The PIN and raw keypad text are never
// stored or logged.
import { db } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { hashPassword, verifyPassword, hmac, normPhone } from './util';
import { rateLimit } from './auth';
import { getSettings } from './settings';
import { fmtNGN } from './money';
import { position, entriesOf } from './finance';
import { referencePrice } from './valuation';
import { notifyFarmer } from './notify';

const MAX_TRIES = 3, LOCK_HOURS = 24, SCREEN = 182;
const pinKey = (farmerId: string, pin: string) => hmac(`ussd-pin:${farmerId}:${pin}`);
const weakPin = (p: string) => /^(\d)\1{3}$/.test(p) || ['1234', '2345', '3456', '4567', '5678', '6789', '4321', '0123', '1212', '2580', '1122'].includes(p);
const first = (name: string) => name.split(/\s+/)[0];
const short = (n: number) => fmtNGN(n, { decimals: false });
const day = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')}kg`;
const STATUS: Record<string, string> = { issued: 'held', partially_released: 'held', pledged: 'pledged', financed: 'on loan', sale_approved: 'being sold', under_exception: 'under check' };

/** Fit lines into one screen; say how many did not fit. */
function fit(head: string, lines: string[], tail = '') {
  let out = head;
  let shown = 0;
  for (const l of lines) {
    const more = lines.length - shown - 1;
    const extra = more > 0 ? `\n+${more} more` : '';
    if ((out + '\n' + l + extra + (tail ? '\n' + tail : '')).length > SCREEN - 4) break;
    out += '\n' + l; shown++;
  }
  if (shown < lines.length) out += `\n+${lines.length - shown} more`;
  if (tail && (out + '\n' + tail).length <= SCREEN - 4) out += '\n' + tail;
  return out;
}

export const MENU = 'CON StorageX\n1 My produce\n2 My loans\n3 Sales and payments\n4 Prices today\n5 Ask Kitovu to call me';

async function receiptsScreen(fid: string) {
  const rs = await db.all<any>(`SELECT r.receipt_no, r.status, c.name AS crop, b.remaining_kg::float AS left
    FROM receipts r JOIN commodities c ON c.code=r.commodity_code JOIN receipt_balances b ON b.receipt_id=r.id
    WHERE r.owner_farmer_id=$1 AND r.status IN ('issued','partially_released','pledged','financed','sale_approved','under_exception') ORDER BY r.issued_at DESC`, fid);
  if (!rs.length) return 'END You have no produce in store with StorageX.';
  return 'END ' + fit('Your produce:', rs.map((r) => `${r.receipt_no} ${r.crop} ${kg(r.left)} ${STATUS[r.status] ?? r.status}`));
}

async function loansScreen(fid: string) {
  const ls = await db.all<any>(`SELECT ln.*, o.name AS lender FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id WHERE ln.farmer_id=$1 AND ln.status='disbursed' ORDER BY ln.due_on`, fid);
  if (!ls.length) return 'END You have no loan running with StorageX.';
  const lines = [];
  for (const ln of ls) {
    const p = position(ln, await entriesOf(ln.id));
    lines.push(`${ln.loan_no} owe ${short(p.outstanding)}, due ${day(ln.due_on)} (${ln.lender})`);
  }
  return 'END ' + fit('Your loans:', lines);
}

async function salesScreen(fid: string) {
  const ls = await db.all<any>(`SELECT s.ref, sl.amount_kobo::float AS amount, sl.paid_at FROM settlement_lines sl JOIN settlements st ON st.id=sl.settlement_id JOIN sales s ON s.id=st.sale_id
    WHERE sl.farmer_id=$1 AND sl.party='farmer' ORDER BY st.settled_at DESC LIMIT 5`, fid);
  const open = await db.all<any>(`SELECT DISTINCT s.ref, s.status FROM sales s JOIN sale_items si ON si.sale_id=s.id JOIN receipts r ON r.id=si.receipt_id
    WHERE r.owner_farmer_id=$1 AND s.status NOT IN ('settled','cancelled')`, fid);
  if (!ls.length && !open.length) return 'END No sales yet.';
  return 'END ' + fit('Sales:', [...open.map((s) => `${s.ref} in progress`), ...ls.map((l) => `${l.ref} ${short(l.amount)} ${l.paid_at ? `sent ${day(l.paid_at)}` : 'to be sent'}`)]);
}

async function pricesScreen(f: any) {
  const crops = await db.all<{ code: string; name: string }>(`SELECT DISTINCT c.code, c.name FROM commodities c WHERE c.code = ANY($1)
    OR c.code IN (SELECT commodity_code FROM receipts WHERE owner_farmer_id=$2) ORDER BY c.name`, f.commodities ?? [], f.id);
  if (!crops.length) return 'END No crops on your record yet. Ask your field partner.';
  const lines = [];
  for (const c of crops) {
    const p = await referencePrice(c.code, f.state_code);
    lines.push(p.kobo_per_kg ? `${c.name} ${fmtNGN(p.kobo_per_kg, { decimals: false })}/kg${p.scope === 'national' ? ' (Nigeria)' : ''}` : `${c.name} no price yet`);
  }
  return 'END ' + fit('Prices this fortnight:', lines, 'Guide only, not an offer.');
}

const TOPICS = ['receipt', 'loan', 'payment', 'pin', 'other'] as const;

/** One USSD step. Returns the text to send back. */
export async function ussd(i: { sessionId?: string; phoneNumber?: string; text?: string }) {
  const session = String(i.sessionId ?? '').slice(0, 80);
  const phone = normPhone(i.phoneNumber);
  const parts = String(i.text ?? '').split('*').filter((x, k, a) => !(k === 0 && x === '' && a.length === 1));
  const log = (screen: string, fid: string | null) => db.run('INSERT INTO ussd_log (session_id, phone_hash, farmer_id, screen) VALUES ($1,$2,$3,$4)', session || '-', hmac('ussd-phone:' + (phone ?? '')), fid, screen);

  const s = await getSettings();
  if (!s['ussd.enabled']) return 'END StorageX is not available on USSD right now. Please call Kitovu.';
  if (!phone) return 'END We could not read your number.';
  // Each screen is one request; 40 in 10 minutes is far more than a person pressing keys.
  if (!(await rateLimit(`ussd:${hmac(phone)}`, 40, 600))) return 'END Too many requests. Please wait a few minutes and dial again.';
  const fs = await db.all<any>(`SELECT id, code, full_name, state_code, commodities, ussd_pin_hash, ussd_failed, ussd_locked_until FROM farmers
    WHERE phone_e164=$1 AND phone_verified_at IS NOT NULL AND status='active' ORDER BY created_at`, phone);
  if (!fs.length) { await log('unknown', null); return 'END This number is not registered with StorageX. Ask your Kitovu field partner to add you.'; }

  // A shared family phone: choose whose record first.
  let f = fs[0];
  if (fs.length > 1) {
    if (!parts.length) { await log('choose', null); return 'CON Whose record?\n' + fs.slice(0, 5).map((x, k) => `${k + 1} ${first(x.full_name)} ${x.code}`).join('\n'); }
    f = fs[Number(parts.shift()) - 1];
    if (!f) return 'END Wrong choice. Please dial again.';
  }
  if (f.ussd_locked_until && new Date(f.ussd_locked_until) > new Date()) { await log('locked', f.id); return 'END Too many wrong PINs. Try again tomorrow, or ask Kitovu to reset your PIN.'; }

  // First time: choose a PIN.
  if (!f.ussd_pin_hash) {
    if (parts.length === 0) { await log('pin_new', f.id); return `CON Welcome to StorageX, ${first(f.full_name)}.\nChoose a 4-digit PIN. Keep it secret.`; }
    const [p1, p2] = parts;
    if (!/^\d{4}$/.test(p1)) return 'END A PIN is 4 digits. Please dial again.';
    if (weakPin(p1)) return 'END That PIN is too easy to guess. Please dial again and choose another.';
    if (parts.length === 1) return 'CON Enter the same PIN again:';
    if (p2 !== p1) return 'END The two PINs were different. Please dial again.';
    await db.run('UPDATE farmers SET ussd_pin_hash=$2, ussd_pin_set_at=now(), ussd_failed=0, ussd_locked_until=NULL WHERE id=$1 AND ussd_pin_hash IS NULL', f.id, hashPassword(pinKey(f.id, p1)));
    await log('pin_set', f.id);
    return 'END PIN saved. Dial again any time to check your produce, loans and payments.';
  }

  if (parts.length === 0) { await log('pin', f.id); return 'CON StorageX\nEnter your PIN:'; }
  const pin = parts.shift()!;
  if (!verifyPassword(pinKey(f.id, pin), f.ussd_pin_hash)) {
    const tries = f.ussd_failed + 1;
    await db.run(`UPDATE farmers SET ussd_failed=$2::smallint, ussd_locked_until=CASE WHEN $2::int >= $3::int THEN now() + make_interval(hours => $4::int) END WHERE id=$1`, f.id, tries, MAX_TRIES, LOCK_HOURS);
    await log('pin_wrong', f.id);
    return tries >= MAX_TRIES ? 'END Wrong PIN. USSD is locked for 24 hours. Kitovu can reset your PIN.' : `END Wrong PIN. ${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? 'try' : 'tries'} left.`;
  }
  if (f.ussd_failed) await db.run('UPDATE farmers SET ussd_failed=0 WHERE id=$1', f.id);

  const [choice, sub] = parts;
  if (choice === undefined) { await log('menu', f.id); return MENU; }
  const screen = ({ '1': 'produce', '2': 'loans', '3': 'sales', '4': 'prices', '5': 'callback' } as Record<string, string>)[choice];
  if (!screen) return 'END Wrong choice. Please dial again.';
  await log(screen, f.id);
  if (screen === 'produce') return receiptsScreen(f.id);
  if (screen === 'loans') return loansScreen(f.id);
  if (screen === 'sales') return salesScreen(f.id);
  if (screen === 'prices') return pricesScreen(f);
  if (sub === undefined) return 'CON Kitovu will call you about:\n1 A receipt\n2 A loan\n3 A payment\n4 My PIN\n5 Something else';
  const topic = TOPICS[Number(sub) - 1];
  if (!topic) return 'END Wrong choice. Please dial again.';
  await db.run('INSERT INTO farmer_callbacks (farmer_id, topic) VALUES ($1,$2) ON CONFLICT DO NOTHING', f.id, topic);
  return 'END Thank you. Kitovu will call you on this number within 2 working days.';
}

// ---------- Kitovu side ----------
function kitovuOps(a: Actor) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'farmers.edit')) throw new UserError('Only Kitovu operations staff can do this.');
}

/** Clear a farmer's PIN so they choose a new one; the farmer is told by text. */
export async function resetPin(a: Actor, farmerId: string, reason: string) {
  kitovuOps(a);
  if (String(reason ?? '').trim().length < 5) throw new UserError('Say how you confirmed it is the farmer asking (e.g. called back on their number).');
  const n = await db.run('UPDATE farmers SET ussd_pin_hash=NULL, ussd_pin_set_at=NULL, ussd_failed=0, ussd_locked_until=NULL WHERE id=$1 AND (ussd_pin_hash IS NOT NULL OR ussd_locked_until IS NOT NULL)', farmerId);
  if (!n) throw new UserError('This farmer has no PIN to reset.');
  await audit(actorOf(a), 'farmer.ussd_pin_reset', { entity: 'farmer', entityId: farmerId, data: { reason: String(reason).trim().slice(0, 200) } });
  const s = await getSettings();
  await notifyFarmer(farmerId, 'ussd_pin_reset', `pin:${Date.now()}`, { ussd: s['ussd.code'] || 'the StorageX code' });
}

export const openCallbacks = () => db.all<any>(`SELECT cb.*, f.code, f.full_name, f.phone_e164 FROM farmer_callbacks cb JOIN farmers f ON f.id=cb.farmer_id
  WHERE cb.handled_at IS NULL ORDER BY cb.created_at`);

export async function handleCallback(a: Actor, id: string, note: string) {
  kitovuOps(a);
  if (String(note ?? '').trim().length < 5) throw new UserError('Note what was done.');
  const n = await db.run('UPDATE farmer_callbacks SET handled_by=$2, handled_at=now(), note=$3 WHERE id=$1 AND handled_at IS NULL', id, a.user.id, String(note).trim().slice(0, 300));
  if (!n) throw new UserError('Already handled.');
  await audit(actorOf(a), 'farmer.callback_handled', { entity: 'farmer_callback', entityId: id });
}

export async function ussdStatus(farmerId: string) {
  return db.get<any>(`SELECT ussd_pin_set_at, ussd_failed, ussd_locked_until, language, sms_reminders,
    (SELECT max(created_at) FROM ussd_log WHERE farmer_id=$1 AND screen IN ('menu','produce','loans','sales','prices','callback')) AS last_used FROM farmers WHERE id=$1`, farmerId);
}
