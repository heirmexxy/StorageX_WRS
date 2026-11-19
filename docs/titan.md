# Connecting Titan to StorageX

Titan (https://titan.kitovu.com.ng) is where WareGuard devices report. StorageX **reads** from Titan's API with a key
that **Titan issues**, and Titan **tells** StorageX of changes straight away by signed webhook. StorageX never sends
anything to the devices.

## What flows

| From Titan | Becomes in StorageX |
|---|---|
| Sites | Matched to warehouses: a site whose external reference is the warehouse code (e.g. `WH-OY-ISY-01`) links itself; otherwise by the same name, or chosen on the warehouse page |
| Devices on a linked site | WareGuard devices of that warehouse (Titan's device id, e.g. `WG-000123`) |
| Readings `air.temperature`, `air.humidity`, `security.door`, `power.battery_soc` | Readings on Stock watch, the dashboard and each warehouse; checked against **Settings → WareGuard limits** |
| Alerts `tamper`, `intruder_detected`, `power_lost`, `sensor_error` | WareGuard alerts with advice, sent to Kitovu, the warehouse operator and lenders with stock there |

Heat, damp, doors left open and silent devices are judged by StorageX against its own limits, so Titan's
`threshold`, `door_opened` and `device_offline` alerts are not duplicated. Produce moisture and other metrics stay in
Titan for now.

## Setting it up

1. **Titan admin → API keys:** make a key named "StorageX" with the scopes `read:readings`, `read:alerts` and
   `manage:webhooks`. It starts `tk_live_` and is shown once.
2. **Server:** add it to `/srv/storagex/.env` as `TITAN_API_KEY=tk_live_…`, then run the update script (it restarts
   the app).
3. **In Titan, each WareGuard site:** set its external reference to the StorageX warehouse code.
4. **Server, once:** `cd /srv/storagex && sudo -u storagex /opt/storagex-node/bin/node dist/cli.mjs titan-connect`.
   It checks the key, lists which sites matched, fetches the last day of readings, and subscribes StorageX's
   webhook (`https://storagex.com.ng/hooks/titan`) for `reading.created`, `alert.opened`, `alert.resolved`,
   `device.online` and `device.offline`. The webhook's signing secret is kept encrypted in the database.

After that the every-10-minutes job (`wareguard-sweep`) also fetches anything a webhook missed. Status shows in
**Settings → Connections**.

## Security

- Webhooks are checked against `X-Titan-Signature` (`t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`) and refused if
  more than 5 minutes old. Each event is handled once.
- The Titan key is read-only apart from managing StorageX's own webhook. If it leaks, revoke it in Titan, make a
  new one and run step 2 and step 4 again.

## The older push route

StorageX still accepts `POST /api/v1/wareguard/devices` and `/readings` with a StorageX key holding
`wareguard:write` (see the API documentation), for devices or partners that cannot go through Titan. Titan itself
does not need it.
