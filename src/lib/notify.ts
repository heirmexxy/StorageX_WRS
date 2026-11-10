// Every text to a farmer goes through here: approved wording in the farmer's language (English when there is no
// approved translation), sent once per event, and logged whether it went or not.
import { db } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { sendSms } from './sms';
import { getSettings } from './settings';
import { fmtNGN } from './money';
import { position, entriesOf } from './finance';

export const LANGUAGES: Record<string, string> = { en: 'English', pcm: 'Pidgin', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo' };

/** Each message, the words it may use, and the English wording StorageX ships with. */
export const EVENTS: Record<string, { label: string; vars: string[]; en: string; reminder?: boolean }> = {
  intake_recorded: { label: 'Delivery recorded at the gate', vars: ['warehouse', 'kg', 'crop', 'ref'],
    en: 'StorageX: {warehouse} recorded {kg} kg {crop} from you (ref {ref}). If this is wrong, call Kitovu.' },
  receipt_issued: { label: 'Receipt issued', vars: ['receipts', 'crop', 'warehouse', 'link'],
    en: 'StorageX: receipt {receipts} issued for your {crop} at {warehouse}. Check any time: {link}' },
  release: { label: 'Stock collected, some still held', vars: ['kg', 'crop', 'warehouse', 'receipt', 'ref', 'collector', 'left'],
    en: 'StorageX: {kg} kg {crop} released from {warehouse} on receipt {receipt} ({ref}), collected by {collector}. Still held: {left} kg. If this is wrong, call Kitovu now.' },
  release_closed: { label: 'Stock collected, receipt closed', vars: ['kg', 'crop', 'warehouse', 'receipt', 'ref', 'collector'],
    en: 'StorageX: {kg} kg {crop} released from {warehouse} on receipt {receipt} ({ref}), collected by {collector}. The receipt is now closed. If this is wrong, call Kitovu now.' },
  loan_disbursed: { label: 'Loan paid out', vars: ['lender', 'loan', 'amount', 'due'],
    en: 'StorageX: {lender} has sent your loan {loan} of {amount} against your stored produce. Due {due}. Your receipts stay pledged until it is repaid.' },
  loan_repayment: { label: 'Repayment received, loan still open', vars: ['lender', 'loan', 'amount', 'owed'],
    en: 'StorageX: {lender} received {amount} on loan {loan}. You still owe {owed}.' },
  loan_closed: { label: 'Loan fully repaid', vars: ['lender', 'loan', 'amount'],
    en: 'StorageX: {lender} received {amount}. Loan {loan} is fully repaid and your receipts are free again.' },
  loan_due_soon: { label: 'Reminder: loan due soon', vars: ['lender', 'loan', 'due', 'owed'], reminder: true,
    en: 'StorageX: loan {loan} with {lender} is due on {due}. You owe {owed}. Repay through {lender}, or ask Kitovu about selling your stored produce.' },
  loan_overdue: { label: 'Reminder: loan overdue', vars: ['lender', 'loan', 'due', 'owed'], reminder: true,
    en: 'StorageX: loan {loan} with {lender} was due on {due} and is not fully repaid. You owe {owed}. Please talk to {lender} or Kitovu.' },
  sale_paid: { label: 'Sale money sent to the farmer', vars: ['amount', 'sale', 'ref'],
    en: 'StorageX: {amount} from sale {sale} has been sent to you (ref {ref}). Your statement is available from your Kitovu field partner.' },
  ussd_pin_reset: { label: 'USSD PIN reset by Kitovu', vars: ['ussd'],
    en: 'StorageX: your PIN was reset by Kitovu. Dial {ussd} to choose a new one. If you did not ask for this, call Kitovu.' },
};

const PLACEHOLDER = /\{([a-z_]+)\}/g;
export function render(body: string, vars: Record<string, string | number>) {
  return body.replace(PLACEHOLDER, (_m, k) => String(vars[k] ?? '')).replace(/\s+/g, ' ').trim();
}
/** SMS parts for the length warning on the editor (GSM-7 160/153; anything else counts as Unicode 70/67). */
export function smsParts(text: string) {
  const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅå_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r{}[\]~|^\\€]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}

async function wording(event: string, language: string) {
  const rows = await db.all<{ language: string; body: string }>(`SELECT language, body FROM message_templates WHERE event=$1 AND status='live' AND language = ANY($2)`, event, [language, 'en']);
  return rows.find((r) => r.language === language) ?? rows.find((r) => r.language === 'en') ?? { language: 'en', body: EVENTS[event].en };
}

/** Send one message to a farmer. Never throws: a failed text is logged and the work carries on. */
export async function notifyFarmer(farmerId: string, event: keyof typeof EVENTS & string, ref: string, vars: Record<string, string | number>) {
  try {
    const f = await db.get<any>('SELECT id, phone_e164, phone_verified_at, language, sms_reminders, status FROM farmers WHERE id=$1', farmerId);
    if (!f) return { status: 'skipped' as const };
    if (await db.val(`SELECT 1 FROM farmer_messages WHERE farmer_id=$1 AND event=$2 AND ref=$3 AND status='sent'`, farmerId, event, ref)) return { status: 'duplicate' as const };
    const w = await wording(event, f.language);
    const body = render(w.body, vars);
    let status: 'sent' | 'failed' | 'skipped' = 'sent', error: string | null = null;
    if (!f.phone_e164) { status = 'skipped'; error = 'no phone number'; }
    else if (!f.phone_verified_at) { status = 'skipped'; error = 'phone not confirmed'; }
    else if (EVENTS[event].reminder && !f.sms_reminders) { status = 'skipped'; error = 'reminders off for this farmer'; }
    else { const r = await sendSms(f.phone_e164, body); if (!r.ok) { status = 'failed'; error = r.error ?? 'not sent'; } }
    await db.run(`INSERT INTO farmer_messages (farmer_id, event, ref, language, body, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, farmerId, event, ref, w.language, body, status, error);
    return { status, body };
  } catch (e) {
    console.error('[notify]', event, ref, e);
    return { status: 'failed' as const };
  }
}

export async function messagesOf(farmerId: string, limit = 30) {
  return db.all<any>('SELECT event, ref, language, body, status, error, created_at FROM farmer_messages WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT $2', farmerId, limit);
}

// ---------- reminders (daily job) ----------
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const dayText = (s: string) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Texts farmers whose loans fall due in N days, or were missed yesterday. Safe to run more than once a day. */
export async function sendReminders(today = new Date()) {
  const s = await getSettings();
  if (!s['notify.reminders']) return { soon: 0, overdue: 0 };
  const t = ymd(today);
  const loans = await db.all<any>(`SELECT ln.*, o.name AS lender, to_char(ln.due_on,'YYYY-MM-DD') AS due FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id
    WHERE ln.status='disbursed' AND (ln.due_on = $1::date + $2::int OR ln.due_on = $1::date - 1)`, t, s['notify.due_days']);
  let soon = 0, overdue = 0;
  for (const ln of loans) {
    const pos = position(ln, await entriesOf(ln.id), today);
    if (pos.outstanding <= 0) continue;
    const late = ln.due < t;
    const r = await notifyFarmer(ln.farmer_id, late ? 'loan_overdue' : 'loan_due_soon', `${ln.loan_no}:${late ? 'late' : 'soon'}`,
      { lender: ln.lender, loan: ln.loan_no, due: dayText(ln.due), owed: fmtNGN(pos.outstanding, { decimals: false }) });
    if (r.status === 'sent') late ? overdue++ : soon++;
  }
  return { soon, overdue };
}

// ---------- wording and translations (maker-checker) ----------
function canEdit(a: Actor) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'farmers.edit')) throw new UserError('Only Kitovu operations staff change farmer messages.');
}
export async function templateTable() {
  const rows = await db.all<any>(`SELECT t.*, u.full_name AS proposer FROM message_templates t LEFT JOIN users u ON u.id=t.proposed_by WHERE t.status IN ('live','draft') ORDER BY t.event, t.language`);
  return Object.entries(EVENTS).map(([event, e]) => ({
    event, label: e.label, vars: e.vars,
    langs: Object.keys(LANGUAGES).map((language) => ({
      language,
      live: rows.find((r) => r.event === event && r.language === language && r.status === 'live') ?? (language === 'en' ? { body: e.en, shipped: true } : null),
      draft: rows.find((r) => r.event === event && r.language === language && r.status === 'draft') ?? null,
    })),
  }));
}

export async function proposeTemplate(a: Actor, event: string, language: string, bodyRaw: string) {
  canEdit(a);
  const e = EVENTS[event];
  if (!e || !LANGUAGES[language]) throw new UserError('Unknown message or language.');
  const body = String(bodyRaw ?? '').replace(/\s+/g, ' ').trim();
  if (body.length < 10 || body.length > 459) throw new UserError('Between 10 and 459 characters (three texts at most).');
  const used = [...body.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const bad = used.filter((v) => !e.vars.includes(v));
  if (bad.length) throw new UserError(`This message cannot use {${bad.join('}, {')}}. It can use {${e.vars.join('}, {')}}.`);
  const must = (e.en.match(PLACEHOLDER) ?? []).map((m) => m.slice(1, -1)).filter((v) => ['amount', 'owed', 'kg', 'loan', 'receipt', 'receipts', 'ref', 'due'].includes(v));
  const missing = must.filter((v) => !used.includes(v));
  if (missing.length) throw new UserError(`Keep {${missing.join('}, {')}}: the farmer needs it to check the message.`);
  if (!/StorageX/.test(body)) throw new UserError('Start or include “StorageX” so farmers know who the text is from.');
  await db.run(`DELETE FROM message_templates WHERE event=$1 AND language=$2 AND status='draft'`, event, language);
  const id = await db.val<string>(`INSERT INTO message_templates (event, language, body, proposed_by) VALUES ($1,$2,$3,$4) RETURNING id`, event, language, body, a.user.id);
  await audit(actorOf(a), 'message.template_proposed', { entity: 'message_template', entityId: id!, data: { event, language } });
  return id!;
}

export async function decideTemplate(a: Actor, id: string, approve: boolean) {
  canEdit(a);
  const t = await db.get<any>(`SELECT * FROM message_templates WHERE id=$1 AND status='draft'`, id);
  if (!t) throw new UserError('That draft has already been decided.');
  if (t.proposed_by === a.user.id) throw new UserError('Someone else must check wording you wrote.');
  if (approve) await db.run(`UPDATE message_templates SET status='retired' WHERE event=$1 AND language=$2 AND status='live'`, t.event, t.language);
  await db.run(`UPDATE message_templates SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, id, approve ? 'live' : 'rejected', a.user.id);
  await audit(actorOf(a), approve ? 'message.template_approved' : 'message.template_rejected', { entity: 'message_template', entityId: id, data: { event: t.event, language: t.language } });
}

/** Farmer's language and reminder choice, set by the field team when the farmer asks. */
export async function setFarmerMessaging(a: Actor, farmerId: string, i: { language?: string; reminders?: string }) {
  if (!can(a.membership, 'farmers.edit')) throw new UserError('You cannot change this farmer’s messages.');
  const language = LANGUAGES[String(i.language)] ? String(i.language) : 'en';
  const reminders = i.reminders === '1' || i.reminders === 'on';
  await db.run('UPDATE farmers SET language=$2, sms_reminders=$3, updated_at=now() WHERE id=$1', farmerId, language, reminders);
  await audit(actorOf(a), 'farmer.messaging_set', { entity: 'farmer', entityId: farmerId, data: { language, reminders } });
}
