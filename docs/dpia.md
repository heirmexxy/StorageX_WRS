# StorageX: Data Protection Impact Assessment (DPIA)

| | |
|---|---|
| Controller | Kitovu Technology Company Limited |
| Data protection contact | Nwachinemere Emeka, CEO (e.nwachinemere@kitovu.com.ng), until a Data Protection Officer is appointed |
| System | StorageX warehouse receipt system (this repository) |
| Scope | Accion Microfinance Bank pilot: 2–3 warehouses, 1,000–5,000 farmers |
| Law | Nigeria Data Protection Act 2023 (NDPA) and the NDPC's General Application and Implementation Directive 2025 (GAID) |
| Status | Draft for review, November 2026. Review again before the pilot goes beyond 5,000 farmers, before any new data recipient is added, and every 12 months. |

This assessment describes what the system does as built. It is not legal advice: have it reviewed by a licensed Data Protection Compliance Organisation (DPCO) before launch.

## 1. Why a DPIA is needed

StorageX holds identity documents and selfies of farmers, financial information (loans, sale proceeds), and location data from deliveries, for more than 200 people. The NDPA requires an impact assessment where processing is likely to result in high risk to data subjects. Identity documents, biometric-like photos and lending data in a rural population with low digital literacy meet that bar.

## 2. Registration and filings (actions)

| Action | Owner | When |
|---|---|---|
| Register Kitovu with the NDPC as a data controller of major importance. Processing more than 200 people in six months makes Kitovu one; a 1,000–5,000 farmer pilot is at least the Extra-High Level. A DPCO should confirm whether Kitovu's lending role puts it at the Ultra-High Level instead. | Data protection contact | Before the first farmer is registered for the pilot |
| Appoint a Data Protection Officer (can be an outsourced DPCO) and publish their contact. | CEO | Before launch |
| File the annual Compliance Audit Return (CAR) through a licensed DPCO. | DPO | Within 15 months of becoming a controller of major importance, then yearly |
| Sign a data processing agreement with each recipient in section 5. | DPO | Before data is shared with that recipient |
| Agree a data sharing agreement with Accion covering what Accion receives, why, and for how long. | CEO and Accion | Before the pilot |

## 3. People and data

| Who | Data | Why | Lawful basis |
|---|---|---|---|
| Farmers | Name, phone, sex, year of birth, community, state and LGA, crops | Register the owner of stored produce; contact them about it | Contract (storage and receipt) |
| Farmers | NIN or BVN: **only a salted hash and the last 4 digits are stored**, never the full number | Stop one person registering twice; match ID to person | Legal obligation (KYC for lending) and contract |
| Farmers | Photo of ID document and a selfie, encrypted on disk | Identity check by Kitovu compliance | Legal obligation and contract |
| Farmers | Deliveries: weights, quality, photos of the scale, moisture meter, bags and paper slip; GPS of the clerk's phone | Prove what was delivered, where and when | Contract; legitimate interest (fraud prevention) |
| Farmers | Receipts, liens, loans, repayments, sales, payouts | Warehouse receipt finance | Contract |
| Farmers | Lender's own customer reference (never a bank account number; 10-digit references are refused) | Lender pays the farmer | Contract |
| Farmers | Consent to share with a named lender, with the witness and evidence | Lender sees the farmer's receipts only with consent | Consent (withdrawable) |
| Farmers | Texts sent, USSD use (phone stored only as a keyed hash), call-back requests | Keep farmers informed; answer their questions | Contract; legitimate interest |
| Field partners | Name, phone, community | Register farmers on Kitovu's behalf | Contract |
| Staff and partner users | Name, email, phone, sign-in records, actions in the audit log | Access control and accountability | Contract; legal obligation |

**Not collected:** bank account numbers, full NIN or BVN, religion, ethnicity, health, or anything not needed for storage, finance and fraud control.

## 4. How long data is kept

| Data | Kept for | How it is removed |
|---|---|---|
| ID document photo (approved check) | 365 days after approval (`ID_DOC_RETENTION_DAYS`) | Daily job deletes the file; the decision, the hash and the last 4 digits remain |
| ID photo and selfie (rejected check) | 30 days | Daily job |
| Selfie (approved) | While the farmer is registered (it is the record's photo) | Deleted with the record on request, unless a live receipt or loan needs it |
| Delivery evidence photos | While the receipt is live, then 6 years with the receipt (financial record) | To be added: a retention date on delivery photos (open action, section 8) |
| Receipts, loans, sales, audit log | 6 years after the last transaction (accounting and lending records) | Archived, then removed |
| Backups | 30 days on the server and 30 days in Google Drive (encrypted) | Automatic |
| USSD log | 12 months | To be added (open action) |

## 5. Who receives data

| Recipient | What | Where | Safeguard |
|---|---|---|---|
| Accion Microfinance Bank (pilot lender) | Farmers who consented to Accion: name, code, receipts, value, loans | Nigeria | Consent per farmer and lender, withdrawable; data sharing agreement; lenders see only consenting farmers |
| Termii (SMS and voice) | Phone number and message text | Nigeria | Data processing agreement; texts contain no ID numbers or account details |
| Africa's Talking (USSD) | Phone number and the menu choices | Kenya and Nigeria (cross-border) | Data processing agreement; the PIN is checked by StorageX and never stored or logged in plain form |
| Anthropic (AI checks, **optional and off until a key is set**) | ID photo and selfie for the first look; photos of the scale and moisture meter; loan request summaries | United States (cross-border) | Turn on only after a cross-border transfer basis is in place under NDPA Part VIII (adequacy decision, standard contractual clauses or consent). AI only advises; a person decides. Each AI use can be switched off in Settings. |
| Google (backups) | Encrypted backup files | Outside Nigeria | Encrypted on the server before upload with passphrases Kitovu holds; Google cannot read them |
| Hostinger (server) | Everything | Per the chosen data centre | Disk and backups on Kitovu's server; ID photos encrypted at rest with a key derived from the server secret |
| NCR / collateral registry | Liens: farmer name, commodity, quantity, lender | Nigeria | Required to perfect the lender's security interest |

## 6. Risks and how they are handled

| Risk to farmers | Likelihood before controls | Controls in StorageX | Remaining |
|---|---|---|---|
| ID numbers leaked from a breach | High impact | Full numbers never stored (hash + last 4); ID photos encrypted at rest; photos deleted after 365 days | Low |
| Someone registers or borrows in a farmer's name | Medium | ID check by compliance with face match; one ID per person (database-enforced); phone confirmed by code or witnessed vouching; maker-checker on every money step | Low |
| Staff or partner sees more than their job needs | Medium | Role-based access per organisation; lenders see only consenting farmers; every file view and export is in a tamper-evident audit log | Low |
| Farmer does not understand what they consented to | Medium (low literacy) | Consent recorded per lender with a witness and evidence; farmers get texts about every event and can check status by USSD | Medium: train field partners to read the consent in the farmer's language (SOP 2) |
| Wrong data leads to a wrong loan or payout | Medium | Sealed delivery records; photos checked against typed numbers; intake inspector holds suspicious deliveries; reconciliation of stock against receipts | Low |
| Phone number reused by another person (SIM recycling) | Medium | Texts only to confirmed phones; USSD needs a PIN; PIN reset only by Kitovu after confirming the farmer | Low |
| Cross-border transfer without a lawful basis | Medium | AI checks off by default until a key is set; backups encrypted before leaving the server | Low once section 2 actions are done |
| Data kept longer than needed | Medium | Automatic deletion for ID photos and backups | Medium until the open actions below are done |

## 7. Farmers' rights

| Right | How it is met |
|---|---|
| To be informed | Privacy notice read to the farmer at registration (SOP 2); texts name StorageX |
| Access | Farmer statement from Kitovu or the field partner; USSD for produce, loans and payments |
| Correction | Field team edits the record; every change is audited |
| Withdraw consent to a lender | Recorded on the farmer's page; the lender loses access to new information at once, but existing liens stay until the loan is repaid |
| Erasure | Record marked excluded, photos deleted, unless a live receipt, lien or legal retention applies |
| Complain | To Kitovu's data protection contact, then to the NDPC |

A request is answered within 30 days. The DPO keeps a log of requests.

## 8. Open actions before launch

1. NDPC registration and DPO appointment (section 2).
2. Data processing agreements with Termii, Africa's Talking and Hostinger; a data sharing agreement with Accion.
3. Cross-border transfer basis for Anthropic before setting the AI key in production.
4. Add retention dates to delivery photos and the USSD log (small code change; Build 13 candidate).
5. Privacy notice for farmers in English, Pidgin, Hausa and Yoruba, approved like the text templates.
6. Breach response: notify the NDPC within 72 hours of becoming aware of a breach likely to affect farmers' rights (SOP 12).

## 9. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Data protection contact | Nwachinemere Emeka | | |
| DPCO / external reviewer | | | |
| Accion data protection officer (for the pilot) | | | |
