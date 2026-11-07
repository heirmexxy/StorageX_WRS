// Uploaded files (ID photos, selfies, consent evidence). The type is decided by the file's first bytes, never by
// its name or the browser's claim. Contents are encrypted (AES-256-GCM) on disk; only metadata is in the database.
import { UserError } from './errors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { encryptBuffer, decryptBuffer } from './util';
import type { Upload } from './http';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export type FileKind = 'id_document' | 'selfie' | 'consent_evidence' | 'warehouse_document' | 'other';
export class FileError extends UserError {}

export function sniff(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

const root = () => path.resolve(config.uploadsDir);

/** Validates, encrypts and stores one upload; returns the new file id. Call inside the caller's transaction. */
export async function saveFile(u: Upload | undefined, o: { kind: FileKind; entity: string; entityId: string; userId: string; allowPdf?: boolean; label: string }) {
  if (!u || !u.data.length) throw new FileError(`${o.label}: choose a file.`);
  if (u.data.length > MAX_FILE_BYTES) throw new FileError(`${o.label}: the file is over 5 MB. Take the photo at a lower resolution.`);
  const mime = sniff(u.data);
  if (!mime || (mime === 'application/pdf' && !o.allowPdf)) throw new FileError(`${o.label}: upload a JPG, PNG or WebP photo${o.allowPdf ? ' or a PDF' : ''}.`);
  const d = new Date();
  const rel = path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), crypto.randomBytes(16).toString('hex') + '.bin');
  const abs = path.join(root(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, encryptBuffer(u.data), { mode: 0o600 });
  try {
    return (await db.val<string>(
      `INSERT INTO files (kind, path, mime, size_bytes, sha256, entity, entity_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      o.kind, rel, mime, u.data.length, crypto.createHash('sha256').update(u.data).digest('hex'), o.entity, o.entityId, o.userId))!;
  } catch (e) { fs.rmSync(abs, { force: true }); throw e; }
}

export interface FileRow { id: string; kind: FileKind; path: string; mime: string; entity: string; entity_id: string; deleted_at: Date | null; sha256: string }
export const fileRow = (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? db.get<FileRow>('SELECT * FROM files WHERE id=$1', id) : Promise.resolve(undefined));

export function readFile(f: FileRow) {
  if (f.deleted_at) throw new FileError('This file was deleted under the retention policy.');
  const abs = path.join(root(), f.path);
  if (!abs.startsWith(root() + path.sep)) throw new FileError('Bad file path.');
  const plain = decryptBuffer(fs.readFileSync(abs));
  if (crypto.createHash('sha256').update(plain).digest('hex') !== f.sha256) throw new FileError('File integrity check failed.');
  return plain;
}

/** Retention: remove the contents of files whose delete_after date has passed. Rows, hashes and decisions remain. */
export async function purgeExpiredFiles() {
  const due = await db.all<FileRow>(`SELECT * FROM files WHERE deleted_at IS NULL AND delete_after IS NOT NULL AND delete_after <= current_date`);
  for (const f of due) {
    fs.rmSync(path.join(root(), f.path), { force: true });
    await db.run('UPDATE files SET deleted_at=now() WHERE id=$1', f.id);
  }
  return due.length;
}
