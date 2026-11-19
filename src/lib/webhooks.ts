// Webhooks to partners' systems. Events are written to an outbox in the same transaction as the change, then
// delivered by a job every minute (`node dist/cli.mjs webhooks`), signed, and retried with back-off for a day.
// Signature: X-StorageX-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the client's secret>.
import crypto from 'node:crypto';
import { db } from './db';
import { decrypt } from './util';

export type WebhookEvent =
  | 'loan_request.created' | 'loan.approved' | 'loan.rejected' | 'loan.disbursed' | 'loan.repayment' | 'loan.repaid'
  | 'sale.proposed' | 'sale.approved' | 'sale.cancelled' | 'sale.settled' | 'alert.created' | 'test.ping';
export const EVENTS: WebhookEvent[] = ['loan_request.created', 'loan.approved', 'loan.rejected', 'loan.disbursed', 'loan.repayment', 'loan.repaid',
  'sale.proposed', 'sale.approved', 'sale.cancelled', 'sale.settled', 'alert.created', 'test.ping'];

const BACKOFF_MIN = [1, 5, 30, 120, 360, 720, 1440];

/** Queue an event for every active API client of the organisation that has a webhook address. Never throws. */
export async function emit(orgId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>, dedupe: string) {
  if (!orgId) return 0;
  try {
    const cs = await db.all<{ id: string }>(`SELECT id FROM api_clients WHERE org_id=$1 AND status='active' AND webhook_url IS NOT NULL`, orgId);
    for (const c of cs) {
      await db.run(`INSERT INTO webhook_events (client_id, event, payload, dedupe) VALUES ($1,$2,$3,$4) ON CONFLICT (client_id, dedupe) DO NOTHING`,
        c.id, event, JSON.stringify({ type: event, created_at: new Date().toISOString(), data }), `${event}:${dedupe}`);
    }
    return cs.length;
  } catch (e) { console.error('[webhooks] emit', event, e); return 0; }
}

export function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Deliver what is due. `send` is replaceable for tests. */
export async function deliverDue(send: Fetch = (u, i) => fetch(u, i) as any, limit = 200) {
  const due = await db.all<any>(`SELECT e.*, c.webhook_url, c.webhook_secret, c.status AS client_status FROM webhook_events e JOIN api_clients c ON c.id=e.client_id
    WHERE e.delivered_at IS NULL AND e.next_at <= now() AND e.attempts < $1 ORDER BY e.id LIMIT $2`, BACKOFF_MIN.length + 1, limit);
  let ok = 0, failed = 0;
  for (const e of due) {
    if (e.client_status !== 'active' || !e.webhook_url) { await db.run(`UPDATE webhook_events SET attempts=$2, last_error='client revoked or no address' WHERE id=$1`, e.id, BACKOFF_MIN.length + 1); continue; }
    const body = JSON.stringify({ id: `evt_${e.id}`, ...e.payload });
    let status = 0, err: string | null = null;
    try {
      const r = await send(e.webhook_url, { method: 'POST', body, signal: AbortSignal.timeout(10_000), headers: {
        'Content-Type': 'application/json', 'User-Agent': 'StorageX-Webhooks/1', 'X-StorageX-Event': e.event, 'X-StorageX-Delivery': `evt_${e.id}`,
        'X-StorageX-Signature': signature(decrypt(e.webhook_secret), body) } });
      status = r.status;
    } catch (x: any) { err = String(x?.message ?? x).slice(0, 200); }
    if (status >= 200 && status < 300) { ok++; await db.run('UPDATE webhook_events SET delivered_at=now(), attempts=attempts+1, last_status=$2, last_error=NULL WHERE id=$1', e.id, status); }
    else {
      failed++;
      const wait = BACKOFF_MIN[Math.min(e.attempts, BACKOFF_MIN.length - 1)];
      await db.run(`UPDATE webhook_events SET attempts=attempts+1, last_status=$2, last_error=$3, next_at=now() + make_interval(mins => $4::int) WHERE id=$1`, e.id, status || null, err ?? `HTTP ${status}`, wait);
    }
  }
  return { due: due.length, ok, failed };
}
