# StorageX: security review and brief for an outside test

Part 1 records the code review done in Build 12 (November 2026), what it found and what was fixed. Part 2 is the brief for an independent penetration test, planned before StorageX grows beyond the Accion pilot.

## Part 1: Review, November 2026

### Controls already in place
- **Sign-in:** password plus mandatory two-step code for every user. Rate limits per network and per account, account lockout, idle and absolute session expiry. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- **Requests:** CSRF token on every form post (gateway webhooks check their own key instead). Body size limits, with larger uploads only after two-step sign-in. Strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, and HSTS in production.
- **Access:** role-based permissions per organisation kind, checked on the server for every page and action. Lenders see only consenting farmers or their own liens. File downloads are checked per file and audited.
- **Two people for anything that moves stock or money,** enforced in code and again in the database (reviewer ≠ clerk, loader ≠ orderer, payout ≠ approver, decider ≠ proposer, hold clearance ≠ clerk).
- **Records that cannot be quietly changed:** sealed delivery records with a per-phone hash chain; receipts frozen once issued, with a hash-chained event history and Ed25519 signatures; append-only money and stock ledgers; a hash-chained audit log.
- **Sensitive data:** full NIN or BVN never stored; ID photos encrypted at rest and deleted on a schedule; no bank account numbers; the USSD PIN keyed-hashed and never logged.
- **Queries:** every database call uses parameters. The one dynamic table name is chosen from a fixed list.

### Findings and fixes

| # | Finding | Risk | Status |
|---|---|---|---|
| 1 | Loan book and registry downloads did not neutralise cells starting with `=`, `+`, `-` or `@`. A farmer name typed as a formula would run when opened in Excel at the lender. | High (lender-side code execution or data leak through spreadsheet formulas) | **Fixed:** every CSV cell goes through `csvCell`; tested |
| 2 | File downloads wrote the response twice, which could crash the server (found in Build 9). | Medium (anyone with access could stop the service) | **Fixed** in Build 9 |
| 3 | USSD had no per-phone request limit (PIN lockout existed per farmer). | Low | **Fixed:** 40 requests per 10 minutes per phone |
| 4 | Farmer, delivery and receipt lists stopped at 200–300 rows with no way to see the rest. | Medium at pilot scale (staff would miss records) | **Fixed:** 100 per page with totals |
| 5 | The data steward wrote one row at a time: over 2 minutes at 5,000 farmers, holding a transaction open. | Medium (slow daily job, locks) | **Fixed:** bulk writes, about 0.5 s at 5,000 farmers and 10,000 deliveries |
| 6 | The duplicate check ignored digits in community names ("Phase 1" matched "Phase 2"). | Low (false alarms) | **Fixed** |
| 7 | Upload archives in backups were never rotated, so the disk would fill. | Medium (outage) | **Fixed:** 30-day rotation like the database dumps |
| 8 | Backups lived only on the same server. | High (losing the server loses everything) | **Fixed:** nightly encrypted copy to Google Drive (rclone crypt), 30 days kept |
| 9 | The gate app's farmer list was sent uncompressed (648 KB at 5,000 farmers). | Low (slow on 2G) | **Fixed:** compression on all pages and app data (62 KB) |
| 10 | Dependencies were not checked for known vulnerabilities. | Medium | **Fixed:** CI fails on high or critical advisories in runtime dependencies |

### Accepted for the pilot (revisit before scaling)

| # | Item | Why accepted | Revisit |
|---|---|---|---|
| A | Database dumps on the server disk are not encrypted (off-site copies are). | Server access already gives database access; the disk is under Kitovu's control | Encrypt locally when moving to managed hosting |
| B | The USSD gateway proves itself with a secret key in the address, which can appear in proxy logs. | Africa's Talking does not sign requests | Add an allow-list of the gateway's IP addresses; rotate the key if exposed |
| C | No per-device revoke for the gate app. | Suspending the clerk signs them out on every phone | Add device revoke if more than 10 gate phones are in use |
| D | Delivery photos and the USSD log have no deletion date yet. | Needed as evidence during the pilot | Add retention (DPIA action 4) |
| E | Anthropic receives ID photos when AI checks are on. | Off until a key is set; advisory only | Needs a cross-border transfer basis first (DPIA) |

## Part 2: Brief for an independent penetration test

**Purpose:** confirm that no one can see or change farmers' data, stock or money beyond their role, before StorageX grows beyond the pilot.

**Target:** a staging copy of production (same build, synthetic data, no real farmers), at a staging domain Kitovu provides. Never test against production.

**Test accounts provided:** one per role (Kitovu super admin, operations, compliance, finance; warehouse clerk; field partner; lender credit officer and approver; a second lender), each with two-step sign-in set up, plus a test gate phone.

**In scope:**
1. Sign-in, two-step codes, sessions, password reset and invitations.
2. Access control across roles and organisations: a lender reading another lender's farmers, a clerk at warehouse A acting at warehouse B, a field partner seeing farmers outside their network.
3. Maker-checker bypass: approving one's own work through any route, including direct requests and race conditions.
4. Upload handling: the gate app's sealed records (tampering, replay, chain breaks), photo uploads (type, size, content), ID documents.
5. Public pages: receipt check and QR verification (forgery, enumeration), the signing key, the landing page, the partner application form.
6. Webhooks: USSD (`/ussd/at`), including PIN brute force and phone spoofing.
7. Downloads: CSV, PDF and file access by direct id.
8. Injection: SQL, HTML or script in every text field (farmer names are shown to lenders and in PDFs), and headers.
9. The server: TLS, exposed ports and services, file permissions under `/srv/storagex`, cron jobs, the backup path.

**Out of scope:** denial-of-service load, social engineering of staff or farmers, physical warehouses, third-party platforms (Termii, Africa's Talking, Anthropic, Google, Hostinger).

**Rules:** testing window agreed in writing; tester names and IP addresses given in advance. Stop and call the contact at once on finding real personal data or a critical issue. No data leaves the test environment.

**Report wanted:** each finding with steps to reproduce, impact and severity (CVSS), and a fix suggestion. A retest of fixed items is included in the engagement.

**Contact:** Nwachinemere Emeka, CEO, Kitovu Technology Company Limited.
