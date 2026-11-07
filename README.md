# StorageX WRS

Kitovu's warehouse receipt system: a ledger of verified, financeable warehouse receipts, with surfaces for field agents, farmers, warehouse partners, lenders and buyers, and a distribution API that lets partner platforms (ComboTrader, TradeChainX and others) offer receipts to their own users.

StorageX does not run a trading venue itself. It issues, values, locks and settles receipts; partners trade them through the API.

## What is here so far

| Path | What it is |
| --- | --- |
| `db/migrations/0001_core_schema.sql` | First Postgres migration: reference data, organisations, farmers, field partners, warehouses, insurance, receipts and the append-only receipt event log |
| `db/seeds/0001_reference.sql` | Nigerian states, the Kitovu organisation, commodity codes |
| `tools/legacy-import/import.mjs` | One-off importer from the 2021–22 Laravel/MySQL StorageX dump |
| `docs/data-standard.md` | Field rules every record follows |
| `docs/decisions.md` | Product and architecture decisions to date |
| `docs/migration/legacy-import.md` | What the legacy import did, and the review list it produced |

## Run it locally

Needs Postgres 14+ and Node 22+.

```bash
createdb storagex
psql -d storagex -f db/migrations/0001_core_schema.sql
psql -d storagex -f db/seeds/0001_reference.sql

# Legacy data (the dump lives outside the repo; output contains personal data and is git-ignored)
node tools/legacy-import/import.mjs /path/to/storagex_laravel_portal.sql out
psql -d storagex -f out/legacy_import.sql
```

The import is idempotent: running it again changes nothing except refreshing unresolved data issues.

## Data rule

No personal data in git: no dumps, no exports, no real seed data. Use synthetic fixtures for tests.
