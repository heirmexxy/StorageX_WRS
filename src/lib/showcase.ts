// The receipts shown on the public website. They are laid out exactly as issued receipts are, and their QR codes
// open a check page like a live receipt's. That check page is the one place that states plainly that no produce is
// held against them: a check page must never report stock that does not exist.
import { config } from './config';
import type { ReceiptDoc } from './receipt-doc';

const base = () => config.baseUrl.replace(/\/$/, '');

interface Showcase extends Omit<ReceiptDoc, 'url'> { events: { label: string; at: string }[]; note: string; today_per_kg: number }

const LIST: Showcase[] = [
  {
    receipt_no: 'SX-OY-ISY-261104-0018', status: 'pledged', status_label: 'Valid — pledged to a lender',
    commodity: 'Maize (white)', grade: 'A', net_kg: 2450, bags: 49, moisture: 12.8,
    warehouse: 'Iseyin Grain Store', wh_code: 'ISY', wh_state: 'Oyo', wh_tier: 'A', insured: true,
    depositor: 'Funmilayo Adeyemi', depositor_code: 'SXF-104233', issued_at: '2026-11-04T09:42:00Z', intake_ref: 'IN-ISY-261104-031',
    issued_by: 'Bisola Lawal', received_by: 'Kehinde Ojo',
    value: { kobo_per_kg: 58000, kobo: 142100000, basis: 'Oyo State reference price, the median of 6 approved market prices, 22 Oct to 4 Nov 2026' },
    insurance: { insurer: 'Stock cover for fire, flood and theft', policy_no: 'SXW-ISY-2026-07', cover_to: '2027-06-30T12:00:00Z' },
    events: [{ label: 'Issued', at: '2026-11-04T09:42:00Z' }, { label: 'Pledged to a lender', at: '2026-11-06T08:15:00Z' }, { label: 'Loan paid out', at: '2026-11-06T13:30:00Z' }],
    note: 'The receipt backs a loan and cannot be pledged again. The produce can leave only through a sale the lender approves, or after the loan is repaid; the lender is paid first.',
    today_per_kg: 61000,
  },
  {
    receipt_no: 'SX-NA-AWE-261029-0004', status: 'issued', status_label: 'Valid',
    commodity: 'Soybean', grade: 'A', net_kg: 3000, bags: 60, moisture: 10.9,
    warehouse: 'Awe Produce Store', wh_code: 'AWE', wh_state: 'Nasarawa', wh_tier: 'B', insured: true,
    depositor: 'Musa Danjuma', depositor_code: 'SXF-208117', issued_at: '2026-10-29T11:05:00Z', intake_ref: 'IN-AWE-261029-012',
    issued_by: 'Grace Okon', received_by: 'Ibrahim Sule',
    value: { kobo_per_kg: 72000, kobo: 216000000, basis: 'Nasarawa State reference price, the median of 4 approved market prices, 16 to 29 Oct 2026' },
    insurance: { insurer: 'Stock cover for fire, flood and theft', policy_no: 'SXW-AWE-2026-03', cover_to: '2027-03-31T12:00:00Z' },
    events: [{ label: 'Issued', at: '2026-10-29T11:05:00Z' }],
    note: 'The produce is in the warehouse and the receipt is not pledged or sold.',
    today_per_kg: 73500,
  },
  {
    receipt_no: 'SX-NI-MNA-261112-0011', status: 'financed', status_label: 'Valid — financed',
    commodity: 'Paddy rice', grade: 'B', net_kg: 4975.5, bags: 100, moisture: 13.6,
    warehouse: 'Minna Central Warehouse', wh_code: 'MNA', wh_state: 'Niger', wh_tier: 'A', insured: true,
    depositor: 'Hauwa Abdullahi', depositor_code: 'SXF-301452', issued_at: '2026-11-12T14:20:00Z', intake_ref: 'IN-MNA-261112-044',
    issued_by: 'Bisola Lawal', received_by: 'Yakubu Garba',
    value: { kobo_per_kg: 64000, kobo: 318432000, basis: 'Niger State reference price, the median of 5 approved market prices, 30 Oct to 12 Nov 2026' },
    insurance: { insurer: 'Stock cover for fire, flood and theft', policy_no: 'SXW-MNA-2026-11', cover_to: '2027-09-30T12:00:00Z' },
    events: [{ label: 'Issued', at: '2026-11-12T14:20:00Z' }, { label: 'Pledged to a lender', at: '2026-11-13T09:00:00Z' }, { label: 'Loan paid out', at: '2026-11-13T15:45:00Z' }],
    note: 'The receipt backs a loan and cannot be pledged again. The produce can leave only through a sale the lender approves, or after the loan is repaid; the lender is paid first.',
    today_per_kg: 65500,
  },
];

export const CHECK_NOTICE = 'StorageX demonstration receipt. It shows how a live receipt reads; no produce is held against it, so it cannot be pledged, sold or released.';

export const showcaseList = () => LIST.map((r) => r.receipt_no);
export function showcaseDoc(no: string): ReceiptDoc | null {
  const r = LIST.find((x) => x.receipt_no === String(no).toUpperCase());
  return r ? { ...r, today_per_kg: undefined, url: `${base()}/check-receipt/${r.receipt_no}`, key_id: null, signature: null } : null;
}
/** The data the public check page (PassportPage) shows for a showcase receipt. */
export function showcasePassport(no: string) {
  const r = LIST.find((x) => x.receipt_no === String(no).toUpperCase());
  if (!r) return null;
  const initials = r.depositor.split(/\s+/).map((w) => w[0] + '.').join(' ');
  return {
    receipt_no: r.receipt_no, view: { label: r.status_label, tone: r.status === 'issued' ? 'ok' : 'warn', note: r.note },
    commodity: r.commodity, grade: r.grade, moisture: String(r.moisture), bags: r.bags, net_kg: r.net_kg, held_kg: r.net_kg,
    warehouse: `${r.warehouse}, ${r.wh_state} State`, tier: r.wh_tier, insured: r.insured, owner: `${initials} (${r.depositor_code})`, lot: null,
    issued_at: new Date(r.issued_at), checked_at: new Date(), events: r.events.map((e) => ({ label: e.label, at: new Date(e.at) })),
    chain_ok: true, signature_ok: false, legacy: false, qr_sig: 'none', key_id: null, showcase: true,
    value_at_storage: r.value ? { kobo: r.value.kobo, per_kg: r.value.kobo_per_kg } : null,
    value_today: { kobo: Math.round(r.net_kg * r.today_per_kg), per_kg: r.today_per_kg, on: new Date() },
    insurance: r.insurance ? `${r.insurance.insurer}, policy ${r.insurance.policy_no}` : null,
  };
}
