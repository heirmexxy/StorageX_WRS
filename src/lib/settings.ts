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
  /** Platform fees Kitovu charges partners (0 = not charged). */
  'fees.issuance_bp': 0,
  'fees.origination_bp': 0,
  'fees.certification_kobo': 0,
  /** Issuers must hold a guarantee of at least this share of the value of their live receipts, and this minimum. */
  'issuers.guarantee_pct': 5,
  'issuers.guarantee_min_kobo': 50000000,
  /** Issuers may issue only where WareGuard is installed and reporting (Kitovu can waive it per issuer for a pilot). */
  'issuers.require_wareguard': true,
  /** Due-date reminders to farmers: this many days before, on the day after it is missed. Event texts always go. */
  /** All texts to farmers. Turn off until SMS is connected, so nothing is attempted or logged as failed. */
  'notify.sms': true,
  'notify.reminders': true,
  'notify.due_days': 7,
  /** The intake inspector asks for a check when one farmer delivers more than this in 30 days. */
  'inspector.farmer_30d_kg': 30000,
  /** USSD status menu for farmers. The code is the one the network assigns, e.g. *347*123#. */
  'ussd.enabled': true,
  'ussd.code': '',
  /** Warn a lender when a loan comes within this many points of its margin-call level. */
  'alerts.ltv_warning_gap_pct': 10,
  /** Also text alerts to lender and Kitovu staff who have a phone number on their account. */
  'alerts.sms': false,
  /** WareGuard limits: above these, the warehouse and the lenders with stock there are alerted. */
  'wareguard.max_temp_c': 30,
  'wareguard.max_rh_pct': 70,
  'wareguard.door_open_minutes': 30,
  'wareguard.offline_minutes': 60,
  /** Storage term on a new receipt (months, 1 to 6) unless the issuer chooses another; capped by the crop's limit. */
  'receipts.default_storage_months': 6,
  /** Warn the farmer, the lender and Kitovu this many days before a receipt's storage term ends. */
  'receipts.term_warn_days': 14,
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
  'fees.issuance_bp': 'Issuance fee charged to receipt issuers (basis points of the value at storage)',
  'fees.origination_bp': 'Origination fee charged to lenders (basis points of each loan paid out)',
  'fees.certification_kobo': 'Certification fee charged to a receipt issuer when certified (kobo)',
  'issuers.guarantee_pct': 'Issuer guarantee: at least this % of the value of its live receipts',
  'issuers.guarantee_min_kobo': 'Issuer guarantee: at least this amount (kobo)',
  'issuers.require_wareguard': 'Issuers may issue only where WareGuard is installed and reporting',
  'notify.sms': 'Send texts to farmers (deliveries, receipts, loans, releases, payments)',
  'notify.reminders': 'Text farmers before a loan is due and when it is missed',
  'notify.due_days': 'Send the due-date reminder this many days before',
  'inspector.farmer_30d_kg': 'Flag a farmer who delivers more than this in 30 days (kg)',
  'ussd.enabled': 'Farmers can check their status by USSD',
  'ussd.code': 'USSD code shown in texts (blank until the network assigns one)',
  'alerts.ltv_warning_gap_pct': 'Warn lenders when a loan is within this many points of its margin-call level',
  'alerts.sms': 'Also text alerts to lender and Kitovu staff with a phone number on their account',
  'wareguard.max_temp_c': 'WareGuard: alert above this temperature (°C)',
  'wareguard.max_rh_pct': 'WareGuard: alert above this relative humidity (%)',
  'wareguard.door_open_minutes': 'WareGuard: alert when a door stays open longer than (minutes)',
  'wareguard.offline_minutes': 'WareGuard: alert when a device has sent nothing for (minutes)',
  'receipts.default_storage_months': 'Storage term on a new receipt (months, 1 to 6)',
  'receipts.term_warn_days': 'Warn before a receipt’s storage term ends (days)',
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
      const [lo, hi] = ({ 'stock.tolerance_pct': [0, 5], 'price.min_observations': [1, 20], 'price.outlier_pct': [5, 100], 'price.drop_alert_pct': [1, 50], 'fees.storage_kobo_per_kg_month': [0, 5000], 'fees.handling_kobo_per_kg': [0, 5000], 'fees.sale_commission_bp': [0, 1000], 'fees.issuance_bp': [0, 500], 'fees.origination_bp': [0, 500], 'fees.certification_kobo': [0, 1e11], 'issuers.guarantee_pct': [0, 50], 'issuers.guarantee_min_kobo': [0, 1e12], 'notify.due_days': [1, 30], 'inspector.farmer_30d_kg': [1000, 1000000], 'alerts.ltv_warning_gap_pct': [1, 30], 'wareguard.max_temp_c': [15, 45], 'wareguard.max_rh_pct': [40, 95], 'wareguard.door_open_minutes': [5, 240], 'wareguard.offline_minutes': [10, 1440], 'receipts.default_storage_months': [1, 6], 'receipts.term_warn_days': [1, 60] } as Record<string, number[]>)[k] ?? [1, 180];
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
