// Versioned links to files in public/, so a browser never mixes a new page with an old cached stylesheet or video.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd(), 'public');
const seen = new Map<string, string>();

export function asset(p: string): string {
  let v = seen.get(p);
  if (v === undefined) {
    try {
      v = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, p))).digest('hex').slice(0, 8);
    } catch { v = ''; }
    seen.set(p, v);
  }
  return v ? `${p}?v=${v}` : p;
}
