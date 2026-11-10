# Decisions

Newest first. Each entry: the decision, then why.

## 2026-11-11 (Build 11)

1. **The intake inspector compares each delivery with everything before it.** Checks: a photo already used on another delivery; the same farmer at another warehouse within 6 hours; more stock than the warehouse holds; six or more records from one clerk within 15 minutes; scale readings identical to another farmer's delivery; the same moisture typed ten times running; far more than the farmer usually brings, or over 30 tonnes in 30 days (Settings); night-time capture; all-round readings. Each finding is explained in plain words. Rules are in code, so every hold can be explained to a farmer, a clerk or an auditor; the AI's part stays the display reading from Build 3.
2. **Serious findings put the delivery on hold automatically**, and so do the serious per-record flags from Build 3 (moisture over limit, far from the warehouse, possible duplicate, missing records from the phone). A held delivery needs **compliance** to look into it and clear it with a written note, then **operations** to accept it: two people besides the clerk, in two roles. The database refuses an accepted delivery with an uncleared serious flag, and a clearance cannot be removed once given.
3. **Late findings** (for example an AI reading that finishes after acceptance) are shown for follow-up but cannot undo an acceptance.
4. **The data steward runs daily** (and on demand from the review queue). It finds likely duplicate farmers, single names, missing states, farmers with stock but no confirmed phone, deliveries waiting on identity checks, inactive farmers owning stock, field partners whose phone is on farmer records, warehouses with no location, capacity, insurance or recent count, and accounts unused for 90 days. It opens one review item per problem, closes it when the problem is gone, and does not raise again something a person has marked as not a problem.

## 2026-11-11 (Build 10)

1. **One place sends every farmer text**, from wording Kitovu can edit, and logs each one (sent, failed, or skipped with the reason). The same message is never sent twice for the same event. Texts go only to confirmed phones.
2. **Texts about deliveries, receipts, releases, loans and payments always go**: they are how a farmer spots a mistake or fraud. Only due-date reminders can be switched off, for everyone in Settings or for one farmer.
3. **Translations need a second person.** Kitovu staff propose wording for Pidgin, Hausa, Yoruba or Igbo; someone else approves it. The wording must keep the amounts and references the farmer needs to check, and must say it is from StorageX. Until a language is approved, those farmers get English. StorageX ships English only, because a wrong translation of a money message is worse than English: translations should come from native speakers on the team.
4. **Reminders** go a set number of days before a loan is due (7 by default) and the day after it is missed, once each, only while something is owed.
5. **USSD (Africa's Talking format)** lets any phone check produce, loans, sales and prices, and ask Kitovu to call back. It is in English for now (screens are short and fixed). The farmer chooses a 4-digit PIN the first time (easy ones refused); three wrong PINs lock it for 24 hours. Only Kitovu operations staff can reset a PIN, with a note on how they confirmed it was the farmer; the farmer gets a text when it happens. The PIN, the keypad text and the phone number are never logged.
6. **A shared family phone** shows a choice of whose record, then that person's PIN.
7. **The gateway is trusted only through a secret key in its address**; without the key, USSD is off in production.

## 2026-11-07 (Build 9)

1. **Lenders start in a control tower**, not the loans list. It answers, in order: what we are owed and what stands behind it; what needs a decision today; which loans are past the lender's own warning or liquidation level, overdue, without a price, or due within 14 days; where the stock is and whether its warehouse checks are clean; and how concentrated the book is by warehouse, crop and state.
2. **Values are worked out live** from the same reference prices and loan entries as the rest of the system, so the tower never disagrees with a loan or receipt page. Loan-to-value uses what is owed today (principal, fees, interest), not the amount lent.
3. **Warehouse health is shown to the lender** for warehouses holding its collateral: insurance on record, date of the last count, reconciliation holds and receipts under review. A lender can see a problem without asking Kitovu.
4. **The dry-run checklist is computed from real records** (two approvers, a valuation policy, a product, a confirmed farmer account, a decided request, a disbursement, a repayment, the registry file downloaded). It disappears once complete. This is the "done when" for Build 9.
5. **The loan book downloads as CSV** for the lender's own systems; each download is audited. Kitovu sees the same tower across all lenders.
6. Found and fixed while testing: file downloads could write a response twice and crash the server. Downloads now go through one helper.

## 2026-11-07 (Partner types)

1. **Thirteen partner types in four groups**, each stating what the partner brings and gets: finance and trade (lender, buyer or processor, trading platform, insurer); storage and the field (warehouse owner, field agent network, co-operative); services (input supplier, transporter, inspector or collateral manager, payments provider); programmes and government (development partner or guarantee fund, government agency).
2. **Partner type is separate from account type.** The seven that use StorageX directly get an organisation and an administrator invitation on approval; the others are approved for the partnerships team to agree terms, with no account until there is an integration for them.
3. The landing page lists every type with its own link (`/apply?type=…`), which opens the form with that type chosen.

## 2026-11-07 (Build 8)

1. **Kitovu arranges sales; owners agree; lenders approve.** A sale covers receipts of one crop at one warehouse (several farmers can sell together to one buyer). Each farmer agrees to the price by a code to their phone (text or voice) or a photographed signed slip; a lender holding a pledge approves the sale. Only then are the receipts committed ("Being sold" on the public page) and stock can be delivered.
2. **Buyers pay Kitovu's collection account quoting the sale reference.** Finance records each payment; one whose reference contains the sale reference and fits the amount due matches by itself. Matching by hand needs someone other than the person who recorded it. Overpayments are refused onto a sale.
3. **Delivery to the buyer uses the Build 5 release** (ordered by one person, weighed out by another with scale and slip photos). The receipt stays "being sold" until settlement.
4. **Settlement waterfall, per receipt:** Kitovu storage (per kg per month, from issue to settlement), handling (in and out) and sale commission, then the lender's loan (posted as a repayment from the sale; the loan closes if covered), then the farmer's balance. A loan secured by several receipts is paid from them in turn. A shortfall is shown and stays owed to the lender. Fees are in Settings (defaults: 300 kobo/kg/month, 100 kobo/kg each way, 1.5%), to be confirmed with finance.
5. **Settling requires full payment and full delivery**, by a finance person who did not arrange the sale. It releases the pledges and closes the receipts as "settled", each with an event in its history.
6. **Payouts** to lenders and farmers are recorded with transfer references by someone other than the settler; the farmer gets a text.
7. **Farmer statement** (deliveries, receipts, loans, sales with the waterfall, paid and waiting) is a printable page for Kitovu and the farmer's own network.

## 2026-11-07 (Landing page)

1. **The public home page is a StoryBrand page for lenders.** Hero: the lender. Problem: three questions rural lending cannot answer (is the stock there, has someone else lent against it, what is it worth today), and the farmer selling at harvest as the reason it matters. Guide: Kitovu, with the specific controls as authority rather than slogans. Plan: three steps. Calls to action: "Apply to partner" (direct) and "See a sample receipt" (transitional). Stakes and success side by side. Short sections for warehouse owners, networks and farmers.
2. **No claims we cannot back.** No partner logos, statistics or testimonials until they are real and agreed; the hero receipt is labelled as an illustration and `/sample-receipt` as a sample.
3. Plain CSS, no web fonts or scripts (fast on weak networks, nothing third-party). Signed-in people at `/` go to their home page.

## 2026-11-07 (Build 7)

1. **Any lender, Kitovu included.** Lenders (and Kitovu, lending from its own balance sheet) define products: interest per month (simple, daily), one-off fee, tenor, amount range, crops, the identity level needed before disbursement (default level 2: account opened with the lender), and warning and liquidation levels for loan ÷ stock value.
2. **Kitovu prepares batches of requests** (farmer, receipts, amount) for one lender's product. Amounts are capped by what the receipts support under that lender's valuation policy today, rechecked at submission and again at approval. A receipt can sit in only one pending request. External lenders need the farmer's consent on record.
3. **Four different hands:** Kitovu prepares; a lender credit officer (never the preparer) approves or rejects each line, approving the amount asked or less; approval pledges the receipts; a different lender person records the disbursement (the database refuses the approver), with the transfer reference only. Approved-but-unpaid loans can be cancelled, releasing the receipts.
4. **One active lien per receipt**, enforced by a unique index. Pledged and financed receipts cannot be released, cancelled or put in another request; their public page says "pledged to a lender".
5. **Money on a loan is an append-only list** (disbursement, fee, repayment, waiver). Interest is calculated from it, never stored. Payments go to fees, then interest, then principal. Kitovu finance can record a repayment it collected; only the lender can waive. When nothing is owed the loan closes and the receipts return to their earlier status.
6. **Margin watch**: loans past the warning level, the liquidation level, overdue, or without a usable price are listed for the lender and Kitovu. (Enforcement and sale come in Build 8.)
7. **National Collateral Registry file**: the lender downloads a CSV of its active liens with debtor, collateral and amounts. StorageX holds no BVN/NIN, so the lender adds the identity number from its own records; its customer reference is included.
8. **Batch reviewer agent** (first agent of the Build 11 set, brought forward): fixed checks in code for every line (identity, consent, loan-to-value, price evidence, warehouse status and insurance, stock reconciliation, loan history, concentration), plus an optional AI note for the credit officer written only from those checks. It never decides or changes an amount.

## Where AI agents sit

Agents read, check and draft; people decide. No agent moves money, issues or releases a receipt, changes a lien or approves anything. Each is switchable in Settings, logs what it saw, and its advice is compared with the human decision so its accuracy is measured.

- In place now: ID pre-check (Build 2.1), scale and moisture display reader (Build 3), batch reviewer (Build 7).
- Next: intake inspector (patterns across deliveries: same clerk, odd weights, duplicates), data steward (cleans and merges farmer records), margin agent (drafts margin-call messages), farmer assistant on SMS/USSD/WhatsApp (answers "what is my receipt worth, what do I owe"), lender assistant (portfolio questions in plain English), compliance agent (NCR filing and reports prepared for sign-off).

## 2026-11-07 (Build 6)

1. **Prices come from named sources and need a second person.** Kitovu finance or operations enter a price (crop, state, market, source, price as quoted, date, optional evidence); someone in Kitovu finance other than the enterer approves it. A price more than 25% (Settings) away from the current reference needs a written explanation.
2. **Reference price = median of approved prices over the last 14 days** (Settings), for the warehouse's state when there are at least 2 (Settings), otherwise national, otherwise no value. Median, not average, so one odd quote cannot move it.
3. **Value is explained line by line:** market value = kg still held × reference price; after haircut (price-fall and quality risk); maximum loan = that × loan-to-value. The haircut rounds up and the advance rounds down, so rounding never over-lends. The receipt page lists the exact prices used.
4. **Kitovu sets a default policy per crop (15% haircut, 70% loan-to-value to start); each lender can set its own**, and sees values under its own policy. Warehouse staff do not see values. The public Receipt Passport shows no value.
5. **Every live receipt is valued every morning** (`revalue`, 05:15 cron) into an append-only daily table with its basis; running it twice in a day changes nothing. A price fall of more than 10% (Settings) since the last valuation is reported; in Build 7 it feeds margin alerts on loans.

## 2026-11-07 (Build 5)

1. **One append-only stock ledger** (`stock_moves`): accepted deliveries in, releases out, moves between stacks, approved adjustments. Balances are sums; nothing is edited. Deliveries go onto the stack the clerk named (created if new), otherwise they wait as "not on a stack" until placed.
2. **Releases against receipts are two-person.** Kitovu orders a release (amount, reason, the collector's name); someone else at the warehouse weighs it out, photographs the scale display and the signed release slip. The weighed amount may differ from the order by 0.5% (at least 1 kg); the receipt is reduced by what actually left. Fully withdrawn receipts close. The farmer is texted with what left and what is still held. The public page shows "Partly withdrawn" and the weight still held.
3. **Losses and corrections are proposed, then approved by a different Kitovu person** before they touch the ledger. Only a recount correction can add stock.
4. **Counts are bags counted plus a weighed sample** (or, without a sample, the ledger's average bag weight). A count is carried forward by any moves on its stack since it was taken.
5. **Reconciliation per warehouse and crop** compares the ledger, what receipts still claim, and the counts. Serious flags: receipts claim more than the ledger holds, or counts fall short of receipts by more than the tolerance (Settings, default 1%). Review flags: stock not on a stack, stacks not counted within the interval (Settings, default 30 days).
6. **Stock in doubt freezes trust, not data.** Kitovu can put every valid receipt for a crop at a warehouse "Under review"; the public page says so and releases stop until the review ends, which restores each receipt's previous status. Both steps are events in each receipt's history.
7. Counts and releases are on the main site (works on a phone browser with signal). Offline counts in the gate app can follow if sites need them.

## 2026-11-07 (Build 4)

1. **Receipts come only from accepted deliveries**, issued by Kitovu staff with receipt-issuing rights who did not record the delivery. Blocked when the farmer is not identity-checked (level 1), the warehouse is not certified or active, the warehouse is Tier D, or moisture is above the crop's limit (dry, re-test, record again).
2. **A delivery can be split into up to 10 receipts** (equal parts or given weights) so a farmer can pledge or sell part of the stock. Weights and bags must add up exactly.
3. **Receipt facts are frozen in the database; changes of state are events in a hash chain.** `receipt_events_verify()` recomputes the chain; the receipt page and the public page show the result. Only status, ownership, closing details, valuation and the distribution switch can change, and each change is an event.
4. **Receipts are signed with Ed25519** over number, verify token, commodity, net weight, warehouse and issue time. The key is derived from `APP_SECRET`; the public key is at `/.well-known/storagex-receipt-key.json` so partners (ComboTrader, TradeChainX, lenders) can check a QR offline. Changing `APP_SECRET` changes the key, so treat it as permanent.
5. **The Receipt Passport (`/r/<token>`) is public**: live status in plain words, produce, weight, warehouse, insurance on record, owner as initials and farmer code only, and the event history without names. If the QR's signature does not match, or the history fails its check, the page says so in red. The token is random, never the receipt number. Rate-limited, not indexed.
6. **The PDF is a copy, not the receipt.** It says so, shows the status at printing and carries the QR. Every print is logged.
7. **Cancelling** is only for a receipt still `issued` (no loan or sale), by someone other than the issuer, with a reason that stays internal.
8. **Lenders see receipts of farmers who consented to them** (pledged receipts join in Build 7); warehouse operators see their warehouses' receipts; networks and co-operatives see their farmers'.

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
