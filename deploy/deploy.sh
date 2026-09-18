#!/usr/bin/env bash
# First deployment for CueLine on an Ubuntu box that already runs nginx.
#
#   sudo ./deploy/deploy.sh cueline.yourdomain.com [--certbot]
#
# Run it from the repo root on the server. It is safe to run again: every step
# either creates something or replaces what it created last time.
set -euo pipefail

DOMAIN="${1:-}"
CERTBOT="${2:-}"
APP_DIR=/opt/cueline
ENV_FILE=/etc/cueline.env
PORT=8080

[ -n "$DOMAIN" ] || { echo "usage: sudo $0 <domain> [--certbot]" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say () { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the port is free"
if ss -lnt "sport = :$PORT" | grep -q LISTEN; then
    echo "port $PORT is already in use. Change PORT here and in cueline.nginx.conf." >&2
    exit 1
fi

say "Installing Node if it is missing"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
node --version

say "Creating the service user and app directory"
id -u cueline >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cueline
mkdir -p "$APP_DIR"
if [ "$REPO" != "$APP_DIR" ]; then
    rsync -a --delete --exclude node_modules --exclude .git --exclude dist "$REPO"/ "$APP_DIR"/
fi
chown -R cueline:cueline "$APP_DIR"

say "Installing server dependencies"
cd "$APP_DIR/server"
sudo -u cueline npm ci --omit=dev 2>/dev/null || sudo -u cueline npm install --omit=dev

say "Writing $ENV_FILE"
# Keep existing TURN credentials across re-runs instead of blanking them.
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<ENV
PORT=$PORT
HOST=127.0.0.1
STUN_URLS=stun:stun.l.google.com:19302
# Fill these in only when a call reaches connection state "failed".
TURN_URLS=
TURN_USERNAME=
TURN_CREDENTIAL=
ENV
    chmod 600 "$ENV_FILE"
    echo "wrote $ENV_FILE"
else
    echo "kept existing $ENV_FILE"
fi

say "Installing the systemd unit"
install -m 644 "$APP_DIR/deploy/cueline.service" /etc/systemd/system/cueline.service
systemctl daemon-reload
systemctl enable --now cueline
systemctl restart cueline
sleep 1
systemctl is-active --quiet cueline || { journalctl -u cueline -n 30 --no-pager; exit 1; }

say "Installing the nginx site"
sed "s/DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/cueline.nginx.conf" > /etc/nginx/sites-available/cueline.conf
ln -sf /etc/nginx/sites-available/cueline.conf /etc/nginx/sites-enabled/cueline.conf
nginx -t
systemctl reload nginx

if [ "$CERTBOT" = "--certbot" ]; then
    say "Requesting a certificate"
    # Skip this when Cloudflare terminates TLS and talks plain HTTP to the origin.
    command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi

say "Done"
echo "service:  systemctl status cueline"
echo "logs:     journalctl -u cueline -f"
echo "check:    curl -s http://127.0.0.1:$PORT/config.json"
echo
echo "Now open https://$DOMAIN and confirm a room code appears."
echo "The host page needs HTTPS. Behind Cloudflare, set SSL mode to Full."
