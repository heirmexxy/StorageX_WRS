#!/usr/bin/env bash
# Adds StorageX's frequent jobs to the storagex user's schedule (safe to run again; it replaces its own lines).
#   every minute:     deliver webhooks to partners' systems
#   every 10 minutes: mark WareGuard devices that have gone quiet (only matters once Titan sends readings)
# Run as the storagex user:  sudo -u storagex bash /srv/storagex/deploy/jobs.sh
set -euo pipefail
APP_DIR=/srv/storagex
NODE=/opt/storagex-node/bin/node; [ -x "$NODE" ] || NODE=$(command -v node)
mkdir -p "$APP_DIR/data/backups"
{ crontab -l 2>/dev/null | grep -v 'dist/cli.mjs webhooks' | grep -v 'dist/cli.mjs wareguard-sweep' || true
  echo "* * * * * cd $APP_DIR && $NODE dist/cli.mjs webhooks >> data/backups/webhooks.log 2>&1"
  echo "*/10 * * * * cd $APP_DIR && $NODE dist/cli.mjs wareguard-sweep >> data/backups/wareguard.log 2>&1"
} | crontab -
echo "Jobs scheduled: webhooks every minute, WareGuard check every 10 minutes."
