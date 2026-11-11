# StorageX: user acceptance tests for the Accion pilot

**Pilot:** 2–3 warehouses, 1,000–5,000 farmers. **Where:** the live server with real staff accounts, before real farmers. Use test farmers (names beginning `TEST`) and a test lender product with small amounts. Afterwards, mark test farmers *excluded*. Do not delete them: the audit log keeps them.

**How to run:** each script names the role that runs it. Tick each step's result. A step fails if the result differs in any way: write what happened, take a screenshot, and stop that script. The pilot starts only when every script has passed and been signed.

**Roles:** Kitovu operations (Ops), Kitovu compliance (Comp), Kitovu finance (Fin), warehouse clerk (Clerk), field partner (FP), Accion credit officer (AO), Accion approver (AA).

### UAT-01 Sign-in and access (every role)
| # | Step | Expected |
|---|---|---|
| 1 | Open the invitation link, set a password, scan the code into an authenticator app | Account active; two-step sign-in required from then on |
| 2 | Sign in with a wrong code 3 times | Refused each time; account not opened |
| 3 | Open each menu group | Only the pages for your role appear (Accion: Control tower, Loans, Prices, Receipts) |
| 4 | Type the address of a page outside your role (e.g. `/admin/settings`) | "Not allowed" page |
| 5 | Leave the browser idle past the timeout, then click | Asked to sign in again |

### UAT-02 Registering a farmer and checking identity (FP, Comp)
| # | Step | Expected |
|---|---|---|
| 1 | FP registers TEST Farmer A with phone, state, community, crops | Farmer code issued (SXF-…) |
| 2 | Register TEST Farmer A again with the same phone | Warning about a possible duplicate |
| 3 | Confirm the phone by code (or by witnessed vouching if SMS is off) | Phone shows confirmed |
| 4 | Read the privacy notice and consent for Accion to the farmer; record consent with the witness | Consent listed on the farmer page |
| 5 | Upload ID photo and selfie, enter the NIN | Submitted; only the last 4 digits of the NIN are shown anywhere |
| 6 | Comp opens ID checks, ticks name, face and original ID, approves | Farmer level 1 |
| 7 | Register TEST Farmer B with the same NIN; Comp tries to approve | Refused: same ID already approved on Farmer A |

### UAT-03 Delivery at the gate, offline (Clerk on the pilot phone, Ops)
| # | Step | Expected |
|---|---|---|
| 1 | Install the gate app on the clerk's phone from `/intake/` | App opens; warehouses and farmers download |
| 2 | Turn on airplane mode. Record a delivery for Farmer A: weighings, moisture, photos of the scale, meter, bags and slip | Saved on the phone, waiting to send |
| 3 | Close the app, reopen it, turn the network back on | The delivery uploads once; reference shown |
| 4 | Ops opens Deliveries | Delivery listed with net weight worked out (gross − bags × tare) |
| 5 | Ops (not the clerk) accepts it | Accepted; stock appears on the named stack |
| 6 | Clerk records a second delivery reusing a scale photo from step 2 | Uploaded as **held**: "photo used twice" |
| 7 | Ops tries to accept it | Refused: compliance must clear it first |
| 8 | Comp clears it with a note; Ops accepts | Accepted; the clearance note shows on the delivery |

### UAT-04 Receipt (Ops, Farmer A's phone)
| # | Step | Expected |
|---|---|---|
| 1 | Issue the receipt for the accepted delivery | Receipt number and PDF with QR code |
| 2 | Farmer receives the text with the receipt number | Text received (if SMS is connected) |
| 3 | Scan the QR code on a phone that is not signed in | Public check page: valid, commodity, weight, warehouse; no farmer phone or ID |
| 4 | Change one character of the address and open it | "Not found" or "not valid" |

### UAT-05 Stock control (Clerk, Ops)
| # | Step | Expected |
|---|---|---|
| 1 | Count a stack: bags and a weighed sample | Estimate shown against the receipts on it |
| 2 | Record a count 3% short | Warehouse flagged for review in Stock and in the Accion control tower |
| 3 | Ops proposes an adjustment; a second Ops person approves | Adjustment recorded; receipts flagged "under check" until resolved |

### UAT-06 Loan (AO, AA, Fin)
| # | Step | Expected |
|---|---|---|
| 1 | AA sets the Accion valuation policy (haircut, loan-to-value) and the loan product (rate, term, warning and liquidation levels) | Saved; audit log shows who changed them |
| 2 | Kitovu sends a batch with Farmer A's receipt | Batch waiting in the Accion control tower |
| 3 | AO approves the request | Approved; AO cannot also record the payout |
| 4 | AA records the payout with Accion's reference | Loan disbursed; receipt pledged with a lien; farmer gets a text |
| 5 | Control tower | Loan shows amount owed, stock value and loan-to-value |
| 6 | Lower the reference price so loan-to-value passes the warning level; next day's revaluation runs | Loan listed under "Needs attention" |
| 7 | Record a part repayment, then the rest | Farmer texts for each; loan closed; lien released |
| 8 | Download the collateral registry file and the loan book | Both open in Excel; no formulas run |

### UAT-07 Sale and settlement (Ops, AA, Fin, Farmer)
| # | Step | Expected |
|---|---|---|
| 1 | Ops proposes a sale of a pledged receipt to a test buyer | Farmer receives an agreement code (or agrees in person with a witness) |
| 2 | Record the farmer's agreement; AA approves for Accion | Sale approved |
| 3 | Clerk loads the stock (a different person from the one who ordered it) | Receipt reduced by the weighed amount |
| 4 | Fin records the buyer's payment with the SL- reference | Matched to the sale automatically |
| 5 | Settle | Waterfall: Kitovu fees, then Accion's loan, then the farmer. Amounts add up to the payment exactly. |
| 6 | Fin marks the farmer's share paid | Farmer text; farmer statement shows the sale |

### UAT-08 Farmer self-service (Farmer A, Ops)
| # | Step | Expected |
|---|---|---|
| 1 | Dial the USSD code; choose a PIN | PIN saved |
| 2 | Dial again: My produce, My loans, Sales, Prices | Matches the system |
| 3 | Enter a wrong PIN 3 times | Locked for 24 hours |
| 4 | Ops resets the PIN with a note | Farmer gets a text; can choose a new PIN |
| 5 | "Ask Kitovu to call me" | Appears under Farmer messages; Ops marks it called |

### UAT-09 Data steward and audit (Comp)
| # | Step | Expected |
|---|---|---|
| 1 | Review queue → Check now | New items for any problems; nothing for clean records |
| 2 | Fix one (e.g. add a warehouse's capacity); Check now | That item closes by itself |
| 3 | Audit log: search for the payout in UAT-06 | Who, when, from where; the log's chain verifies |

### UAT-10 Backup and restore (Ops with the server administrator)
| # | Step | Expected |
|---|---|---|
| 1 | Settings → Connections | Last backup and off-site copy within 24 hours |
| 2 | Restore last night's backup into a throwaway database (`cli.mjs restore-check`) | Row counts printed; no errors |
| 3 | Download one file from Google Drive and confirm it cannot be opened without the passphrase | Unreadable |

### UAT-11 Pilot volume (Ops)
| # | Step | Expected |
|---|---|---|
| 1 | Import or register the pilot farmers (up to 5,000) | Farmers list pages through 100 at a time; search by name, code or phone is instant |
| 2 | Gate app first start on the clerk's phone over mobile data | Farmer list downloads in under a minute (about 60 KB compressed per 5,000 farmers) |
| 3 | Control tower with all pilot loans | Opens in under 2 seconds |

## Sign-off

| Script | Run by (role, name) | Date | Result | Signed off by (role, name) |
|---|---|---|---|---|
| UAT-01 | | | | Kitovu operations lead |
| UAT-02 | | | | Kitovu compliance lead |
| UAT-03 | | | | Kitovu operations lead |
| UAT-04 | | | | Kitovu operations lead |
| UAT-05 | | | | Kitovu operations lead |
| UAT-06 | | | | Accion credit approver |
| UAT-07 | | | | Kitovu finance lead and Accion credit approver |
| UAT-08 | | | | Kitovu operations lead |
| UAT-09 | | | | Kitovu compliance lead |
| UAT-10 | | | | Kitovu CEO |
| UAT-11 | | | | Kitovu operations lead |
| **Go-live** | | | | Kitovu CEO and Accion pilot sponsor |
