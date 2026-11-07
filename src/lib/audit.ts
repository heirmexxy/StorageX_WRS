// Write to the append-only, hash-chained audit log. Joins the caller's transaction when there is one.
import { db } from './db';

export interface AuditActor { userId?: string | null; label: string; ip?: string | null }

export async function audit(actor: AuditActor, action: string, o: { orgId?: string | null; entity?: string; entityId?: string; data?: Record<string, unknown> } = {}) {
  await db.run(
    `INSERT INTO audit_log (actor_user_id, actor_label, org_id, action, entity, entity_id, ip, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    actor.userId ?? null, actor.label, o.orgId ?? null, action, o.entity ?? null, o.entityId ?? null, actor.ip ?? null, o.data ?? {},
  );
}

export const systemActor = (job: string): AuditActor => ({ label: `system:${job}` });

/** null when the chain is intact, otherwise the id of the first broken row. */
export async function verifyAuditChain(): Promise<string | null> {
  const v = await db.val<string | null>('SELECT audit_log_verify()');
  return v == null ? null : String(v);
}
