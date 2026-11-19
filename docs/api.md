# StorageX partner API (v1)

The full guide with every endpoint, example and webhook event is served by the app at **/developers**
(https://storagex.com.ng/developers), and the machine-readable description at **/api/v1/openapi.json**.
Both are generated from `src/lib/api-spec.ts`; the tests call every endpoint listed there.

## Who uses it

| Partner | What they do through the API |
| --- | --- |
| Lenders and funding partners (fintechs, investment and savings apps) | Receive loan requests, approve or reject, record payouts, split a loan among their own users, follow repayments, approve sales of pledged stock, read alerts and receipt values |
| Receipt issuers | Read their receipts and alerts (issuing itself happens in the gate app and web app, with the same checks as Kitovu) |
| Titan (Kitovu) | Send WareGuard devices and readings (Build 13) |

## Rules that do not change over the API

- A key acts as the person who created it. Their role limits it, and the key's permissions limit it further.
- The person who approves a loan cannot record its payout: funding partners use two keys made by two people.
- A funding partner is the **lender of record**. If its users fund loans, it holds their money and is responsible to
  them (licence, disclosures, KYC). StorageX stores only the partner's opaque reference for each user; references
  that look like phone or account numbers are refused.
- Pledged stock leaves the warehouse only through a sale the lender approves, or after the loan is repaid; the
  lender is paid first.

## Operations

- Webhooks are queued in `webhook_events` and delivered every minute by `node dist/cli.mjs webhooks`
  (scheduled by `deploy/jobs.sh`, which `deploy/update.sh` runs on every deploy).
- Keys are stored as SHA-256 hashes; webhook secrets are encrypted with the app secret.
- Limits: 600 requests a minute per key. Writes accept an `Idempotency-Key` header.
