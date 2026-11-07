# Putting StorageX on your Hostinger VPS

The setup script is the ComboTrader one, adapted: it is safe on a server that already runs other sites, looks first, and changes nothing until you type YES. StorageX runs as its own Linux user in `/srv/storagex`, on an internal port (3200–3299), with its own PostgreSQL database. Do one step at a time.

## Step 1 — Snapshot the server
hPanel → **VPS → Snapshots & backups → Create snapshot**. You can restore the whole server to this moment if anything goes wrong.

## Step 2 — Add the DNS record
hPanel → **Domains → kitovu.com.ng → DNS records → Add record**: type **A**, name **wrs-beta**, points to your VPS IP. (Use another name if you prefer; pass it as `HOST=` below.)

## Step 3 — Look before changing anything
1. Connect: `ssh root@YOUR_VPS_IP` (or hPanel's **Browser terminal**).
2. The repository is private, so copy the script by hand: open `deploy/setup.sh` on GitHub → **Raw**, copy everything, then on the server run `nano setup.sh`, paste, and save (Ctrl+O, Enter, Ctrl+X).
3. Run `HOST=wrs-beta.kitovu.com.ng bash setup.sh --check` and read the report. Nothing is changed. Send it to me if anything looks surprising.

## Step 4 — Install
1. Run `HOST=wrs-beta.kitovu.com.ng bash setup.sh` and type `YES`.
2. When it pauses with a key starting `ssh-ed25519`: GitHub → **heirmexxy/StorageX_WRS → Settings → Deploy keys → Add deploy key**, title "Hostinger VPS", write access **off**. Paste, save, then press Enter on the server.
3. It installs PostgreSQL if the server does not have it, creates the `storagex` database, builds the app, runs the migrations, starts the service, configures your web server and schedules backups.

## Step 5 — Create the first administrator
On the server:
```bash
sudo -u storagex bash -c 'cd /srv/storagex && node dist/cli.mjs make-admin you@kitovu.com.ng "Your Name"'
```
(If the script installed its own Node.js, use `/opt/storagex-node/bin/node`.) Open the printed link within 72 hours, choose a password, and scan the QR code with an authenticator app. Save the recovery codes.

## Step 6 — Turn on deploys from GitHub
GitHub → **Settings → Secrets and variables → Actions → New repository secret**:
- `VPS_HOST` = your VPS IP
- `VPS_SSH_KEY` = the private key printed at the end of setup (all lines, BEGIN to END)

To deploy: **Actions → Deploy → Run workflow**. It runs the tests, then backs up the database, updates, migrates and restarts. If the new version does not start, it puts the old code back.

## Step 7 — Check the backups
The next morning, on the server:
```bash
ls -lh /srv/storagex/data/backups
```
You should see a `storagex-…dump` file. Every Sunday the server restores the newest backup into a throwaway database to prove it works; results are in `data/backups/restore-check.log`.

Backups on the same server do not survive losing the server. Copy them off the VPS (ComboTrader's `backup-offsite.sh` approach with Google Drive) before real lender data goes in. That is on the Build 12 checklist.

## Step 8 — Turn on text messages (Termii)
Farmer phone checks, consent codes and SMS sign-in codes need Termii. Until this is done, the server refuses to send them, and those steps show an error.

1. In the Termii dashboard, copy the **API key** and the approved **Sender ID** (use the same account as ComboTrader if you like).
2. On the server:
   ```bash
   sudo nano /srv/storagex/.env
   ```
   Set `TERMII_API_KEY=` and `TERMII_SENDER_ID=`. Leave `TERMII_CHANNEL=dnd` (it reaches numbers on the Do-Not-Disturb list). Save (Ctrl+O, Enter, Ctrl+X).
3. Restart:
   ```bash
   sudo systemctl restart storagex
   ```
4. Register a test farmer with your own phone and press **Text a code**, then **Call with a code**. Both should reach you within a minute. If the call fails, ask Termii support for the Voice Call endpoint and put it in `TERMII_VOICE_PATH`.
5. Which methods are allowed is set in the app: **Settings → Farmer phone check**.

## Step 9 — Keep a copy of the settings file somewhere safe
ID photos are encrypted with a key made from `APP_SECRET` in `/srv/storagex/.env`. If that file is lost, the photos in the backups cannot be opened.

```bash
sudo cat /srv/storagex/.env
```
Copy the `APP_SECRET=` line into your password manager. Do not put it in Google Drive next to the backups.

## Step 10 — Turn on the AI pre-check of ID photos (optional)
1. In the Anthropic Console, create an API key (the same account as ComboTrader is fine).
2. On the server, `sudo nano /srv/storagex/.env` and set `ANTHROPIC_API_KEY=`. Save.
3. `sudo systemctl restart storagex`
4. In the app, **Settings → AI pre-check** should no longer say the key is missing. Submit a test ID check and open **ID checks**: the coloured AI panel appears within about a minute.
