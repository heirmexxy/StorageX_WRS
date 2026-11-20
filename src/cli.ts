// Command line: node dist/cli.mjs <command>
//   migrate                      apply new database migrations
//   seed                         load reference data (idempotent)
//   make-admin <email> <name…>   create the first Kitovu super admin invitation and print its link
//   backup [file]                pg_dump the database (custom format) into BACKUP_DIR
//   restore-check <file>         restore a backup into a throwaway database and count rows (proves backups work)
//   verify-audit                 check the audit log hash chain
//   revalue                      value every live receipt for today (run daily)
//   remind                       text farmers whose loans fall due soon or were missed (run daily)
//   steward                      data steward: find and close registry problems (run daily)
//   purge-files                  delete ID photos whose retention date has passed (run daily)
//   legacy-import [dump.sql]     bring in the 2021–22 StorageX records (farmers, field partners, warehouses, receipts),
//                                then flag every record that falls short of today's standard. With --token-stdin and
//                                no file, fetches the dump from the private heirmexxy/storagex repository with a
//                                GitHub token read from standard input. Safe to run again: nothing is copied twice.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config';
import { closePool, db, openPool } from './lib/db';
import { purgeExpiredFiles } from './lib/files';
import { revalueAll } from './lib/valuation';
import { priceWatch, alertPriceDrops } from './lib/alerts';
import { sendReminders } from './lib/notify';
import { runSteward } from './lib/agents/data-steward';
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
      // Uploaded files (already encrypted) go alongside the dump. They can only be read with this server's APP_SECRET,
      // so keep a copy of .env somewhere safe and separate from the backups.
      if (fs.existsSync(config.uploadsDir)) {
        const tarFile = file.replace(/\.dump$/, '') + '.uploads.tar';
        run('tar', ['-cf', tarFile, '-C', path.dirname(path.resolve(config.uploadsDir)), path.basename(path.resolve(config.uploadsDir))]);
        console.log(`uploads archived: ${tarFile}`);
      }
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
    case 'steward': {
      const r = await runSteward('cron');
      console.log(`data steward: ${r.opened} opened, ${r.closed} closed, ${r.open} open`, r.byCode);
      break;
    }
    case 'remind': {
      const r = await sendReminders();
      console.log(`reminders sent: ${r.soon} due soon, ${r.overdue} overdue`);
      const { termSweep } = await import('./lib/receipts');
      const t = await termSweep();
      console.log(`storage terms: ${t.reminded} ending soon, ${t.ended} newly past their term`);
      break;
    }
    case 'revalue': {
      const r = await revalueAll();
      console.log(`${r.day}: valued ${r.valued}, without price ${r.unpriced}, price falls over the alert level ${r.drops.length}`);
      for (const d of r.drops) console.log(`  ${d.receipt_no}: ${d.change_pct}%`);
      await alertPriceDrops(r.drops, r.day);
      const w = await priceWatch();
      console.log(`price watch: ${w.loans} loans checked, ${w.raised} new alerts`);
      break;
    }
    case 'webhooks': {
      const { deliverDue } = await import('./lib/webhooks');
      const r = await deliverDue();
      if (r.due) console.log(`${new Date().toISOString()} webhooks: ${r.ok} delivered, ${r.failed} to retry`);
      break;
    }
    case 'price-feed': {
      const { importFeed } = await import('./lib/pricefeed');
      const r = await importFeed();
      console.log(`${new Date().toISOString()} price feed: ${r.error ?? `${r.added} new prices waiting for approval, ${r.skipped} skipped`}`);
      break;
    }
    case 'wareguard-sweep': {
      const { sweepOffline } = await import('./lib/wareguard');
      const { sync } = await import('./lib/titan');
      const t = await sync();
      if (t && (t.stored || t.errors.length)) console.log(`${t.at} Titan: ${t.matched}/${t.sites} sites, ${t.devices} devices, ${t.stored} new readings${t.errors.length ? `; problems: ${t.errors.join('; ')}` : ''}`);
      const n = await sweepOffline();
      if (n) console.log(`${new Date().toISOString()} WareGuard: ${n} device(s) quiet`);
      break;
    }
    case 'titan-connect': {
      // Once, after TITAN_API_KEY is set: check the key, match Titan sites to warehouses, fetch, and switch on live updates.
      const T = await import('./lib/titan');
      if (!T.connected()) { console.error('TITAN_API_KEY is not set in the server settings (.env). Add it, restart, and run this again.'); process.exitCode = 1; break; }
      const all = await T.sites();
      console.log(`Titan key works. Sites Titan shows this key: ${all.length}`);
      const r = await T.sync();
      console.log(`Matched to warehouses: ${r!.matched}. Devices: ${r!.devices}. Readings stored: ${r!.stored}.`);
      for (const u of r!.unmatched) console.log(`  Not matched: ${u}. Set its external reference in Titan to the StorageX warehouse code (e.g. WH-OY-ISY-01), or link it on the warehouse page.`);
      for (const e of r!.errors) console.log(`  Problem: ${e}`);
      try { const w = await T.subscribe(); console.log(`Live updates switched on: Titan will send changes to ${w.url}.`); }
      catch (e: any) { console.log(`Live updates not switched on: ${e.message} Readings are still fetched every 10 minutes.`); }
      break;
    }
    case 'legacy-import': {
      const os = await import('node:os');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-legacy-'));
      try {
        let dump = args.find((a) => !a.startsWith('--'));
        if (!dump) {
          if (!args.includes('--token-stdin')) { console.error('Give the dump file, or --token-stdin to fetch it from GitHub.'); process.exitCode = 1; break; }
          const token = fs.readFileSync(0, 'utf8').trim();
          if (!token) { console.error('No GitHub token on standard input.'); process.exitCode = 1; break; }
          const r = await fetch('https://api.github.com/repos/heirmexxy/storagex/contents/storagex_laravel_portal.sql', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'storagex-legacy-import' }, signal: AbortSignal.timeout(120_000) });
          if (!r.ok) { console.error(`GitHub answered ${r.status}. Check the token can read heirmexxy/storagex (Contents: read).`); process.exitCode = 1; break; }
          dump = path.join(work, 'legacy.sql');
          fs.writeFileSync(dump, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
          console.log(`Fetched the old StorageX database export (${Math.round(fs.statSync(dump).size / 1024)} KB).`);
        }
        const out = path.join(work, 'out');
        const imp = spawnSync(process.execPath, [path.resolve('tools/legacy-import/import.mjs'), dump, out], { stdio: ['ignore', 'ignore', 'inherit'] });
        if (imp.status !== 0) throw new Error('The importer could not read the export.');
        await db.script(fs.readFileSync(path.join(out, 'legacy_import.sql'), 'utf8'));
        const counts = await db.get<any>(`SELECT (SELECT count(*) FROM farmers WHERE source='legacy_import')::int AS farmers,
            (SELECT count(*) FROM field_partners WHERE source='legacy_import')::int AS partners,
            (SELECT count(*) FROM warehouses WHERE legacy IS NOT NULL)::int AS warehouses, (SELECT count(*) FROM receipts WHERE source='legacy_import')::int AS receipts`);
        console.log(`In StorageX now from the old system: ${counts.farmers} farmers, ${counts.partners} field partners, ${counts.warehouses} warehouses, ${counts.receipts} retired receipt(s).`);
        const s = await runSteward('legacy-import');
        const open = await db.all<any>(`SELECT code, count(*)::int AS n FROM data_issues WHERE resolved_at IS NULL AND severity <> 'info' GROUP BY code ORDER BY n DESC`);
        console.log(`Records to complete (see Review queue): ${s.open} open items.`);
        for (const o of open) console.log(`  ${String(o.n).padStart(4)}  ${o.code.replace(/_/g, ' ')}`);
      } finally { fs.rmSync(work, { recursive: true, force: true }); }      // the export holds personal data: nothing is left behind
      break;
    }
    case 'purge-files': {
      const { applyRetention } = await import('./lib/files');
      const r = await applyRetention();
      console.log(`retention: ${r.dated} delivery photo date(s) set, ${r.ussd} USSD log line(s) removed`);
      console.log(`removed ${await purgeExpiredFiles()} expired file(s)`);
      break;
    }
    case 'verify-audit': {
      const broken = await verifyAuditChain();
      console.log(broken ? `BROKEN at audit entry ${broken}` : 'audit chain intact');
      if (broken) process.exitCode = 2;
      break;
    }
    default:
      console.log('commands: migrate | seed | make-admin <email> <name> | backup [file] | restore-check <file> | verify-audit | purge-files | revalue | remind | steward');
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => closePool());
