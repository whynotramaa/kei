#!/usr/bin/env bash
# Update an already deployed CueLine. Run on the server, or pipe it in:
#   ssh root@box 'bash -s' < deploy/update.sh
set -euo pipefail

cd /opt/cueline
git fetch --all --quiet
git reset --hard origin/main --quiet

cd server
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
chown -R cueline:cueline /opt/cueline

systemctl restart cueline
sleep 2

# Fail loudly rather than reporting a green deploy over a dead service.
systemctl is-active --quiet cueline || { journalctl -u cueline -n 30 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:8080/config.json > /dev/null
echo "cueline restarted and answering on $(git rev-parse --short HEAD)"
