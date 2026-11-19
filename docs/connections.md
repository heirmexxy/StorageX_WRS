# Connecting the outside services (Build 14)

Every connection is optional: StorageX works without it, and the **Settings → Connections** panel shows what is
connected and what each one affects. Each is switched on by adding its keys to `/srv/storagex/.env` on the server,
then restarting (`sudo systemctl restart storagex`). Keys never go in git.

| Service | Keys in .env | Set on the provider’s side | What it switches on |
| --- | --- | --- | --- |
| SMS through Termii | `TERMII_API_KEY`, `TERMII_SENDER_ID` | Register the sender ID | Phone codes, farmer texts, voice codes |
| SMS through Africa’s Talking (instead) | `SMS_PROVIDER=africastalking`, `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | Register the sender ID | Farmer texts through Africa’s Talking (voice codes stay on Termii) |
| Incoming texts | `SMS_INBOUND_KEY` (any long random text) | Incoming-message callback: `https://storagex.com.ng/sms/inbound?key=<SMS_INBOUND_KEY>` on a two-way number or shortcode | Farmers text BAL, KUDI, OWO or EGO and get what their produce is worth and what they owe |
| USSD | `USSD_KEY` | Callback `https://storagex.com.ng/ussd/at?key=<USSD_KEY>`; then enter the code in Settings | The USSD menu |
| Paystack | `PAYSTACK_SECRET_KEY` | Webhook `https://storagex.com.ng/hooks/paystack`; turn **off** OTP for transfers; fund the Paystack balance for payouts | Farmer payouts (two people: one asks, another approves) and buyer payment links |
| Dojah (identity) | `DOJAH_APP_ID`, `DOJAH_SECRET_KEY`, and `KYC_PROVIDER=dojah` | Fund the wallet; check the NIN and BVN endpoints in the sandbox first | NIN match at identity review; BVN check on the farmer page |
| Live price feed | `PRICE_FEED_URL`, optionally `PRICE_FEED_TOKEN` | A JSON address (format below) | New prices each morning, waiting for a person to approve |

## What is never stored

- **Bank accounts:** Paystack checks the account and returns the name the bank holds; StorageX keeps Paystack’s
  recipient code, the bank name and the last four digits. The account number is used once and dropped.
- **BVN and NIN:** StorageX keeps the result (match, partial, no match, not found), a keyed hash and the last four
  digits. Not the number, and not the record the provider returns (names, date of birth, photo).
- **Provider webhooks:** only an event key to ignore repeats; not the payload.

## Payouts, step by step

1. Kitovu finance saves the farmer’s account once, on the farmer’s page (bank and account number). If the bank’s name
   for the account does not match the farmer’s, it is refused unless finance writes why.
2. After a sale is settled, finance presses **Pay by Paystack** on the farmer’s line.
3. A different person in finance (not the one who asked, nor the one who settled the sale) presses **Approve and send**.
4. Paystack’s webhook marks the line paid when the bank confirms, or shows why it failed so it can be asked again.

Lenders are still paid by bank transfer and recorded with **Mark paid**.

## Price feed format

```json
{ "prices": [
  { "commodity_code": "MAZ", "state_code": "OY", "market": "Bodija market", "observed_on": "2026-11-19", "naira_per_kg": 610 },
  { "commodity_code": "SBN", "state_code": null, "market": "National average", "observed_on": "2026-11-19", "kobo_per_kg": 72000 }
] }
```

Commodity and state codes are StorageX’s (Admin → Commodities). Rows older than 30 days, unknown codes and
impossible prices are skipped. Reading the same row twice adds nothing.

## Dojah endpoints

StorageX calls `GET /api/v1/kyc/nin?nin=…` and `GET /api/v1/kyc/bvn/full?bvn=…` with the `AppId` and
`Authorization` headers, and compares the first and last names returned with the farmer’s registered name.
Confirm both endpoints in Dojah’s sandbox when the account is opened; if Dojah’s answer differs, only
`src/lib/identity.ts` needs changing.
