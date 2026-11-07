# Data standard

Every record in StorageX WRS follows these rules. The schema enforces most of them; the rest are enforced in the API.

| Field type | Rule | Example |
| --- | --- | --- |
| Internal IDs | UUID. Never shown to users, never in URLs people can guess | `2b1f…` |
| People-facing codes | Prefix plus zero-padded number, unique | Farmer `SXF-000113`, field partner `SXA-00004` |
| Warehouse codes | `WH-<state>-<site>-<nn>` using ISO 3166-2:NG state codes | `WH-GO-BLR-01` |
| Receipt numbers | `SX-<state>-<site>-<YYMMDD>-<seq>` | `SX-GO-BLR-220225-0001` |
| Receipt verification | Random 128-bit `verify_token` in the QR code; the public check shows status, never personal data | — |
| Money | Integer kobo (₦1 = 100 kobo). No floats anywhere | ₦360/kg = `36000` |
| Weight | Kilograms, two decimals. Bags are a separate count | `1006.20` |
| Phone | E.164 (`+234…`). Not unique: households share phones | `+234XXXXXXXXXX` |
| Email | Lower-case, validated; suspect domains (e.g. `ail.com`) are not stored until confirmed | — |
| Location | State by ISO code; LGA from the official list; community and address as given | `TA`, Karim Lamido |
| Commodities | Three-letter codes from `commodities`; a farmer's crops are a list of codes | `{RCE,MAZ}` |
| Time | `timestamptz`, stored in UTC; legacy local times are read as Africa/Lagos (+01:00) | — |
| Identity numbers | BVN and NIN are verified through a KYC provider and never stored in StorageX; only the result is kept | `kyc = verified` |
| Deletion | Never hard-delete. Use `status` with a reason; duplicates become `merged` and point to the kept record | — |
| Receipt history | Every change is a row in `receipt_events`: append-only, numbered, hash-chained | — |
| Provenance | Imported rows keep their origin in `legacy` (JSON) and any problems in `data_issues` | — |
| Distribution | A receipt can be offered to partner platforms only when it is `issued`, has no active lien, and `distribution_enabled` is on | — |
