#!/usr/bin/env bash
# Pulls the latest main branch, backs up the database, rebuilds, migrates, restarts StorageX and checks its health.
# If the new version does not start, the code is rolled back. Database migrations are not undone automatically,
# so every migration must keep working with the previous release (add columns/tables; remove them a release later).
# Run as the storagex user (GitHub Actions does this when you run the deploy workflow).
set -euo pipefail
if [ -z "${SX_UPDATE_COPY:-}" ]; then T=$(mktemp /tmp/sx-update.XXXXXX); cp "$0" "$T"; SX_UPDATE_COPY="$T" exec bash "$T" "$@"; fi
trap 'rm -f "$SX_UPDATE_COPY"' EXIT
APP_DIR=/srv/storagex
cd "$APP_DIR"
[ -x /opt/storagex-node/bin/node ] && export PATH="/opt/storagex-node/bin:$PATH"
PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' "'"'" || true); PORT=${PORT:-3200}
BIND=$(grep -E '^HOST_BIND=' .env | cut -d= -f2 | tr -d ' "'"'" || true); [ -z "$BIND" ] || [ "$BIND" = 0.0.0.0 ] && BIND=127.0.0.1
healthy() { for i in $(seq 1 20); do sleep 2; curl -fsS "http://$BIND:$PORT/healthz" >/dev/null 2>&1 && return 0; done; return 1; }

PREV=$(git rev-parse HEAD)
git fetch --quiet origin main
NEW=$(git rev-parse origin/main)
[ "$PREV" = "$NEW" ] && { echo "Already up to date ($PREV)."; exit 0; }
echo "$(date "+%F %T") updating $PREV -> $NEW"
node dist/cli.mjs backup "data/backups/pre-deploy-$(date +%F-%H%M%S).dump"
git reset --hard --quiet "$NEW"
npm install --no-audit --no-fund --silent
npm run build --silent
npm run migrate --silent
npm run seed --silent
sudo /usr/bin/systemctl restart storagex
if healthy; then echo "Deployed $NEW"; exit 0; fi
echo "New version failed its health check — rolling back the code to $PREV (the database keeps the new migrations)"
git reset --hard --quiet "$PREV"
npm install --no-audit --no-fund --silent && npm run build --silent
sudo /usr/bin/systemctl restart storagex
healthy && echo "Rolled back to $PREV" || echo "Rollback did not come up either: journalctl -u storagex -n 100"
exit 1
