#!/usr/bin/env bash
# StorageX — setup on a Hostinger VPS, safe for servers that already run other sites.
#
#   bash setup.sh --check     look only: report what is on the server and what this script would do (changes nothing)
#   bash setup.sh             install (asks before changing anything)
#   bash setup.sh --https     turn on HTTPS once DNS points at this server (nginx / Apache only; Caddy does it by itself)
#
# Options (put them before "bash"):
#   HOST=storagex.com.ng   the address to serve (default storagex.com.ng). The other form redirects to it:
#                          www.storagex.com.ng → storagex.com.ng, or the bare domain → www if HOST starts with www.
#   PORT=3200                      the internal port (default: the first free port from 3200)
#   LE_EMAIL=you@example.com       email for HTTPS certificate notices
#
# What it never does on a shared server: upgrade or remove packages, change the firewall, change the timezone,
# replace the system Node.js, restart (only reloads) your web server, or edit another site's configuration.
set -euo pipefail

HOST="${HOST:-storagex.com.ng}"
# APEX is the other name that redirects to HOST: the bare domain for a www HOST, or www.HOST for a bare domain
# (a name with at most three labels, e.g. storagex.com.ng). It gets a certificate only if its DNS points here.
APEX=""
if [[ "$HOST" == www.* ]]; then APEX="${HOST#www.}"; elif [ "$(tr -cd . <<<"$HOST" | wc -c)" -le 2 ]; then APEX="www.$HOST"; fi
REPO="${REPO:-git@github.com:heirmexxy/StorageX_WRS.git}"
LE_EMAIL="${LE_EMAIL:-info@kitovu.com.ng}"
APP_DIR=/srv/storagex
APP_USER=storagex
NODE_DIR=/opt/storagex-node
MODE="${1:-install}"
STAMP=$(date +%Y%m%d-%H%M%S)

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Run this as root (sudo -i first)."

# ---------------------------------------------------------------- look around (read-only)
listener() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1; }
port_free() { ! ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

. /etc/os-release 2>/dev/null || true
RAM_FREE=$(free -m | awk '/^Mem:/ {print $7}')
DISK_FREE=$(df -Pm / | awk 'NR==2 {print $4}')
P80=$(listener 80); P443=$(listener 443)
WEBPROC="${P80:-$P443}"

PANEL=""
[ -d /usr/local/CyberCP ] && PANEL="CyberPanel"
[ -d /www/server/panel ] && PANEL="aaPanel"
[ -d /home/clp ] || [ -x /usr/bin/clpctl ] && PANEL="CloudPanel"
[ -d /data/coolify ] && PANEL="Coolify"
[ -d /etc/dokploy ] && PANEL="Dokploy"
[ -d /usr/local/hestia ] && PANEL="HestiaCP"
[ -d /usr/local/cpanel ] && PANEL="cPanel"
[ -d /usr/local/psa ] && PANEL="Plesk"
[ -d /etc/easypanel ] && PANEL="Easypanel"

case "$WEBPROC" in
  nginx) WEB=nginx ;;
  apache2|httpd) WEB=apache ;;
  caddy) WEB=caddy ;;
  "") WEB=none ;;
  *) WEB=other ;;   # docker-proxy, traefik, litespeed, a panel's own proxy…
esac
# Panels manage their web server themselves: never write into it behind their back.
if [ -n "$PANEL" ] && [ "$WEB" != none ]; then WEB=panel; fi
[ "$WEB" = apache ] && [ ! -d /etc/apache2/sites-available ] && WEB=other

# Where StorageX listens. Loopback by default; a proxy that runs inside Docker cannot reach the host's loopback,
# so then we listen on the Docker bridge address instead (still not reachable from the internet).
BIND=127.0.0.1
DOCKERISH=""
if [ "$WEBPROC" = docker-proxy ] || [[ "$PANEL" =~ ^(Coolify|Dokploy|Easypanel)$ ]]; then
  DOCKERISH=yes
  BIND=$( (ip -4 -o addr show docker0 2>/dev/null || true) | awk '{print $4}' | cut -d/ -f1 | head -1); BIND=${BIND:-172.17.0.1}
fi

# Is this address already served by something on this server?
CONFLICT=$(grep -rIls --exclude='storagex*' -e "$HOST" ${APEX:+-e "server_name.*\b$APEX\b"} /etc/nginx /etc/apache2 /etc/caddy /etc/httpd 2>/dev/null | head -3 || true)
if [ -f /etc/caddy/Caddyfile ] && grep -q "# BEGIN storagex" /etc/caddy/Caddyfile; then CONFLICT=$(echo "$CONFLICT" | grep -v '^/etc/caddy/Caddyfile$' || true); fi

SYS_NODE=$(command -v node || true); SYS_NODE_V=""
[ -n "$SYS_NODE" ] && SYS_NODE_V=$("$SYS_NODE" -v 2>/dev/null | tr -d v)
if [ -x "$NODE_DIR/bin/node" ]; then NODE_PLAN="use StorageX's own Node.js in $NODE_DIR"; NODE_BIN="$NODE_DIR/bin"
elif [ -n "$SYS_NODE_V" ] && ver_ge "$SYS_NODE_V" 22.13.0 && runuser -u nobody -- "$SYS_NODE" -v >/dev/null 2>&1; then NODE_PLAN="use the existing Node.js $SYS_NODE_V at $SYS_NODE (left as it is)"; NODE_BIN=$(dirname "$SYS_NODE")
else NODE_PLAN="install a private Node.js 22 in $NODE_DIR (your system Node.js ${SYS_NODE_V:-none} is not touched)"; NODE_BIN="$NODE_DIR/bin"; fi

if [ -f "$APP_DIR/.env" ] && grep -q '^PORT=' "$APP_DIR/.env" && [ -z "${PORT:-}" ]; then
  PORT=$(grep '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d ' "'"'")
fi
if [ -z "${PORT:-}" ]; then for p in $(seq 3200 3299); do if port_free "$p"; then PORT=$p; break; fi; done; fi
[ -n "${PORT:-}" ] || die "No free port between 3200 and 3299."
if ! port_free "$PORT" && [ ! -f "$APP_DIR/.env" ]; then die "Port $PORT is used by $(listener "$PORT"). Run again with PORT=<another port>."; fi

PUBIP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
dns_ok() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qx "$PUBIP"; }

case "$WEB" in
  nginx) WEB_PLAN="add one new file /etc/nginx/sites-available/storagex.conf for $HOST, test it with 'nginx -t', then reload nginx (no restart, other sites keep running)";;
  apache) WEB_PLAN="add one new site /etc/apache2/sites-available/storagex.conf for $HOST, enable proxy modules, test with 'apachectl configtest', then reload Apache";;
  caddy) WEB_PLAN="append a marked StorageX block to /etc/caddy/Caddyfile (backup first), validate it, then reload Caddy";;
  none) WEB_PLAN="nothing listens on ports 80/443: install Caddy for HTTPS";;
  panel) WEB_PLAN="NOT touched — $PANEL manages the web server. You add a reverse proxy for $HOST → http://$BIND:$PORT in $PANEL (instructions at the end)";;
  other) WEB_PLAN="NOT touched — ports 80/443 belong to '$WEBPROC'. You add a reverse proxy for $HOST → http://$BIND:$PORT (instructions at the end)";;
esac

report() {
  cat <<R

StorageX setup — what I found
  System          ${PRETTY_NAME:-unknown}
  Free memory     ${RAM_FREE} MB          (StorageX is capped at 1 GB; needs ~200 MB, plus PostgreSQL)
  Free disk       ${DISK_FREE} MB
  Port 80 / 443   ${P80:-free} / ${P443:-free}
  Control panel   ${PANEL:-none found}
  Node.js         ${SYS_NODE_V:-not installed}
  Firewall        $(ufw status 2>/dev/null | head -1 || echo 'ufw not installed') (left as it is)
  This server IP  $PUBIP
  $HOST DNS → $(getent ahostsv4 "$HOST" 2>/dev/null | awk 'NR==1{print $1}' || true) $(dns_ok "$HOST" && echo '(this server)' || echo '(not this server yet)')

What I would do
  1. Create a separate Linux user '$APP_USER' and put the app in $APP_DIR
  2. Node.js: $NODE_PLAN
  3. Run StorageX on $BIND:$PORT only (not reachable from the internet), as a service capped at 1 GB memory and low CPU priority
  4. Web server: $WEB_PLAN
  5. PostgreSQL database "storagex" (installed if missing), nightly backups in $APP_DIR/data/backups, weekly restore test (a cron entry for '$APP_USER' only)
  Address: https://$HOST${APEX:+  (and $APEX redirects to it)}
R
  [ -n "$CONFLICT" ] && warn "Already in your web server config: $HOST — found in: $(echo $CONFLICT)"
  [ "${RAM_FREE:-0}" -lt 600 ] && warn "Less than 600 MB memory free. StorageX may squeeze your other apps; consider upgrading the VPS plan."
  [ "${DISK_FREE:-0}" -lt 3000 ] && warn "Less than 3 GB disk free."
  ufw status 2>/dev/null | grep -q 'Status: active' && ! ufw status | grep -Eq '(^| )(80|443|Nginx|Apache|WWW)' && warn "The firewall is on and may not allow web traffic. I will not change it."
  return 0
}

# ---------------------------------------------------------------- HTTPS only
https_step() {
  local names=("$HOST")
  [ -n "$APEX" ] && dns_ok "$APEX" && names+=("$APEX")
  dns_ok "$HOST" || { warn "$HOST does not point at $PUBIP yet. Add the DNS record, wait, then run: bash $APP_DIR/deploy/setup.sh --https"; return 0; }
  case "$WEB" in
    nginx|apache)
      command -v certbot >/dev/null || apt-get install -y --no-upgrade certbot "python3-certbot-$([ "$WEB" = nginx ] && echo nginx || echo apache)"
      local args=(); for n in "${names[@]}"; do args+=(-d "$n"); done
      certbot "--$WEB" "${args[@]}" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect --keep-until-expiring
      say "HTTPS is on for ${names[*]}" ;;
    caddy|none) say "Caddy turns on HTTPS by itself once DNS points here." ;;
    *) say "Turn on HTTPS (Let's Encrypt) for $HOST in ${PANEL:-your proxy}." ;;
  esac
}

if [ "$MODE" = "--check" ]; then report; echo; echo "Nothing was changed. To install: bash setup.sh"; exit 0; fi
if [ "$MODE" = "--https" ]; then https_step; exit 0; fi

report
[ -n "$CONFLICT" ] && die "Another site on this server already uses $HOST. Use a different HOST (e.g. HOST=beta.storagex.com.ng) or remove the old site first."
echo
read -r -p "Type YES to continue: " ok
[ "$ok" = "YES" ] || die "Nothing changed."

# ---------------------------------------------------------------- install
say "1/9 Tools (only what is missing; nothing is upgraded)"
apt-get update -y >/dev/null
need=(); for c in git curl xz openssl; do command -v "$c" >/dev/null || need+=("$c"); done
[ ${#need[@]} -gt 0 ] && apt-get install -y --no-upgrade "${need[@]/xz/xz-utils}"

say "2/9 Node.js"
if [ "$NODE_BIN" = "$NODE_DIR/bin" ] && [ ! -x "$NODE_DIR/bin/node" ]; then
  case "$(uname -m)" in x86_64) A=x64;; aarch64|arm64) A=arm64;; *) die "Unsupported CPU $(uname -m)";; esac
  TMP=$(mktemp -d); cd "$TMP"
  curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  FILE=$(grep -o "node-v22[^ ]*-linux-$A.tar.xz" SHASUMS256.txt | head -1)
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$FILE"
  grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null || die "Node.js download failed its checksum."
  mkdir -p "$NODE_DIR" && tar -xJf "$FILE" -C "$NODE_DIR" --strip-components=1
  cd / && rm -rf "$TMP"
fi
"$NODE_BIN/node" -v
export PATH="$NODE_BIN:$PATH"

say "3/9 App user and GitHub deploy key"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
[ -f "/home/$APP_USER/.ssh/id_ed25519" ] || sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -C "storagex-vps" -f "/home/$APP_USER/.ssh/id_ed25519" >/dev/null
sudo -u "$APP_USER" bash -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u ~/.ssh/known_hosts -o ~/.ssh/known_hosts'
if [ ! -d "$APP_DIR/.git" ]; then
  echo; echo "Add this key in GitHub → heirmexxy/StorageX_WRS → Settings → Deploy keys → Add deploy key (leave write access off):"; echo
  cat "/home/$APP_USER/.ssh/id_ed25519.pub"; echo
  read -r -p "Press Enter once it is added… " _
fi

say "4/9 Download StorageX"
mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"; else sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only; fi

say "5/9 PostgreSQL (installed only if missing; existing databases are not touched)"
if ! command -v psql >/dev/null || ! systemctl list-unit-files | grep -q '^postgresql'; then apt-get install -y --no-upgrade postgresql postgresql-contrib; fi
systemctl is-active --quiet postgresql || systemctl start postgresql
DB_PASS=""
[ -f "$APP_DIR/.env" ] && DB_PASS=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|' || true)
if [ -z "$DB_PASS" ] || [ "$DB_PASS" = "CHANGE_ME" ]; then DB_PASS=$(openssl rand -hex 24); fi
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='storagex'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER ROLE storagex WITH LOGIN PASSWORD '$DB_PASS' CREATEDB"
else
  sudo -u postgres psql -qc "CREATE ROLE storagex LOGIN PASSWORD '$DB_PASS' CREATEDB"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='storagex'" | grep -q 1 || sudo -u postgres createdb -O storagex storagex

say "6/9 Settings (.env) and build"
if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/.env"
fi
sed -i "s|^BASE_URL=.*|BASE_URL=https://$HOST|; s|^PORT=.*|PORT=$PORT|; s|^HOST_BIND=.*|HOST_BIND=$BIND|; s|^BACKUP_DIR=.*|BACKUP_DIR=$APP_DIR/data/backups|; s|^UPLOADS_DIR=.*|UPLOADS_DIR=$APP_DIR/data/uploads|" "$APP_DIR/.env"
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://storagex:$DB_PASS@127.0.0.1:5432/storagex|" "$APP_DIR/.env"
chown "$APP_USER:$APP_USER" "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"
sudo -u "$APP_USER" env PATH="$NODE_BIN:/usr/bin:/bin" bash -c "cd $APP_DIR && npm install --no-audit --no-fund && npm run build && npm run migrate && npm run seed"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data/backups" "$APP_DIR/data/uploads" && chmod 700 "$APP_DIR/data/uploads"

say "7/9 Service (memory-capped, low priority)"
cat > /etc/systemd/system/storagex.service <<UNIT
[Unit]
Description=StorageX
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=$NODE_BIN:/usr/bin:/bin
ExecStart=$NODE_BIN/node dist/server.mjs
Restart=always
RestartSec=3
# Be a good neighbour to the other apps on this server
MemoryHigh=800M
MemoryMax=1024M
CPUWeight=50
Nice=5
TasksMax=256
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart storagex, /usr/bin/systemctl status storagex" > /etc/sudoers.d/storagex
chmod 440 /etc/sudoers.d/storagex
systemctl daemon-reload && systemctl enable storagex >/dev/null 2>&1 && systemctl restart storagex
for i in $(seq 1 15); do sleep 1; curl -fsS "http://$BIND:$PORT/healthz" >/dev/null 2>&1 && break; done
curl -fsS "http://$BIND:$PORT/healthz" >/dev/null || die "StorageX did not start. See: journalctl -u storagex -n 50"
echo "Running on $BIND:$PORT"

say "8/9 Web server"
PROXY_NOTE=""
case "$WEB" in
  nginx)
    tar -czf "/root/nginx-backup-$STAMP.tgz" /etc/nginx 2>/dev/null
    if [ -d /etc/nginx/sites-available ]; then F=/etc/nginx/sites-available/storagex.conf; else F=/etc/nginx/conf.d/storagex.conf; fi
    {
      echo "# StorageX — added by deploy/setup.sh on $STAMP. Only this file belongs to StorageX."
      if [ -n "$APEX" ]; then echo "server { listen 80; listen [::]:80; server_name $APEX; return 301 https://$HOST\$request_uri; }"; fi
      cat <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
NGX
    } > "$F"
    [ "$F" = /etc/nginx/sites-available/storagex.conf ] && ln -sf "$F" /etc/nginx/sites-enabled/storagex.conf
    if ! nginx -t 2>/tmp/nginx-test.log; then
      rm -f /etc/nginx/sites-enabled/storagex.conf "$F"
      cat /tmp/nginx-test.log
      die "nginx rejected the new file, so I removed it. Your other sites were not changed."
    fi
    systemctl reload nginx
    https_step ;;
  apache)
    tar -czf "/root/apache-backup-$STAMP.tgz" /etc/apache2 2>/dev/null
    F=/etc/apache2/sites-available/storagex.conf
    cat > "$F" <<APC
# StorageX — added by deploy/setup.sh on $STAMP
<VirtualHost *:80>
    ServerName $HOST
    ${APEX:+ServerAlias $APEX}
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
    LimitRequestBody 15728640
</VirtualHost>
APC
    a2enmod -q proxy proxy_http headers >/dev/null && a2ensite -q storagex >/dev/null
    if ! apachectl configtest 2>/tmp/apache-test.log; then
      a2dissite -q storagex >/dev/null; rm -f "$F"; cat /tmp/apache-test.log
      die "Apache rejected the new site, so I removed it. Your other sites were not changed."
    fi
    systemctl reload apache2
    https_step ;;
  caddy|none)
    if [ "$WEB" = none ] && ! command -v caddy >/dev/null; then
      apt-get install -y --no-upgrade debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -y >/dev/null && apt-get install -y caddy
      # A fresh Caddy ships a demo site on :80; replace only that default file.
      grep -q '^:80' /etc/caddy/Caddyfile && : > /etc/caddy/Caddyfile
    fi
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$STAMP"
    sed -i '/# BEGIN storagex/,/# END storagex/d' /etc/caddy/Caddyfile
    {
      echo "# BEGIN storagex (added by deploy/setup.sh — edit only between these markers)"
      [ -n "$APEX" ] && printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$APEX" "$HOST"
      printf '%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n\trequest_body {\n\t\tmax_size 15MB\n\t}\n}\n' "$HOST" "$PORT"
      echo "# END storagex"
    } >> /etc/caddy/Caddyfile
    if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-test.log 2>&1; then
      cp "/etc/caddy/Caddyfile.bak-$STAMP" /etc/caddy/Caddyfile; cat /tmp/caddy-test.log
      die "Caddy rejected the change, so I restored your Caddyfile."
    fi
    systemctl reload caddy || systemctl restart caddy ;;
  panel|other)
    PROXY_NOTE="yes" ;;
esac

say "9/9 Backups and the deploy key for GitHub"
CRON1="15 2 * * * cd $APP_DIR && $NODE_BIN/node dist/cli.mjs backup >> data/backups/backup.log 2>&1 && find data/backups \\( -name '*.dump' -o -name '*.uploads.tar' \\) -mtime +30 -delete && bash deploy/offsite.sh >> data/backups/offsite.log 2>&1"
CRON4="15 5 * * * cd $APP_DIR && $NODE_BIN/node dist/cli.mjs revalue >> data/backups/revalue.log 2>&1"
# Mid-morning, so reminders do not arrive before dawn (09:10 UTC is 10:10 in Lagos).
CRON5="10 9 * * * cd $APP_DIR && $NODE_BIN/node dist/cli.mjs remind >> data/backups/remind.log 2>&1"
CRON6="40 4 * * * cd $APP_DIR && $NODE_BIN/node dist/cli.mjs steward >> data/backups/steward.log 2>&1"
CRON3="30 4 * * * cd $APP_DIR && $NODE_BIN/node dist/cli.mjs purge-files >> data/backups/purge-files.log 2>&1"
CRON2="45 3 * * 0 cd $APP_DIR && $NODE_BIN/node dist/cli.mjs restore-check \$(ls -1t data/backups/*.dump | head -1) >> data/backups/restore-check.log 2>&1"
# (a fresh user has no crontab yet: that is not an error)
{ crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'dist/cli.mjs backup' | grep -v 'dist/cli.mjs restore-check' | grep -v 'dist/cli.mjs purge-files' | grep -v 'dist/cli.mjs revalue' | grep -v 'dist/cli.mjs remind' | grep -v 'dist/cli.mjs steward' || true; echo "$CRON1"; echo "$CRON2"; echo "$CRON3"; echo "$CRON4"; echo "$CRON5"; echo "$CRON6"; } | crontab -u "$APP_USER" -
KEY=/home/$APP_USER/.ssh/github_actions
if [ ! -f "$KEY" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -C "github-actions-deploy" -f "$KEY" >/dev/null
  echo "command=\"$APP_DIR/deploy/update.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat "$KEY.pub")" | sudo -u "$APP_USER" tee -a "/home/$APP_USER/.ssh/authorized_keys" >/dev/null
  chmod 600 "/home/$APP_USER/.ssh/authorized_keys"
fi

cat <<DONE

StorageX is installed and running on $BIND:$PORT. Your other platforms were not changed.

Next:
  • First administrator:  sudo -u $APP_USER bash -c 'cd $APP_DIR && $NODE_BIN/node dist/cli.mjs make-admin you@kitovu.com.ng Your Name'
  • DNS (where the domain is managed): an A record for $HOST → $PUBIP${APEX:+, and one for $APEX → $PUBIP}.
DONE
if [ -n "$PROXY_NOTE" ]; then cat <<PX
  • Reverse proxy (your ${PANEL:-proxy} owns ports 80/443, so add it there):
        domain $HOST  →  http://$BIND:$PORT   (turn on Let's Encrypt HTTPS for it)
      CloudPanel: Sites → Add Site → Create a Reverse Proxy.   aaPanel: Website → Add site → Reverse proxy.
      Nginx Proxy Manager: Hosts → Proxy Hosts → Add (forward to $BIND port $PORT, SSL tab → request a certificate).
      Traefik / Coolify / Dokploy / Easypanel: add a route for $HOST to http://$BIND:$PORT (in Coolify and Dokploy you can
      also use http://host.docker.internal:$PORT).   CyberPanel/OpenLiteSpeed: create the website, add an "External App"
      (web server) at $BIND:$PORT and a proxy context "/".
      Not sure? Send me the output of:  bash setup.sh --check
PX
elif [ "$WEB" = nginx ] || [ "$WEB" = apache ]; then
  echo "  • HTTPS: once DNS points here, run:  bash $APP_DIR/deploy/setup.sh --https"
fi
cat <<KEY2
  • Automatic deploys: GitHub → Settings → Secrets and variables → Actions:
        VPS_HOST    = $PUBIP
        VPS_SSH_KEY = the private key below (all lines, BEGIN to END)

KEY2
cat "$KEY"
