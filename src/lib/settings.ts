// Settings kept in the database so Kitovu administrators can change them without a deploy. Every change is audited.
import { db } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';

export const DEFAULTS = {
  /** Must the farmer's phone (or, without one, their presence) be confirmed before an identity check? */
  'phone_check.required': true,
  'phone_check.sms': true,        // code by text message
  'phone_check.voice': true,      // code read out by an automated call
  'phone_check.attested': true,   // no phone or no signal: field partner + a named local witness vouch in person
  /** AI pre-check of identity photos for the reviewer: 'assist' or 'off'. The server file can also force it off. */
  'kyc.ai_mode': 'assist' as 'assist' | 'off',
  /** AI reads the scale and moisture-meter photos of each delivery and compares them with the typed numbers. */
  'intake.ai_check': 'assist' as 'assist' | 'off',
  /** AI writes a short note on each loan request for the lender's credit officer, from the automatic checks. */
  'loans.ai_note': 'assist' as 'assist' | 'off',
  /** Counts may fall short of what receipts claim by this much before it is a serious flag. */
  'stock.tolerance_pct': 1,
  /** Every stack holding stock should be counted at least this often. */
  'stock.count_every_days': 30,
  /** Reference price = median of approved prices from the last N days (state first, then national). */
  'price.window_days': 14,
  'price.min_observations': 2,
  /** A price this far from the reference needs a written explanation when entered. */
  'price.outlier_pct': 25,
  /** A fall in a receipt's price of this much since the last valuation is flagged. */
  'price.drop_alert_pct': 10,
  /** Kitovu's charges taken from sale proceeds before the lender and the farmer (kobo; basis points). */
  'fees.storage_kobo_per_kg_month': 300,
  'fees.handling_kobo_per_kg': 100,
  'fees.sale_commission_bp': 150,
  /** Due-date reminders to farmers: this many days before, on the day after it is missed. Event texts always go. */
  'notify.reminders': true,
  'notify.due_days': 7,
  /** USSD status menu for farmers. The code is the one the network assigns, e.g. *347*123#. */
  'ussd.enabled': true,
  'ussd.code': '',
};
export type SettingKey = keyof typeof DEFAULTS;
export type Settings = typeof DEFAULTS;

export const LABELS: Record<SettingKey, string> = {
  'phone_check.required': 'Require a phone check (or witnessed attestation) before an ID check',
  'phone_check.sms': 'Allow codes by text message',
  'phone_check.voice': 'Allow codes by voice call',
  'phone_check.attested': 'Allow witnessed attestation for farmers without a working phone',
  'kyc.ai_mode': 'AI pre-check of ID photos for the reviewer',
  'intake.ai_check': 'AI reads scale and moisture-meter photos and compares them with the typed numbers',
  'loans.ai_note': 'AI writes a note on each loan request for the credit officer',
  'stock.tolerance_pct': 'Allowed shortfall of counted stock against receipts (%)',
  'stock.count_every_days': 'Count every stack at least every (days)',
  'price.window_days': 'Use prices from the last (days)',
  'price.min_observations': 'Prices needed before a value is given',
  'price.outlier_pct': 'Price needs an explanation if it differs from the reference by more than (%)',
  'price.drop_alert_pct': 'Flag a price fall since the last valuation of more than (%)',
  'fees.storage_kobo_per_kg_month': 'Storage fee (kobo per kg per month)',
  'fees.handling_kobo_per_kg': 'Handling fee (kobo per kg, in and out)',
  'fees.sale_commission_bp': 'Sale commission (basis points: 150 = 1.5%)',
  'notify.reminders': 'Text farmers before a loan is due and when it is missed',
  'notify.due_days': 'Send the due-date reminder this many days before',
  'ussd.enabled': 'Farmers can check their status by USSD',
  'ussd.code': 'USSD code shown in texts (blank until the network assigns one)',
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.all<{ key: SettingKey; value: any }>('SELECT key, value FROM settings');
  const out: any = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && typeof r.value === typeof (DEFAULTS as any)[r.key]) out[r.key] = r.value;
  return out;
}

export async function saveSettings(a: Actor, input: Partial<Record<SettingKey, unknown>>) {
  if (!can(a.membership, 'settings.manage')) throw new UserError('Only Kitovu super admins change platform settings.');
  const cur = await getSettings();
  const next: any = { ...cur };
  for (const k of Object.keys(DEFAULTS) as SettingKey[]) {
    if (!(k in input)) continue;
    const def = DEFAULTS[k];
    if (typeof def === 'boolean') next[k] = input[k] === true || input[k] === '1' || input[k] === 'on';
    else if (k === 'kyc.ai_mode' || k === 'intake.ai_check' || k === 'loans.ai_note') next[k] = input[k] === 'off' ? 'off' : 'assist';
    else if (typeof def === 'string') {
      const v = String(input[k] ?? '').replace(/\s+/g, '');
      if (k === 'ussd.code' && v && !/^\*\d{2,4}(\*\d{1,5})*#$/.test(v)) throw new UserError('USSD code: like *347*123#, or blank.');
      next[k] = v;
    }
    else if (typeof def === 'number') {
      const v = Number(input[k]);
      const [lo, hi] = ({ 'stock.tolerance_pct': [0, 5], 'price.min_observations': [1, 20], 'price.outlier_pct': [5, 100], 'price.drop_alert_pct': [1, 50], 'fees.storage_kobo_per_kg_month': [0, 5000], 'fees.handling_kobo_per_kg': [0, 5000], 'fees.sale_commission_bp': [0, 1000], 'notify.due_days': [1, 30] } as Record<string, number[]>)[k] ?? [1, 180];
      if (!Number.isFinite(v) || v < lo || v > hi) throw new UserError(`${LABELS[k]}: between ${lo} and ${hi}.`);
      next[k] = v;
    }
  }
  if (next['phone_check.required'] && !next['phone_check.sms'] && !next['phone_check.voice'] && !next['phone_check.attested'])
    throw new UserError('A phone check is required, so at least one way to do it must stay on.');
  const changed = (Object.keys(next) as SettingKey[]).filter((k) => next[k] !== (cur as any)[k]);
  for (const k of changed) {
    await db.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      k, JSON.stringify(next[k]), a.user.id);
  }
  if (changed.length) await audit(actorOf(a), 'settings.changed', { data: Object.fromEntries(changed.map((k) => [k, [(cur as any)[k], next[k]]])) });
  return changed.length;
}
