// Applies db/migrations/*.sql in name order, each in its own transaction, recording a checksum.
// A changed checksum on an already-applied migration stops everything: write a new migration instead.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx } from './db';
import { sha256 } from './util';

const DIR = path.resolve('db/migrations');
const SEEDS = path.resolve('db/seeds');

export async function migrate(log: (s: string) => void = console.log) {
  await db.script(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await db.all<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).map((r) => [r.version, r.checksum]));
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  let count = 0;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const sum = sha256(sql);
    const version = f.replace(/\.sql$/, '');
    const prev = applied.get(version);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${f} was changed after it was applied. Add a new migration instead.`);
      continue;
    }
    await tx(async () => {
      await db.script(sql);
      await db.run('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', version, sum);
    });
    log(`applied ${f}`);
    count++;
  }
  if (!count) log('database is up to date');
  return count;
}

/** Reference data. Every seed file is idempotent (ON CONFLICT DO NOTHING), so this can run on every deploy. */
export async function seed(log: (s: string) => void = console.log) {
  for (const f of fs.readdirSync(SEEDS).filter((x) => x.endsWith('.sql')).sort()) {
    await tx(() => db.script(fs.readFileSync(path.join(SEEDS, f), 'utf8')));
    log(`seeded ${f}`);
  }
}
