# Putting StorageX on your Hostinger VPS

The setup script is the ComboTrader one, adapted: it is safe on a server that already runs other sites, looks first, and changes nothing until you type YES. StorageX runs as its own Linux user in `/srv/storagex`, on an internal port (3200–3299), with its own PostgreSQL database. Do one step at a time.

## Step 1 — Snapshot the server
hPanel → **VPS → Snapshots & backups → Create snapshot**. You can restore the whole server to this moment if anything goes wrong.

## Step 2 — Point storagex.com.ng at the server
StorageX lives at **https://storagex.com.ng**. Receipt QR codes carry this address, so it must not change once real receipts are printed. `www.storagex.com.ng` redirects to it.
1. Find your VPS IP: hPanel → **VPS → Overview** (the IPv4 address).
2. Open the DNS settings where storagex.com.ng is managed. If you bought it through Hostinger, that is hPanel → **Domains → storagex.com.ng → DNS / Nameservers**; otherwise use your registrar's DNS page.
3. Add (or edit) an **A** record: name **@**, points to your VPS IP. Remove any other A record for **@** (for example a parking page).
4. Add an **A** record: name **www**, points to the same IP.
5. Wait 10–60 minutes, then check: `ping storagex.com.ng` on your computer should show your VPS IP.

To try things out first on a test address, add a record named **beta** instead and use `HOST=beta.storagex.com.ng` in steps 3 and 4, then run step 4 again with the real address before the pilot.

## Step 3 — Look before changing anything
1. Connect: `ssh root@YOUR_VPS_IP` (or hPanel's **Browser terminal**).
2. The repository is private, so copy the script by hand: open `deploy/setup.sh` on GitHub → **Raw**, copy everything, then on the server run `nano setup.sh`, paste, and save (Ctrl+O, Enter, Ctrl+X).
3. Run `HOST=storagex.com.ng bash setup.sh --check` and read the report. Nothing is changed. Send it to me if anything looks surprising.

## Step 4 — Install
1. Run `HOST=storagex.com.ng bash setup.sh` and type `YES`.
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

## Step 11 — Put the gate app on a clerk's phone
1. On the clerk's Android phone, open Chrome and go to `https://<your domain>/intake/`.
2. Sign in with the clerk's account (it must have a warehouse role).
3. When the app shows the warehouse list, open Chrome's menu (⋮) and tap **Add to Home screen**.
4. Turn on airplane mode and open the app from the home screen. It should open and show **Offline**.
5. Record a test delivery, turn airplane mode off, and keep the app open. Within a minute the record should show **Uploaded** and appear under **Deliveries** on the main site.

## Step 12 — Turn on the farmer USSD menu (Africa's Talking)
A USSD code takes a few weeks to get, because the networks have to approve it. Start early; everything else works without it.
1. Make a random key on the server: `openssl rand -hex 24`. Copy it.
2. `sudo nano /srv/storagex/.env` and add `USSD_KEY=` followed by the key. Save, then `sudo systemctl restart storagex`.
3. In the Africa's Talking dashboard, open **USSD → Create channel** and apply for a code (a shared code such as `*347*123#` is quicker and cheaper than your own).
4. Set the callback URL to `https://<your domain>/ussd/at?key=<the key from step 1>`.
5. Test it in the Africa's Talking simulator with the phone number of a farmer whose phone is confirmed: you should see **Welcome to StorageX** and be asked to choose a PIN.
6. When the networks approve the code, put it in **Settings → Farmer messages and USSD**, so texts (such as PIN resets) tell farmers what to dial.

Due-date reminders are sent at about 10:10 each morning by the daily job that `setup.sh` installs. To send them by hand: `cd /srv/storagex && node dist/cli.mjs remind`.

## Step 13 — Copy backups to Google Drive every night (encrypted)
The server already backs itself up at 02:15 each night, but the copies stay on the same server. These steps send an encrypted copy to Google Drive as well, so losing the server does not lose the data. You do this once; it takes about 20 minutes. Do one step at a time.

1. **Pick the Google account.** Use a Kitovu Google Workspace account that more than one director can get into (not a personal Gmail). In Google Drive, create a folder called `StorageX backups`.
2. **Install rclone on the server.** Connect with SSH and run: `sudo apt install -y rclone`
3. **Install rclone on your own computer too.** The server has no web browser, so the one-time Google sign-in happens on your computer. Download it from rclone.org/downloads and unzip it.
4. **Start the setup on the server**, as the StorageX user: `sudo -u storagex rclone config`
   - Type `n` (new remote). Name: `gdrive`. Storage type: type `drive` (Google Drive).
   - Leave client id and client secret blank (press Enter). Scope: choose `1` (full access).
   - Leave the next questions blank until it asks **"Use auto config?"**: type `n`.
5. **Sign in to Google on your computer.** The server shows a command starting `rclone authorize "drive"`. Run that exact command on your computer (in the folder you unzipped). A browser opens: sign in with the account from step 1 and allow access. Your computer then prints a long code. Copy all of it.
6. **Finish the Google part on the server.** Paste the code where the server asks for `config_token`. Answer `n` to "Configure this as a Shared Drive", then `y` to keep the remote.
7. **Add encryption on top.** Still in `rclone config`: type `n` again. Name: `storagex-offsite`. Storage type: type `crypt`.
   - Remote to encrypt: `gdrive:StorageX backups`
   - Filename encryption: `standard`. Directory name encryption: `true`.
   - Password: choose `y` (type your own) and enter a long passphrase. Then set a second passphrase (the "salt") the same way.
   - **Write both passphrases down and store them away from the server** (for example in the company password manager and a sealed envelope with a director). Without them the Google Drive copies cannot be opened, by anyone.
   - Type `y` to keep it, then `q` to quit.
8. **Test it now** instead of waiting for tonight: `cd /srv/storagex && sudo -u storagex node dist/cli.mjs backup && sudo -u storagex bash deploy/offsite.sh`. It should end with `off-site copy done`. In Google Drive, the `StorageX backups` folder now holds files with scrambled names: that is the encryption working.
9. **Check from StorageX.** Open **Admin → Settings**. Under **Connections**, Backups should show a recent backup and a recent off-site copy. From now on the copy runs every night after the backup, and copies older than 30 days are removed from Drive.

**Restoring from Google Drive** (if the server is lost): set up a new server with steps 1–4, install rclone and repeat steps 4–7 with the same two passphrases, then `rclone copy storagex-offsite: /srv/storagex/data/restore` and follow "Restore a backup" in docs/sops.md. You also need the copy of the settings file from step 9, because uploaded ID photos can only be opened with the same APP_SECRET.
