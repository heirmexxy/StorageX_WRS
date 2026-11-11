# StorageX: standard operating procedures (pilot)

Short procedures for the people who run StorageX day to day. Each says who does it, when, and what "done" looks like. The system enforces the two-person steps; these procedures cover what happens around them.

## SOP 1: Daily checks (Kitovu operations, every working morning)
1. **Admin → Settings → Connections:** last backup and off-site copy are under 24 hours old. If not, call the server administrator (SOP 11).
2. **Stock → Held deliveries:** none older than 1 working day. Chase compliance (SOP 4).
3. **Stock → Deliveries → To review:** clear everything delivered yesterday (SOP 3).
4. **Admin → Review queue:** work blockers first, then review items. Resolve by hand only if the item is not a problem.
5. **Farmers → Farmer messages:** call back everyone waiting; note what was done. Look at texts that did not go.
6. **Finance → Control tower:** loans past the warning level or overdue; agree next steps with the lender the same day.

## SOP 2: Registering a farmer (field partner or Kitovu field staff)
1. Register only in the farmer's presence. Use their own phone number, never yours. The data steward flags a field partner's number on farmer records.
2. Confirm the phone by code. With no signal or no phone, use witnessed vouching: you and a named local witness who is not your relative.
3. Read the privacy notice to the farmer in their language: what is kept, who sees it, how long, how to complain. Then read the lender consent for each lender. Record consent only if the farmer says yes.
4. Photograph the original ID (not a photocopy) and take a selfie in good light. Type the NIN exactly; the system keeps only the last 4 digits.
5. Never write a farmer's NIN, BVN or bank details on paper or in a chat message.

## SOP 3: Receiving a delivery (warehouse clerk, then Kitovu operations)
1. Weigh every lot on the calibrated scale. Photograph the scale display for each weighing, the moisture meter display, the bags on the stack, and the signed paper slip.
2. Type the numbers exactly as the display shows them. The AI and the inspector compare them.
3. Name the stack where the bags are placed.
4. Upload as soon as there is signal. Do not uninstall the app or clear browser data while deliveries are waiting.
5. **Operations review** (someone other than the clerk): check the photos against the numbers and accept, hold with a reason, or reject. A wrong record is rejected and recorded again. Records cannot be edited.

## SOP 4: Clearing a held delivery (Kitovu compliance)
1. Read why it is held (photo used twice, farmer at two warehouses, over capacity, numbers not matching the photos, far from the warehouse, possible duplicate).
2. Investigate: compare the photos, call the farmer on their confirmed number, call the clerk, and check stock if needed.
3. **Genuine:** clear it with a note saying what you checked. Operations then accept it.
4. **Not genuine:** tell operations to reject it. Open an incident (SOP 12) if fraud is suspected, and suspend the clerk's access until it is resolved.

## SOP 5: Identity checks (Kitovu compliance)
1. Approve only when the name matches, the face matches, and the ID is an original. Tick all three.
2. When unsure, reject with the reason. The farmer can submit again.
3. An AI flag is advice. Decide on what you see.

## SOP 6: Issuing a receipt (Kitovu operations)
Issue only for accepted deliveries from farmers at level 1 or above. Give the farmer the receipt number and show them the QR check page. A wrong receipt is cancelled with a reason, never edited.

## SOP 7: Stock counts (warehouse clerk; operations reviews)
1. Count every stack at least every 30 days (Settings), and whenever a lender asks.
2. Count all bags, weigh a sample of at least 5 bags, and record both.
3. Shortfalls beyond tolerance: operations investigates the same day, then proposes an adjustment for a second person to approve. Tell the affected lender.

## SOP 8: Releasing stock (Kitovu operations orders; clerk loads)
1. Release only on an order in StorageX. A pledged receipt can only be released through a lender-approved sale or after repayment.
2. Check the collector's ID against the order. Weigh what leaves, and photograph the loaded truck.
3. The farmer gets a text. If they say the release was not theirs, start SOP 12 at once.

## SOP 9: Loans (lender; Kitovu finance supports)
1. Kitovu sends requests in batches. The lender decides each one; a different lender user records the payout with the lender's own reference.
2. Lenders work from the control tower: warning and liquidation levels, overdue loans, and stock checks at each warehouse.
3. Download the collateral registry file after each batch of payouts and file the liens.

## SOP 10: Sales and settlement (Kitovu operations and finance)
1. The farmer agrees by code or in person with a witness. The lender approves if the stock is pledged.
2. The buyer pays into Kitovu's collection account quoting the SL- reference.
3. Settle only matched payments. Pay out in the order shown: Kitovu fees, then the lender's loan, then the farmer. Mark each payment with its bank reference.

## SOP 11: Backups and restore (server administrator)
- Backups run nightly at 02:15. An encrypted copy goes to Google Drive and is kept for 30 days; a restore test runs every Sunday. Check the logs in `/srv/storagex/data/backups` weekly.
- **Restore a backup:**
  1. Stop the app: `sudo systemctl stop storagex`.
  2. Get the backup: from `data/backups`, or from Drive with `rclone copy storagex-offsite: /srv/storagex/data/restore`.
  3. Restore the database: `pg_restore --clean --if-exists --no-owner -d storagex <file>.dump`.
  4. Restore uploads: `tar -xf <file>.uploads.tar -C /srv/storagex/data`.
  5. Make sure `.env` has the same APP_SECRET as before, then start: `sudo systemctl start storagex`.
  6. Sign in and check the latest receipts and the audit log.
- Keep the `.env` copy and the two backup passphrases in two separate safe places. Without them, backups and ID photos cannot be read.

## SOP 12: Incidents (anyone reports; the CEO and data protection contact lead)
1. Report at once to Kitovu operations and the data protection contact: suspected fraud, wrong release, lost phone with the gate app, leaked password, unexpected data exposure.
2. Contain: suspend the user (Admin → People). That signs them out everywhere, including a lost gate phone. Restore access later on a new phone, and change server keys if needed.
3. Assess within 24 hours: what data, how many farmers, which lender.
4. **Personal data breach likely to harm farmers:** notify the NDPC within 72 hours of becoming aware, and tell the affected farmers in plain language. Tell Accion the same day.
5. Record what happened, what was done and what changes. Review it at the next weekly meeting.

## SOP 13: Joiners, movers and leavers (Kitovu operations with the CEO)
1. Access by invitation only, with the least role needed. Staff are never given super admin.
2. Change a role the same day someone's job changes. Remove access on someone's last day.
3. Monthly: review "Accounts unused for 90 days" in the review queue, and remove access that is no longer needed.
