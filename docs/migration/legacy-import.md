# Legacy import (2021–22 StorageX)

Source: `storagex_laravel_portal.sql` from the old `heirmexxy/storagex` repo. All stock in it has been liquidated.

## What was imported, and how

- **Farmers:** names title-cased; phones to +234 format; crops read from the free-text produce field into commodity codes ("G/CORN" and "guinea corn" read as sorghum); state taken from the legacy registration hub; LGA set only where the address names one. Codes keep the legacy ID (`SXF-000113` was legacy farmer 113).
- **Duplicates:** three pairs with the same name and phone were merged into the lower legacy ID. Six farmers share a phone with someone of a different name; they stay separate (likely household phones).
- **Excluded:** legacy farmer 105 and the single legacy partner record are test entries.
- **Field partners:** the 77 accounts with the Agent role come in as `legacy_unverified`. No passwords or tokens were copied; each person must be re-invited.
- **Not imported:** the 5 admin and partner logins, every WealthX table (savings, investments, stock-up, bills, chat) and the 205 API tokens.
- **Warehouses:** Limawa (Minna) and Billiri (Gombe), both Kitovu-operated (Tier A) and set to `dormant` until someone confirms they are still leased. The Leadway policy number on Limawa is kept as an unverified policy.
- **Receipts:** the dump holds one receipt (1,006.20 kg of soybean at Billiri, 25 Feb 2022). It is imported as `closed`, with an `issued` and a `closed` event. The sale date and proceeds were never recorded.

## What the field team should check

The importer writes `out/data_issues.csv` with names (not committed). In summary:

| Entity | Result |
| --- | --- |
| Farmers in legacy dump | 103 |
| Farmers imported (active) | 99 |
| Merged exact duplicates (same name and phone) | 3 |
| Excluded test records | 1 |
| Active farmers flagged for review | 5 |
| Field partners imported (status legacy_unverified) | 77 |
| Legacy admin/partner accounts not imported | 5 |
| Warehouses imported (dormant, Tier A) | 2 |
| Receipts imported (closed) | 1 |

Active farmers by state: TA 93, AD 3, NI 2, GO 1.

## Issues needing review

| Issue | Count |
| --- | --- |
| farmer: state_conflict | 2 |
| farmer: phone_invalid | 1 |
| farmer: email_suspect_domain | 2 |
| field_partner: email_invalid | 1 |
| field_partner: phone_invalid | 1 |
| warehouse: status_unconfirmed | 2 |
| warehouse: profile_incomplete | 2 |
| insurance_policy: policy_unverified | 1 |

## Informational

| Note | Count |
| --- | --- |
| farmer: lga_missing | 96 |
| farmer: phone_shared | 6 |
| farmer: merged_duplicate | 3 |
| farmer: excluded_test_record | 1 |
| receipt: closed_on_import | 1 |
| receipt: quality_not_recorded | 1 |
| organisation: excluded_test_record | 1 |
