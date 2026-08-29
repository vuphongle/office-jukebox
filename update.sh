#!/usr/bin/env bash
# Self-update: pull the latest code from GitHub and rebuild only when it changes.
# Safe to schedule with cron or a systemd timer; it is a no-op when up to date.
set -euo pipefail
cd "$(dirname "$0")"

git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "$(date '+%F %T') — already up to date"
  exit 0
fi

echo "$(date '+%F %T') — update detected; pulling code and rebuilding..."
git pull --ff-only origin main
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "$(date '+%F %T') — updated to $(git rev-parse --short HEAD)"
