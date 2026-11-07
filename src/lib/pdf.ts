// A very small PDF writer: one or more pages with text (Helvetica), lines, boxes and QR codes.
// Enough for receipts and slips without adding a dependency. Text is WinAnsi: other characters are simplified.
// @ts-ignore — CommonJS module without type definitions
import QRCode from '../vendor/qrcode/index.cjs';
// @ts-ignore
import ECL from '../vendor/qrcode/QRErrorCorrectLevel.cjs';

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/₦/g, 'NGN ').replace(/[^\x20-\x7e]/g, '?');
const esc = (s: string) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

export class Pdf {
  private pages: string[] = [];
  private cur = '';
  constructor(public w = 595.28, public h = 841.89) { this.page(); }   // A4 in points
  page() { if (this.cur) this.pages.push(this.cur); this.cur = ''; return this; }
  /** y is measured from the top of the page. */
  text(x: number, y: number, s: string, o: { size?: number; bold?: boolean; gray?: number } = {}) {
    const size = o.size ?? 10;
    this.cur += `BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${n(o.gray ?? 0)} g ${n(x)} ${n(this.h - y)} Td (${esc(s)}) Tj ET\n`;
    return this;
  }
  /** Rough width of Helvetica text, for wrapping and right-aligning. */
  width(s: string, size = 10, bold = false) { return ascii(s).length * size * (bold ? 0.56 : 0.5); }
  wrap(x: number, y: number, s: string, maxW: number, o: { size?: number; bold?: boolean; gray?: number; lead?: number } = {}) {
    const size = o.size ?? 10, words = ascii(s).split(/\s+/); let line = '', yy = y;
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (this.width(t, size, o.bold) > maxW && line) { this.text(x, yy, line, o); yy += o.lead ?? size * 1.35; line = w; } else line = t;
    }
    if (line) { this.text(x, yy, line, o); yy += o.lead ?? size * 1.35; }
    return yy;
  }
  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; gray?: number } = {}) {
    this.cur += `${n(o.width ?? 0.5)} w ${n(o.gray ?? 0)} G ${n(x1)} ${n(this.h - y1)} m ${n(x2)} ${n(this.h - y2)} l S\n`;
    return this;
  }
  box(x: number, y: number, w: number, hh: number, o: { fill?: number; stroke?: number; width?: number } = {}) {
    const r = `${n(x)} ${n(this.h - y - hh)} ${n(w)} ${n(hh)} re`;
    if (o.fill !== undefined) this.cur += `${n(o.fill)} g ${r} f\n`;
    if (o.stroke !== undefined) this.cur += `${n(o.width ?? 0.5)} w ${n(o.stroke)} G ${r} S\n`;
    return this;
  }
  qr(x: number, y: number, size: number, data: string) {
    const q = new QRCode(-1, ECL.M); q.addData(data); q.make();
    const count: number = q.getModuleCount(), m = size / count;
    let ops = '0 g\n';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) ops += `${n(x + c * m)} ${n(this.h - y - (r + 1) * m)} ${n(m + 0.02)} ${n(m + 0.02)} re\n`;
    this.cur += ops + 'f\n';
    return this;
  }
  toBuffer(meta: { title?: string } = {}) {
    if (this.cur) { this.pages.push(this.cur); this.cur = ''; }
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add(''), pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const content of this.pages) {
      const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(this.w)} ${n(this.h)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${esc(meta.title ?? 'StorageX')}) /Producer (StorageX) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
