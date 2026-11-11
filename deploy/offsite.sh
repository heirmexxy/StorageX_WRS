#!/usr/bin/env bash
# Copies the last two days of backups to Google Drive through an rclone "crypt" remote, so the copy in Drive is
# encrypted with a password kept outside the server. Removes copies older than 30 days. See HOSTINGER.md step 13.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${BACKUP_DIR:-data/backups}"
REMOTE="${OFFSITE_REMOTE:-storagex-offsite:}"
command -v rclone >/dev/null || { echo "$(date -u +%FT%TZ) rclone is not installed: off-site copy skipped"; exit 1; }
rclone listremotes | grep -qx "${REMOTE%%:*}:" || { echo "$(date -u +%FT%TZ) rclone remote ${REMOTE} is not set up: off-site copy skipped"; exit 1; }
rclone copy "$DIR" "$REMOTE" --include '*.dump' --include '*.uploads.tar' --max-age 48h
rclone delete "$REMOTE" --min-age 30d
date -u +%FT%TZ > "$DIR/.offsite-ok"
echo "$(date -u +%FT%TZ) off-site copy done"
