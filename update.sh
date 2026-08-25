#!/usr/bin/env bash
# Tự cập nhật: kéo mã mới nhất từ GitHub và chỉ xây dựng lại khi có thay đổi.
# Có thể chạy theo lịch (cron/systemd timer) — không làm gì nếu đã cập nhật.
set -euo pipefail
cd "$(dirname "$0")"

git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "$(date '+%F %T') — đã cập nhật mới nhất"
  exit 0
fi

echo "$(date '+%F %T') — phát hiện cập nhật, đang kéo mã và xây dựng lại..."
git pull --ff-only origin main
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "$(date '+%F %T') — đã cập nhật tới $(git rev-parse --short HEAD)"
