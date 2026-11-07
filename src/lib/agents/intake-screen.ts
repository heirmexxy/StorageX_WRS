// Reads the numbers off the scale and moisture-meter photos and compares them with what the clerk typed.
// Clerks read numbers off displays, so this is the main check that the typed weights are the real ones.
// The model only transcribes the display; the comparison and the flag are done here in code.
import { db } from '../db';
import { config } from '../config';
import { audit, systemActor } from '../audit';
import { fileRow, readFile } from '../files';
import { getSettings } from '../settings';
import { defaultModel, imagePart, jsonFrom, type ModelCall } from './model';

export const PROMPT_VERSION = 'intake-displays-1';
const SYSTEM = `You transcribe numbers from photos of measuring instruments at a Nigerian grain warehouse.
Each photo shows either a weighing scale display (kilograms) or a grain moisture meter display (percent).
For each photo, report the main number shown on the display exactly as displayed, as a number, or null if you cannot read it with confidence.
Do not guess, round, or use any number the user might expect; you are not told what was recorded.
Also say if the photo looks like it shows a screen or printout of another photo rather than the instrument itself.
Answer with one JSON object only: {"readings":[{"photo":1,"value":1234.5,"unit":"kg|%|unknown","confident":true,"note":"…"}],"concerns":[]}`;

/** Weights: allow 0.5% (rounding on the display); moisture: 0.3 points. */
export function compare(entered: number, read: number | null, kind: 'scale' | 'moisture') {
  if (read === null || !Number.isFinite(read)) return 'unreadable';
  return kind === 'scale' ? (Math.abs(read - entered) <= Math.max(0.5, entered * 0.005) ? 'match' : 'mismatch') : (Math.abs(read - entered) <= 0.3 ? 'match' : 'mismatch');
}

export async function screenIntake(intakeId: string, call: ModelCall | null = defaultModel()) {
  if ((await getSettings())['intake.ai_check'] === 'off' || config.kycAiMode === 'off') return null;
  const i = await db.get<any>('SELECT id, ref, weighings, moisture_pct::float AS moisture, flags FROM intakes WHERE id=$1', intakeId);
  if (!i) return null;
  if (!call) { await db.run(`UPDATE intakes SET ai_check=$2 WHERE id=$1`, intakeId, JSON.stringify({ status: 'skipped', reason: 'No ANTHROPIC_API_KEY on this server' })); return null; }
  const photos = await db.all<{ idx: number; kind: string; file_id: string; sha256: string }>(`SELECT idx, kind, file_id, sha256 FROM intake_photos WHERE intake_id=$1 AND kind IN ('scale','moisture') ORDER BY idx`, intakeId);
  // What each photo should show, in order: scale photos map to weighings by hash.
  const targets = photos.map((p) => {
    if (p.kind === 'moisture') return { p, kind: 'moisture' as const, entered: Number(i.moisture), label: 'moisture meter' };
    const w = (i.weighings as any[]).find((x) => x.photo === p.sha256);
    return { p, kind: 'scale' as const, entered: Number(w?.gross_kg), label: `scale (${w?.bags} bags)` };
  });
  try {
    const content: unknown[] = [];
    for (const t of targets) { const f = (await fileRow(t.p.file_id))!; content.push(imagePart(f.mime, readFile(f))); }
    content.push({ type: 'text', text: targets.map((t, n) => `Photo ${n + 1}: ${t.kind === 'scale' ? 'weighing scale display' : 'moisture meter display'}`).join('\n') });
    const r = await call(SYSTEM, content);
    const j = jsonFrom(r.text);
    const readings = targets.map((t, n) => {
      const got = (j.readings || []).find((x: any) => Number(x.photo) === n + 1);
      const read = got && got.confident !== false && got.value !== null && got.value !== undefined ? Number(got.value) : null;
      return { photo: n + 1, kind: t.kind, label: t.label, entered: t.entered, read, result: compare(t.entered, read, t.kind), note: String(got?.note ?? '').slice(0, 160) };
    });
    const bad = readings.filter((x) => x.result === 'mismatch');
    const unreadable = readings.filter((x) => x.result === 'unreadable');
    const check = { status: 'done', model: config.aiModel, prompt: PROMPT_VERSION, readings, concerns: (j.concerns || []).slice(0, 5).map((c: unknown) => String(c).slice(0, 200)), tokens: [r.tin, r.tout] };
    const flags = (i.flags as any[]).filter((f) => !['display_mismatch', 'display_unreadable'].includes(f.code));
    if (bad.length) flags.push({ code: 'display_mismatch', severity: 'hold', detail: bad.map((b) => `${b.label}: typed ${b.entered}, photo shows ${b.read}`).join('; ') });
    else if (unreadable.length) flags.push({ code: 'display_unreadable', severity: 'review', detail: `${unreadable.length} display photo(s) could not be read: check them by eye.` });
    await db.run('UPDATE intakes SET ai_check=$2, flags=$3 WHERE id=$1', intakeId, JSON.stringify(check), JSON.stringify(flags));
    await audit(systemActor('intake-screen'), 'intake.ai_checked', { entity: 'intake', entityId: intakeId, data: { ref: i.ref, mismatches: bad.length, unreadable: unreadable.length } });
    return bad.length ? 'mismatch' : unreadable.length ? 'unreadable' : 'match';
  } catch (e: any) {
    await db.run(`UPDATE intakes SET ai_check=$2 WHERE id=$1`, intakeId, JSON.stringify({ status: 'failed', error: String(e?.message || e).slice(0, 300) }));
    return null;
  }
}
