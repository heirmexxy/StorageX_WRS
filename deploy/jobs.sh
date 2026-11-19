#!/usr/bin/env bash
# Adds StorageX's frequent jobs to the storagex user's schedule (safe to run again; it replaces its own lines).
#   every minute:     deliver webhooks to partners' systems
#   every 10 minutes: mark WareGuard devices that have gone quiet (only matters once Titan sends readings)
#   04:50 every day:  read the live price feed (only when PRICE_FEED_URL is set), before the 05:15 valuation
# Run as the storagex user:  sudo -u storagex bash /srv/storagex/deploy/jobs.sh
set -euo pipefail
APP_DIR=/srv/storagex
NODE=/opt/storagex-node/bin/node; [ -x "$NODE" ] || NODE=$(command -v node)
mkdir -p "$APP_DIR/data/backups"
{ crontab -l 2>/dev/null | grep -v 'dist/cli.mjs webhooks' | grep -v 'dist/cli.mjs wareguard-sweep' | grep -v 'dist/cli.mjs price-feed' || true
  echo "* * * * * cd $APP_DIR && $NODE dist/cli.mjs webhooks >> data/backups/webhooks.log 2>&1"
  echo "*/10 * * * * cd $APP_DIR && $NODE dist/cli.mjs wareguard-sweep >> data/backups/wareguard.log 2>&1"
  echo "50 4 * * * cd $APP_DIR && $NODE dist/cli.mjs price-feed >> data/backups/price-feed.log 2>&1"
} | crontab -
echo "Jobs scheduled: webhooks every minute, WareGuard check every 10 minutes, price feed daily at 04:50."
