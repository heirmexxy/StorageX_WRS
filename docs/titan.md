# Connecting Titan to StorageX (Build 13)

Titan manages WareGuard devices. StorageX needs two things from it: which device is in which warehouse, and the
readings. Titan **pushes** both to StorageX's API; StorageX never calls Titan.

## 1. Get a key

A Kitovu administrator signs in to StorageX, opens **Finance → API keys**, and creates a key named "Titan" with only
the `wareguard:write` permission. Store it in Titan's secrets as `STORAGEX_API_KEY`. The key acts as the person who
made it; if that person leaves Kitovu, make a new key from another administrator's account.

## 2. Send devices when they are installed, moved or retired

```http
POST https://storagex.com.ng/api/v1/wareguard/devices
Authorization: Bearer sxk_…
Content-Type: application/json

{ "device_ref": "WG-0042", "warehouse_code": "WH-OY-ISY-01", "label": "Bay 2, north wall", "active": true }
```

`warehouse_code` is the StorageX warehouse code (shown on every warehouse page). Send `"active": false` to retire a
device. Sending the same device again updates it.

## 3. Send readings every 5–15 minutes

```http
POST https://storagex.com.ng/api/v1/wareguard/readings
Authorization: Bearer sxk_…
Content-Type: application/json

{ "devices": [
  { "device_ref": "WG-0042", "readings": [
    { "at": "2026-11-19T10:00:00Z", "temp_c": 27.4, "rh_pct": 63.1, "door_open": false, "battery_pct": 88 }
  ] }
] }
```

- `at` is when the reading was taken (ISO 8601, UTC). Readings from the future are ignored.
- Any field may be left out if the device does not measure it. `door_open` is `true` while a door is open.
- Resending the same reading is harmless (one per device per `at`), so after an outage Titan can resend its backlog:
  up to 500 devices and 2,000 readings per device per request.
- The answer is `{ "stored": n, "unknown_devices": [...] }`. An unknown device means it was never sent to step 2.

## What StorageX does with them

- Each batch is checked straight away against the limits in **Settings → WareGuard limits** (temperature, humidity,
  door open too long). Outside a limit, StorageX opens one alert per condition, writes advice for the warehouse team
  (the WareGuard explainer), and alerts Kitovu, the warehouse operator and every lender with stock pledged there. The
  alert closes itself when conditions are back inside the limits.
- Every 10 minutes StorageX marks devices that have sent nothing for longer than the offline limit.
- Receipt issuers may issue only where WareGuard is reporting (unless Kitovu has waived it for a pilot).
- Readings show on **Stock watch**, the **business dashboard** and the connections panel in **Settings**.

## Sample sender (Node 18+)

```js
const KEY = process.env.STORAGEX_API_KEY;
export async function pushReadings(devices) {   // [{ device_ref, readings: [...] }]
  const r = await fetch('https://storagex.com.ng/api/v1/wareguard/readings', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ devices }),
  });
  if (!r.ok) throw new Error(`StorageX ${r.status}: ${await r.text()}`);
  return r.json();
}
```
