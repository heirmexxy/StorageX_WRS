// Postgres access. One pool; transactions via tx(), and every db.* call inside a tx() callback uses that
// transaction automatically (AsyncLocalStorage), so helpers like audit() join the caller's transaction.
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

let pool: InstanceType<typeof pg.Pool> | null = null;
const txStore = new AsyncLocalStorage<Queryable>();

export function openPool(url = config.databaseUrl) {
  if (!pool) pool = new pg.Pool({ connectionString: url, max: 10 });
  return pool;
}
export async function closePool() { if (pool) { const p = pool; pool = null; await p.end(); } }

const conn = (): Queryable => txStore.getStore() || openPool();
async function exec(sql: string, params: unknown[]) { return conn().query(sql, params.length ? params : undefined); }

export const db = {
  async all<T = any>(sql: string, ...p: unknown[]): Promise<T[]> { return (await exec(sql, p)).rows as T[]; },
  async get<T = any>(sql: string, ...p: unknown[]): Promise<T | undefined> { return (await exec(sql, p)).rows[0] as T | undefined; },
  async val<T = any>(sql: string, ...p: unknown[]): Promise<T | undefined> {
    const r = (await exec(sql, p)).rows[0];
    return r ? (Object.values(r)[0] as T) : undefined;
  },
  async run(sql: string, ...p: unknown[]): Promise<number> { return (await exec(sql, p)).rowCount ?? 0; },
  /** Runs SQL text that may hold several statements (migrations, seeds). No parameters. */
  async script(sql: string) { await conn().query(sql); },
};

/** Run fn in one transaction. Nested calls reuse the outer transaction. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  const client = await openPool().connect();
  try {
    await client.query('BEGIN');
    const out = await txStore.run(client as Queryable, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export const inTx = () => !!txStore.getStore();
