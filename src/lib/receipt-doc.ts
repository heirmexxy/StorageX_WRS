// The warehouse receipt as a document: the same facts, wording and layout for the printed PDF and the web view.
import { Pdf } from './pdf';

export interface ReceiptDoc {
  receipt_no: string;
  status: string;                 // receipt status code (issued, pledged, …)
  status_label: string;           // as shown to the public
  commodity: string; grade?: string | null;
  net_kg: number; bags?: number | null; moisture?: number | null;
  warehouse: string; wh_code: string; wh_state: string; wh_tier: string; insured: boolean;
  depositor: string; depositor_code: string;
  issued_at: Date | string; intake_ref?: string | null; lot?: string | null;
  issued_by?: string | null; received_by?: string | null;
  url: string; key_id?: string | null; signature?: string | null;
  /** Value at storage: the reference price on the day of issue, fixed on the receipt. */
  value?: { kobo_per_kg: number; kobo: number; basis: string } | null;
  /** The policy that covered the warehouse when the receipt was issued. */
  insurance?: { insurer: string; policy_no?: string | null; cover_to?: Date | string | null } | null;
}

export const COMPANY = 'Kitovu Technology Company Limited, RC 1348965, Kitovu Business Hub, Iseyin-Saki Expressway, Iseyin, Oyo State';

/** The terms printed on every receipt. They describe how StorageX actually works; change them only with the code. */
export const TERMS = [
  'This paper is a copy of an electronic record held by StorageX. The record at the address in the QR code is the authority: check it before you lend, buy or release against this receipt.',
  'The warehouse operator holds the produce described here for the depositor and releases it only against a StorageX release order. Every release is weighed and recorded against this receipt.',
  'Weight is net of bag tare. Grade and moisture are as tested and recorded at intake.',
  'A receipt can back one loan at a time. While it is pledged, the produce leaves the warehouse only through a sale the lender approves, or after the loan is repaid. Sale proceeds pay storage and handling fees first, then the lender, then the depositor.',
  'Storage and handling fees accrue at the published rates and are settled from a sale or before release.',
  'Altering this paper does not change the record. A paper that does not match its live record is not a valid receipt.',
];

export const kgText = (n: number) => `${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
const naira = (kobo: number) => `NGN ${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dayText = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' });
/** "Value at storage" lines, shared by the PDF and the web view. */
export function valueLines(d: ReceiptDoc) {
  if (!d.value) return { amount: 'Not valued', detail: 'No market price had been approved for this crop when the receipt was issued. The live record shows today’s value once one is.' };
  return { amount: naira(d.value.kobo), detail: `${naira(d.value.kobo_per_kg)} per kg on the day of issue: ${d.value.basis}. Today’s value is on the live record.` };
}
/** The value block from a receipt row's stored issue price. */
export function valueFromRow(r: { issue_kobo_per_kg: number | null; issue_value_kobo: number | null; issue_price: any; wh_state?: string }) {
  if (!r.issue_kobo_per_kg || r.issue_value_kobo == null) return null;
  const b = r.issue_price ?? {};
  const range = b.from && b.to ? `, ${dayText(b.from + 'T12:00:00Z').replace(/ \d{4}$/, '')} to ${dayText(b.to + 'T12:00:00Z')}` : '';
  const where = b.scope === 'state' ? `${r.wh_state ?? 'State'} State reference price` : 'national reference price';
  return { kobo_per_kg: r.issue_kobo_per_kg, kobo: r.issue_value_kobo, basis: `${where}, the median of ${b.observations ?? 'several'} approved market prices${range}` };
}
export function insuranceText(d: ReceiptDoc) {
  if (d.insurance) return `${d.insurance.insurer}${d.insurance.policy_no ? `, policy ${d.insurance.policy_no}` : ''}${d.insurance.cover_to ? `, cover to ${dayText(d.insurance.cover_to)}` : ''}`;
  return d.insured ? 'Current policy on record' : 'No current policy on record';
}
export const whenText = (d: Date | string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WAT';

/** Label and value pairs in reading order, shared by the PDF and the web view. */
export function facts(d: ReceiptDoc): [string, string][] {
  return [
    ['Depositor and owner', `${d.depositor} (${d.depositor_code})`],
    ['Warehouse', `${d.warehouse} (${d.wh_code})`],
    ['Commodity', `${d.commodity}${d.grade ? `, grade ${d.grade}` : ''}`],
    ['Location', `${d.wh_state} State, warehouse tier ${d.wh_tier}`],
    ['Net weight', kgText(d.net_kg)],
    ['Insurance', insuranceText(d)],
    ['Bags', d.bags ? `${d.bags} bags` : '—'],
    ['Issued', whenText(d.issued_at)],
    ['Moisture at intake', d.moisture != null ? `${d.moisture}%` : '—'],
    ['From delivery', `${d.intake_ref ?? '—'}${d.lot ? `, ${d.lot}` : ''}`],
  ];
}

export function receiptPdfBuffer(d: ReceiptDoc) {
  const p = new Pdf(), L = 48, R = p.w - 48;
  const DEEP = '#154D32', MAIZE = '#E8B21E', INK = '#17211B', SOFT = '#5B665F', RULE = 0.86;

  // Header band with the mark and the document title
  p.shape([[0, 0], [p.w, 0], [p.w, 88], [0, 88]], { fill: DEEP });
  p.shape([[0, 88], [p.w, 88], [p.w, 92], [0, 92]], { fill: MAIZE });
  p.mark(L, 21, 46, { tile: '#1F6B45' });
  p.ctext(L + 58, 45, 'StorageX', '#FFFFFF', { size: 22, bold: true });
  p.ctext(L + 59, 61, 'by Kitovu', '#CFE0D5', { size: 9 });
  const title = 'Electronic warehouse receipt';
  p.ctext(R - p.width(title, 14, true), 44, title, '#FFFFFF', { size: 14, bold: true });
  const sub = 'Printed copy of the live record';
  p.ctext(R - p.width(sub, 9), 60, sub, '#CFE0D5', { size: 9 });

  // Receipt number and status
  p.ctext(L, 124, 'Receipt number', SOFT, { size: 9 });
  p.ctext(L, 150, d.receipt_no, INK, { size: 22, bold: true });
  const st = `Status when printed: ${d.status_label}`;
  p.ctext(L, 170, st, d.status === 'issued' ? '#1F6B45' : INK, { size: 10, bold: true });

  // QR panel
  const qx = R - 128, qy = 108;
  p.box(qx - 10, qy - 10, 148, 196, { stroke: 0.8, width: 0.8 });
  p.qr(qx, qy, 128, d.url);
  p.wrap(qx, qy + 146, 'Scan to check the live record before you rely on this paper.', 128, { size: 8, gray: 0.3, lead: 10 });

  // Facts in two columns
  const f = facts(d); let y = 214; const colW = (qx - 20 - L) / 2;
  for (let i = 0; i < f.length; i += 2) {
    let rowEnd = y;
    for (let j = 0; j < 2 && i + j < f.length; j++) {
      const [k, v] = f[i + j], x = j ? L + colW + 8 : L;
      p.ctext(x, y, k, SOFT, { size: 8.5 });
      rowEnd = Math.max(rowEnd, p.wrap(x, y + 15, v, colW - 12, { size: 11, bold: k === 'Net weight', lead: 13 }));
    }
    y = rowEnd + 6; p.line(L, y - 4, qx - 20, y - 4, { gray: RULE }); y += 10;
  }

  // Value at storage: the baseline a lender lends against
  y += 4;
  const v = valueLines(d), vh = 54;
  p.shape([[L, y], [R, y], [R, y + vh], [L, y + vh]], { fill: '#EEF5F0' });
  p.shape([[L, y], [L + 4, y], [L + 4, y + vh], [L, y + vh]], { fill: '#1F6B45' });
  p.ctext(L + 14, y + 16, 'Value at storage', SOFT, { size: 8.5 });
  p.ctext(L + 14, y + 36, v.amount, INK, { size: 16, bold: true });
  p.wrap(L + 190, y + 16, v.detail, R - L - 200, { size: 8.5, gray: 0.2, lead: 11 });
  y += vh + 10;

  // Terms
  y = Math.max(y + 6, 330);
  p.ctext(L, y, 'Terms of this receipt', INK, { size: 11, bold: true }); y += 16;
  TERMS.forEach((t, i) => { p.text(L, y, `${i + 1}.`, { size: 8.5, gray: 0.35 }); y = p.wrap(L + 14, y, t, R - L - 14, { size: 8.5, gray: 0.15, lead: 11 }) + 4; });

  // Attestation
  y += 14; const half = (R - L) / 2;
  p.line(L, y, L + half - 20, y, { gray: 0.5 }); p.line(L + half + 10, y, R, y, { gray: 0.5 });
  p.text(L, y + 13, 'For the warehouse operator', { size: 8, gray: 0.4 });
  p.text(L, y + 26, `${d.warehouse}`, { size: 9.5, bold: true });
  p.text(L, y + 38, d.received_by ? `Received and weighed by ${d.received_by}` : 'Received and weighed at intake', { size: 8.5, gray: 0.25 });
  p.text(L + half + 10, y + 13, 'For Kitovu Technology Company Limited', { size: 8, gray: 0.4 });
  p.text(L + half + 10, y + 26, d.issued_by ? `Issued by ${d.issued_by}` : 'Issued by StorageX', { size: 9.5, bold: true });
  p.text(L + half + 10, y + 38, d.signature ? `Digitally signed${d.key_id ? `, key ${d.key_id}` : ''}` : `Issued through StorageX on ${whenText(d.issued_at).replace(/,? at \d{2}:\d{2} WAT$/, '')}`, { size: 8.5, gray: 0.25 });

  // Footer
  p.line(L, 790, R, 790, { gray: RULE });
  if (d.signature) p.text(L, 802, `Signature ${d.signature.slice(0, 64)}${d.signature.length > 64 ? '…' : ''}`, { size: 6.5, gray: 0.45 });
  p.text(L, 813, d.url.length > 110 ? d.url.slice(0, 110) + '…' : d.url, { size: 6.5, gray: 0.45 });
  p.text(L, 824, COMPANY, { size: 6.5, gray: 0.45 });
  return p.toBuffer({ title: `Warehouse receipt ${d.receipt_no}` });
}
