# Build order

Each build ends with a check that proves it works. Gates are joint reviews with the pilot lender.

| # | Build | Done when | Status |
| --- | --- | --- | --- |
| 0 | Schema, reference data, legacy import | Legacy farmers, agents, warehouses and receipt migrated to the standard | Done (Nov 2026) |
| 1 | Foundations: sign-in, mandatory two-step codes, organisation roles, audit log, money, tests, deploy and backups | Staff sign in with 2FA, roles are enforced, a deploy runs, a backup restores | Done (Nov 2026) |
| 2 | Registry: farmers, field partners, warehouses; tiered identity checks (maker-checker, provider slot); consent; lender level-2 confirmation; legacy review queue; public partner applications; SMS second step for low-risk roles; AI pre-check of ID photos; voice-call and witnessed alternatives to SMS, switchable in Settings | Field teams re-verify migrated farmers and register new ones | Done (Nov 2026) |
| 3 | Offline gate app (installable web app, old phones) with sealed evidence pack, AI reading of scale and moisture displays, delivery review | A delivery with no network becomes a synced intake record | Done (Nov 2026) |
| 4 | Receipt ledger, Receipt Passport (signed QR, verify page, PDF), split receipts, cancel | A scanned receipt shows its true status; history cannot be edited | Done (Nov 2026) |
| 5 | Stock control: stacks, ledger, releases, adjustments, counts, reconciliation, under-review switch | Physical counts reconcile to receipts | Done (Nov 2026) |
| 6 | Valuation: price sources with approval, median reference prices, lender policies (haircut, LTV), daily revaluation | Every receipt has a dated, explainable value | Done (Nov 2026) |
| 7 | Finance engine for any lender (Kitovu included): products, batches with the batch reviewer agent, lien lock, approval and disbursement by different people, repayments, margin watch, NCR file | Two lenders fund receipts; no receipt is pledged twice | Done (Nov 2026) |
| 8 | Settlement: sales with farmer agreement and lender approval, buyer payment matching, delivery, waterfall (fees, loan, farmer), payouts, statements | One full cycle from delivery to farmer balance paid | Done (Nov 2026) |
| 9 | Lender control tower: book with value and loan-to-value, needs-attention list, work queue, collateral sites, concentration, dry-run checklist, loan book download | The lender runs a dry run alone | Done (Nov 2026) |
| 10 | Farmer texts and USSD: every text from approved wording in the farmer's language and logged once; due and overdue reminders; USSD menu (PIN, produce, loans, sales, prices, call me back); PIN reset; call-back queue | Farmers know what is happening without calling | Done (Nov 2026) |
| 11 | Agents: intake inspector (checks each delivery against history; serious findings hold it until compliance clears it), data steward (daily registry sweep that opens and closes its own review items) | Suspicious intakes are held before issue | Done (Nov 2026) |
| 12 | Pilot hardening: security review, DPIA, off-site backups, UAT, SOPs | **Gate: pilot launch** | Next |
| 13–16 | WareGuard link, collateral watch, farmer assistant, lender and compliance agents | Gate: pilot review | |
| 17–21 | Partner warehouses, distribution API, ComboTrader pilot, buyer desk, second lender | Gate: second lender live | |
| 22–25 | Self-service onboarding, billing, Tier C/D, credit history, insurer portal, TradeChainX, public site | **Gate: public launch** | |
