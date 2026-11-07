# Decisions

Newest first. Each entry: the decision, then why.

## 2026-11-07

1. **StorageX is lender-agnostic, and Kitovu is one of the lenders.** Accion's requirements set the bar, but financing is a pluggable role: any approved lender (MFBs, banks, funds) and Kitovu's own balance sheet use the same loan, lien and settlement model. Each lender sees only what it finances.
2. **No trading inside StorageX.** StorageX exposes a distribution API. Partner platforms (ComboTrader first, TradeChainX next, others later) list eligible receipts to their users and handle the buying and selling. StorageX holds the record of ownership, locks receipts while they are offered, records transfers and settles.
3. **Receipt trading starts as an invite-only pilot behind a feature flag on ComboTrader**, following the Harvest Circles rollout: off by default, on for invited Champions. Counsel's opinion on ISA 2025 and the SEC registration circular should come before it opens wider.
4. **One active lien per receipt.** A receipt pledged to a lender cannot be offered for distribution until the lien is released.
5. **AI agents propose; people decide.** Agents follow the ComboTrader pattern: fixed executors, an approval inbox, full logs. No agent moves money, issues or releases a receipt, or changes a lien.
6. **Legacy data imported once, then frozen.** All 2022 stock was liquidated, so legacy receipts are closed records. Warehouses come in as dormant until confirmed.
7. **Postgres for the system of record**, with ComboTrader's conventions (Node 22, integer kobo, audit log), because lenders will audit the ledger.
