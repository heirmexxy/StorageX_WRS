# Decisions

Newest first. Each entry: the decision, then why.

## 2026-11-07 (Build 3)

1. **The gate app is a web page installed from the browser, not a Play Store app.** It is written in plain ES5 JavaScript (checked in CI-able form with esbuild's ES5 target) using XMLHttpRequest, IndexedDB, FileReader and canvas, so it runs on old Android phones. A service worker lets it reopen without network where the browser supports one (Chrome 40+); on older browsers the page keeps working while it stays open. Opera Mini's server-side mode cannot run it.
2. **A record cannot be edited once saved on the phone.** It is sealed with SHA-256 over its fields and the fingerprints of its photos, and chained to the previous record from the same phone (sequence number + previous seal). The server refuses a record whose seal or photos do not match, flags gaps in a phone's chain (records deleted before upload), and freezes the captured facts in the database. A wrong record is rejected and captured again. A determined insider could still rebuild a phone's records in the browser; the photo evidence, the AI display reading, the chain and the reviewer are what catch that.
3. **Clerks read numbers off displays, so every weighing and the moisture reading need a photo of the display.** An AI agent reads each display photo without being told the typed number; code compares them (0.5% for weights, 0.3 points for moisture) and a difference becomes a serious flag. It can be switched off in Settings.
4. **The farmer confirms at the gate** by a code on their phone when there is signal, otherwise by a signed or thumb-printed slip that is photographed. After upload the farmer gets a text with the weight and reference, so a wrong record is disputed early.
5. **Rules flag, a person decides.** Moisture over the crop's limit, recorded far from the warehouse, possible duplicate, farmer not identity-checked, phone clock drift, a gap in the phone's chain and a display mismatch are flagged; serious ones need a written reason to accept. The clerk can never accept their own delivery (enforced in the database). Accepted deliveries become receipts in Build 4.
6. **The phone keeps only what the gate needs about farmers**: code, name, community, identity level and the last 4 phone digits for search. Photos are shrunk to 1280 px and deleted from the phone once uploaded.

## 2026-11-07 (Build 2.1)

1. **An AI agent pre-checks every ID submission; a person still decides.** It reads the ID photo, the face photo and the record and reports: document type, legibility, name on the ID and whether it matches, the last 4 characters it can read, expiry, and signs of a copy, a screen or a non-live face photo. The green/amber/red flag is computed in code from those findings, not chosen by the model. It never writes out a full ID number (the code also keeps only 4 characters) and does not compare faces or identify anyone. Reasons it does not decide on its own: face matching from two phone photos needs a licensed liveness and face-match service, lenders will ask who approved each identity, and the NDPA gives people the right to human review of automated decisions that affect them significantly. Each human decision records whether it agreed with the flag, so its accuracy is measured. Auto-approval of green cases becomes possible once a paid provider adds NIN lookup and face match, with a random sample still reviewed by a person.
2. **Photos go to Anthropic's API for the pre-check.** It can be switched off in Settings or by `KYC_AI_MODE=off`. The farmer privacy notice must say so before the pilot.
3. **The phone check stays, but it never excludes a farmer.** The phone is where receipt, sale and payment messages and consent codes go; without a check an agent can register farmers on his own number. Methods are text code, voice-call code (any phone; low literacy) and, for farmers with no working phone or signal, an in-person attestation by the field partner and a named local witness whose phone Kitovu can call. Whether the step is required and which methods are on are switches in **Settings**, stored in the database and audited. Farmers without a confirmed phone give consent on paper.
4. **Text codes use Termii's DND route by default**, because the generic route does not reach numbers on the Do-Not-Disturb list.
5. **A phone on more than two farmer records is flagged to the reviewer.**

## 2026-11-07 (Build 2)

1. **Identity checks are tiered and work without a paid provider.** Level 0 is registered. Level 1 needs the farmer's phone confirmed by SMS code, a photo of an ID and a face photo, approved by a second Kitovu person (the database refuses a reviewer who is the submitter). Level 2 is a lender confirming it opened an account, which means its own BVN/NIN checks are done. A paid NIN lookup (Smile ID, Dojah or Youverify) plugs into `src/lib/kyc.ts` later and only adds a result to the review.
2. **Full ID numbers are never stored.** StorageX keeps a keyed hash (to catch one ID on two records) and the last 4 characters. Lenders give their own customer reference; a 10-digit number is refused as a likely account number.
3. **ID photos are encrypted on disk and seen only by Kitovu compliance.** Face photos also by Kitovu operations. Every opening is logged. ID photos are deleted after `ID_DOC_RETENTION_DAYS` (default 365) once approved, and both photos 30 days after a rejection; the decision stays. Backups archive the encrypted files with the database dump.
4. **Lenders see a farmer only after that farmer consents to that lender**, by an SMS code or a signed paper form (photo kept), read aloud first. Withdrawing consent hides the farmer from the lender at once. Lender views of a farmer are logged.
5. **Organisations can apply publicly; people still join only by invitation.** `/apply` collects applications; approving one creates the organisation (onboarding) and an invitation for its contact. Farmers do not apply online: they register through field partners.
6. **SMS codes are allowed as the second sign-in step only for low-risk roles** (no Kitovu staff, nothing that manages people, approves money, issues receipts or reviews identity). Gaining such a role switches SMS off and sends the person to set up an authenticator app.
7. **Phones are not unique.** A new farmer with the same phone and a similar name triggers a warning, not a block, because families share phones.
8. **Field partners added by a network wait for Kitovu verification** before farmers can be registered against them; legacy agents stay `legacy_unverified` until verified.
9. **Insurance counts only when a second Kitovu person verifies the policy**, and a warehouse cannot be certified or active without GPS coordinates and capacity.

## 2026-11-07 (Build 1)

1. **Two-step sign-in is mandatory for every account**, Kitovu staff and partners alike. Recovery codes are issued once; administrators can reset the second step, which signs the person out everywhere.
2. **No self-service sign-up or email reset yet.** People join by invitation link and recover by an administrator-issued reset link, shared over WhatsApp or email. Automatic email comes with a mail provider later.
3. **Kitovu roles reach every organisation; other roles only their own.** Nobody can grant a role carrying permissions they do not hold, and only a super admin can make another.
4. **Deploys are manual** (Actions → Deploy), always after the tests pass, with a database backup first. Tests run on every push.
5. **The audit log is append-only and hash-chained.** Kitovu administrators see the integrity check on the audit page; `cli verify-audit` runs it from the server.

## 2026-11-07

1. **StorageX is lender-agnostic, and Kitovu is one of the lenders.** Accion's requirements set the bar, but financing is a pluggable role: any approved lender (MFBs, banks, funds) and Kitovu's own balance sheet use the same loan, lien and settlement model. Each lender sees only what it finances.
2. **No trading inside StorageX.** StorageX exposes a distribution API. Partner platforms (ComboTrader first, TradeChainX next, others later) list eligible receipts to their users and handle the buying and selling. StorageX holds the record of ownership, locks receipts while they are offered, records transfers and settles.
3. **Receipt trading starts as an invite-only pilot behind a feature flag on ComboTrader**, following the Harvest Circles rollout: off by default, on for invited Champions. Counsel's opinion on ISA 2025 and the SEC registration circular should come before it opens wider.
4. **One active lien per receipt.** A receipt pledged to a lender cannot be offered for distribution until the lien is released.
5. **AI agents propose; people decide.** Agents follow the ComboTrader pattern: fixed executors, an approval inbox, full logs. No agent moves money, issues or releases a receipt, or changes a lien.
6. **Legacy data imported once, then frozen.** All 2022 stock was liquidated, so legacy receipts are closed records. Warehouses come in as dormant until confirmed.
7. **Postgres for the system of record**, with ComboTrader's conventions (Node 22, integer kobo, audit log), because lenders will audit the ledger.
