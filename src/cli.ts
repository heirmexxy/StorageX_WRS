// Command line: node dist/cli.mjs <command>
//   migrate                      apply new database migrations
//   seed                         load reference data (idempotent)
//   make-admin <email> <name…>   create the first Kitovu super admin invitation and print its link
//   backup [file]                pg_dump the database (custom format) into BACKUP_DIR
//   restore-check <file>         restore a backup into a throwaway database and count rows (proves backups work)
//   verify-audit                 check the audit log hash chain
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config';
import { closePool, db, openPool } from './lib/db';
import { migrate, seed } from './lib/migrate';
import { bootstrapSuperAdmin } from './lib/auth';
import { verifyAuditChain } from './lib/audit';

const [cmd, ...args] = process.argv.slice(2);

function pgEnv(url = config.databaseUrl) {
  const u = new URL(url);
  return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) };
}
function run(bin: string, argv: string[], env = pgEnv()) {
  const r = spawnSync(bin, argv, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${bin} failed (exit ${r.status})`);
}

async function main() {
  openPool();
  switch (cmd) {
    case 'migrate': await migrate(); break;
    case 'seed': await seed(); break;
    case 'make-admin': {
      const [email, ...name] = args;
      if (!email || !name.length) throw new Error('usage: make-admin <email> <full name>');
      console.log(`Open this link within 72 hours to set a password and two-step sign-in:\n${await bootstrapSuperAdmin(email, name.join(' '))}`);
      break;
    }
    case 'backup': {
      fs.mkdirSync(config.backupDir, { recursive: true });
      const file = args[0] || path.join(config.backupDir, `storagex-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.dump`);
      run('pg_dump', ['--format=custom', '--no-owner', '--file', file]);
      console.log(`backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
      break;
    }
    case 'restore-check': {
      const file = args[0];
      if (!file || !fs.existsSync(file)) throw new Error('usage: restore-check <backup file>');
      const scratch = `storagex_restore_check_${Date.now()}`;
      await db.script(`CREATE DATABASE ${scratch}`);
      try {
        const url = new URL(config.databaseUrl); url.pathname = '/' + scratch;
        run('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', scratch, file]);
        const r = spawnSync('psql', ['-At', '-c', `SELECT (SELECT count(*) FROM schema_migrations)||' migrations, '||(SELECT count(*) FROM farmers)||' farmers, '||(SELECT count(*) FROM users)||' users, '||(SELECT count(*) FROM audit_log)||' audit entries'`], { env: pgEnv(url.toString()), encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        console.log(`restore OK: ${r.stdout.trim()}`);
      } finally {
        await db.script(`DROP DATABASE IF EXISTS ${scratch}`);
      }
      break;
    }
    case 'verify-audit': {
      const broken = await verifyAuditChain();
      console.log(broken ? `BROKEN at audit entry ${broken}` : 'audit chain intact');
      if (broken) process.exitCode = 2;
      break;
    }
    default:
      console.log('commands: migrate | seed | make-admin <email> <name> | backup [file] | restore-check <file> | verify-audit');
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => closePool());
