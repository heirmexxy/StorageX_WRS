# StorageX WRS

Kitovu's warehouse receipt system: a ledger of verified, financeable warehouse receipts, with surfaces for field agents, farmers, warehouse partners, lenders and buyers, and a distribution API that lets partner platforms (ComboTrader, TradeChainX and others) offer receipts to their own users.

StorageX does not run a trading venue itself. It issues, values, locks and settles receipts; partners trade them through the API.

Build order and status: [`docs/roadmap.md`](docs/roadmap.md). Decisions: [`docs/decisions.md`](docs/decisions.md). Data rules: [`docs/data-standard.md`](docs/data-standard.md).

## Stack

Node 22 and TypeScript, server-rendered React, PostgreSQL 16, built with esbuild (the same conventions as ComboTrader). Dependencies are kept to `pg`, `react` and `react-dom`.

| Path | What it is |
| --- | --- |
| `src/server.ts` | HTTP server, access guards, security headers |
| `src/lib/auth.ts` | Sign-in, lockout, two-step codes, sessions, invitations, password resets, people administration |
| `src/lib/rbac.ts` | Roles per organisation type and the permission checks |
| `src/lib/audit.ts` | Append-only, hash-chained audit log |
| `src/lib/registry.ts` | Farmers, field partners, warehouses, insurance, the data review queue |
| `src/lib/kyc.ts` | Tiered identity checks, consent to share with lenders, lender confirmation, provider slot |
| `src/lib/applications.ts` | Public partner applications and their review |
| `src/lib/files.ts`, `otp.ts`, `sms.ts` | Encrypted uploads, one-time SMS codes, Termii |
| `src/lib/money.ts` | Kobo parsing and formatting |
| `src/lib/migrate.ts` | Migration runner (checksummed) and seeds |
| `src/cli.ts` | `migrate`, `seed`, `make-admin`, `backup`, `restore-check`, `verify-audit`, `purge-files` |
| `db/migrations/` | Schema, applied in order |
| `tools/legacy-import/` | One-off importer from the 2021–22 StorageX dump |
| `deploy/` | Hostinger VPS setup, update and the step-by-step guide |
| `tests/run.ts` | Tests against a real PostgreSQL database |

## Run it locally

Needs PostgreSQL 14+ and Node 22.13+.

```bash
createdb storagex_dev && createdb storagex_test        # as a role that owns both
cp .env.example .env                                    # set DATABASE_URL, NODE_ENV=development, BASE_URL=http://localhost:3200
npm install
npm run build && npm run migrate && npm run seed
node dist/cli.mjs make-admin you@kitovu.com.ng "Your Name"   # prints an invitation link
npm start                                               # http://localhost:3200 (SMS codes print in the log until TERMII_API_KEY is set)
npm test                                                # wipes and rebuilds TEST_DATABASE_URL (default storagex_test)
```

Legacy data (the output holds personal data and is git-ignored):

```bash
node tools/legacy-import/import.mjs /path/to/storagex_laravel_portal.sql out
psql "$DATABASE_URL" -f out/legacy_import.sql
```

Deploying: [`deploy/HOSTINGER.md`](deploy/HOSTINGER.md).

## Rules for this codebase

- No personal data in git: no dumps, exports, uploads or real seed data.
- Never store a full ID number, BVN or bank account number.
- Money is integer kobo; weights are kilograms. See the data standard.
- Every change to records goes through a function that writes the audit log in the same transaction.
- Migrations only move forward and must keep working with the previous release.
