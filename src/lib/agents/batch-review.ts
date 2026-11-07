// Batch reviewer agent. For each loan request it runs fixed checks in code (identity, consent, loan-to-value,
// price evidence, warehouse, stock reconciliation, the farmer's loan history, concentration), then, if the AI is
// switched on, writes a short plain-English note for the lender's credit officer from those checks only.
// It never approves, rejects or changes an amount: the officer decides.
import { db } from '../db';
import { config } from '../config';
import { getSettings } from '../settings';
import { referencePrice } from '../valuation';
import { reconcile } from '../stock';
import { fmtNGN } from '../money';
import { defaultModel, type ModelCall } from './model';

export const PROMPT_VERSION = 'batch-review-1';
export interface Check { code: string; result: 'ok' | 'warn' | 'fail'; detail: string }

export async function checksFor(lineId: string): Promise<Check[]> {
  const l = await db.get<any>(
    `SELECT l.*, b.lender_org_id, o.kind AS lender_kind, o.name AS lender, p.min_kyc_level, f.kyc_level, f.full_name, f.phone_verified_at, f.created_at AS farmer_since,
       (SELECT COALESCE(sum(requested_kobo),0) FROM loan_lines x WHERE x.batch_id=l.batch_id AND x.status <> 'removed') AS batch_total
     FROM loan_lines l JOIN loan_batches b ON b.id=l.batch_id JOIN organisations o ON o.id=b.lender_org_id JOIN loan_products p ON p.id=b.product_id JOIN farmers f ON f.id=l.farmer_id WHERE l.id=$1`, lineId);
  if (!l) return [];
  const c: Check[] = [];
  const add = (code: string, result: Check['result'], detail: string) => c.push({ code, result, detail });

  add('identity', l.kyc_level >= l.min_kyc_level ? 'ok' : l.kyc_level >= 1 ? 'warn' : 'fail',
    l.kyc_level >= l.min_kyc_level ? `Identity level ${l.kyc_level}.` : `Identity level ${l.kyc_level}; this product needs level ${l.min_kyc_level} before disbursement (confirm the account with your bank).`);
  if (l.lender_kind === 'lender') {
    const consent = await db.val('SELECT 1 FROM farmer_consents WHERE farmer_id=$1 AND org_id=$2 AND withdrawn_at IS NULL', l.farmer_id, l.lender_org_id);
    add('consent', consent ? 'ok' : 'fail', consent ? `Farmer agreed to share their record with ${l.lender}.` : 'No active consent to share with you.');
  }
  const ltv = l.max_loan_kobo ? Number(l.requested_kobo) / Number(l.market_value_kobo) : null;
  add('loan_to_value', Number(l.requested_kobo) <= Number(l.max_loan_kobo) ? 'ok' : 'fail',
    `Asks ${fmtNGN(Number(l.requested_kobo))} against stock worth ${fmtNGN(Number(l.market_value_kobo))} today (${ltv !== null ? (ltv * 100).toFixed(1) : '?'}% of market value; your limit allows ${fmtNGN(Number(l.max_loan_kobo))}).`);

  const rs = await db.all<any>(`SELECT r.id, r.receipt_no, r.commodity_code, r.issued_at, w.id AS wh_id, w.state_code, w.status AS wh_status, w.name AS wh_name,
      EXISTS (SELECT 1 FROM insurance_policies ip WHERE ip.warehouse_id=w.id AND ip.status='active' AND current_date BETWEEN ip.cover_from AND ip.cover_to) AS insured
    FROM receipts r JOIN warehouses w ON w.id=r.warehouse_id WHERE r.id = ANY($1)`, l.receipt_ids);
  for (const r of rs) {
    const ref = await referencePrice(r.commodity_code, r.state_code);
    const newest = ref.observations[0]?.on;
    const age = newest ? Math.round((Date.now() - new Date(newest).getTime()) / 86_400_000) : null;
    add(`price:${r.receipt_no}`, ref.scope === 'state' && (age ?? 99) <= 7 ? 'ok' : ref.scope === 'none' ? 'fail' : 'warn',
      ref.scope === 'none' ? `${r.receipt_no}: no usable price.` : `${r.receipt_no}: priced from ${ref.observations.length} ${ref.scope === 'state' ? 'prices in the warehouse’s state' : 'national prices (too few in the state)'}; newest ${age} day(s) old.`);
    add(`warehouse:${r.receipt_no}`, ['certified', 'active'].includes(r.wh_status) && r.insured ? 'ok' : 'warn',
      `${r.wh_name}: ${r.wh_status}${r.insured ? ', insured' : ', no current insurance on record'}.`);
    const rec = (await reconcile(r.wh_id)).find((x) => x.commodity_code === r.commodity_code);
    const holds = rec?.flags.filter((f: any) => f.severity === 'hold') ?? [];
    const stale = rec?.flags.some((f: any) => f.text.includes('not counted'));
    add(`stock:${r.receipt_no}`, holds.length ? 'fail' : stale ? 'warn' : 'ok', holds.length ? holds.map((h: any) => h.text).join(' ') : stale ? 'Stock agrees with receipts, but some stacks are overdue a count.' : 'Ledger, counts and receipts agree.');
  }
  const hist = await db.get<{ repaid: number; open: number; overdue: number; written_off: number }>(
    `SELECT count(*) FILTER (WHERE status='repaid')::int AS repaid, count(*) FILTER (WHERE status='disbursed')::int AS open,
            count(*) FILTER (WHERE status='disbursed' AND due_on < current_date)::int AS overdue, count(*) FILTER (WHERE status='written_off')::int AS written_off
     FROM loans WHERE farmer_id=$1 AND line_id <> $2`, l.farmer_id, l.id);
  add('history', hist!.written_off || hist!.overdue ? 'fail' : hist!.open ? 'warn' : 'ok',
    hist!.repaid + hist!.open + hist!.written_off === 0 ? 'First loan through StorageX.' : `Previous StorageX loans: ${hist!.repaid} repaid, ${hist!.open} open${hist!.overdue ? ` (${hist!.overdue} overdue)` : ''}${hist!.written_off ? `, ${hist!.written_off} written off` : ''}.`);
  const share = Number(l.batch_total) ? Number(l.requested_kobo) / Number(l.batch_total) : 0;
  if (share > 0.4 && Number(l.batch_total) > Number(l.requested_kobo)) add('concentration', 'warn', `This farmer is ${(share * 100).toFixed(0)}% of the batch.`);
  return c;
}

const SYSTEM = `You write a short note for a bank credit officer in Nigeria about one loan request backed by warehouse receipts for stored grain.
You are given only the results of automatic checks. Write 2–4 plain sentences: what looks sound, what needs the officer's attention, and what to verify before deciding.
Do not recommend approval or rejection, do not invent facts, do not mention anything not in the checks. No headings, no bullet points.`;

export async function reviewLine(lineId: string, call: ModelCall | null = defaultModel()) {
  const checks = await checksFor(lineId);
  let note: string | null = null, noteError: string | null = null;
  const s = await getSettings();
  if (call && s['loans.ai_note'] !== 'off' && config.kycAiMode !== 'off') {
    try {
      const r = await call(SYSTEM, [{ type: 'text', text: checks.map((c) => `[${c.result}] ${c.code}: ${c.detail}`).join('\n') }]);
      note = r.text.trim().slice(0, 900);
    } catch (e: any) { noteError = String(e?.message || e).slice(0, 200); }
  }
  const summary = checks.some((c) => c.result === 'fail') ? 'fail' : checks.some((c) => c.result === 'warn') ? 'warn' : 'ok';
  await db.run('UPDATE loan_lines SET review=$2 WHERE id=$1', lineId, JSON.stringify({ checks, summary, note, note_error: noteError, model: note ? config.aiModel : null, prompt: PROMPT_VERSION, at: new Date().toISOString() }));
  return { checks, summary, note };
}
