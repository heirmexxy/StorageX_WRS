// QR codes as inline SVG (for the two-step verification setup). Encoder: vendored "QRCode for JavaScript" (MIT).
// @ts-ignore — CommonJS module without type definitions
import QRCode from '../vendor/qrcode/index.cjs';
// @ts-ignore
import ECL from '../vendor/qrcode/QRErrorCorrectLevel.cjs';

/** SVG markup for `text`, with a 4-module quiet zone (needed for reliable scanning). */
export function qrSvg(text: string, o: { size?: number; level?: 'L' | 'M' | 'Q' | 'H' } = {}) {
  const qr = new QRCode(-1, ECL[o.level || 'M']);
  qr.addData(text);
  qr.make();
  const n: number = qr.getModuleCount();
  const q = 4, dim = n + q * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + q} ${r + q}h1v1h-1z`;
  const size = o.size || 240;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
export const qrDataUri = (text: string, o?: Parameters<typeof qrSvg>[1]) => `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, o)).toString('base64')}`;
