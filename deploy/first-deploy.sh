#!/usr/bin/env bash
# One-time bring-up for CueLine on the Orbya VPS.
#
# Run this BY HAND on the box, as the host operator, once:
#   scp deploy/first-deploy.sh root@srv1891226:/root/
#   ssh root@srv1891226 'bash /root/first-deploy.sh'
#
# CI never runs this. CI only does: docker login, compose pull, compose up -d.
# This script does not touch nginx, TLS, UFW or systemd. It prints the nginx
# block at the end for you to install by hand.
set -euo pipefail

PROJECT=cueline
APP_DIR=/opt/$PROJECT
HOST_PORT=3400
IMAGE=ghcr.io/whynotramaa/cueline-signal

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
say () { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the allocated port is actually free"
# The port registry lists 3300-3399 as free, but something is already listening
# on 3300. Trust the socket table over the registry.
if ss -lnt "sport = :$HOST_PORT" | grep -q LISTEN; then
    echo "port $HOST_PORT is in use. Pick another from the registry and update" >&2
    echo "docker-compose.prod.yml and cueline.nginx.conf together." >&2
    ss -lntp "sport = :$HOST_PORT" >&2
    exit 1
fi

say "Creating $APP_DIR"
mkdir -p "$APP_DIR/docker"

say "Writing $APP_DIR/.env.prod"
if [ ! -f "$APP_DIR/.env.prod" ]; then
    cat > "$APP_DIR/.env.prod" <<'ENV'
PORT=8080
HOST=0.0.0.0
STUN_URLS=stun:stun.l.google.com:19302
# Fill these in only when a call reaches connection state "failed".
TURN_URLS=
TURN_USERNAME=
TURN_CREDENTIAL=
ENV
    chmod 600 "$APP_DIR/.env.prod"
    chown root:root "$APP_DIR/.env.prod"
    echo "wrote it. Edit by hand to add TURN later."
else
    echo "kept the existing one."
fi

say "Installing the compose file"
if [ -f "$APP_DIR/docker/docker-compose.prod.yml" ]; then
    echo "already present, leaving it alone. It is host-owned."
else
    echo "Paste deploy/docker-compose.prod.yml from the repo to:"
    echo "  $APP_DIR/docker/docker-compose.prod.yml"
    echo "then run this script again."
    exit 1
fi

say "Pulling and starting"
cd "$APP_DIR"
DC="docker compose -p $PROJECT -f docker/docker-compose.prod.yml --env-file .env.prod"
export IMAGE_TAG="${IMAGE_TAG:-latest}"
$DC pull
$DC up -d --remove-orphans
sleep 3
$DC ps

say "Checking the service answers on loopback"
curl -fsS "http://127.0.0.1:$HOST_PORT/config.json" && echo

say "Remaining steps, by hand"
cat <<NEXT

1. Install the nginx block. Copy deploy/cueline.nginx.conf from the repo to
   /opt/cueline/docker/nginx/cueline.conf, then:

     mkdir -p /opt/cueline/docker/nginx
     ln -sf /opt/cueline/docker/nginx/cueline.conf /etc/nginx/sites-enabled/cueline.conf
     nginx -t && nginx -s reload

   That block carries three Upgrade headers the Orbya block does not have.
   Without them the websocket never establishes and no room ever pairs.

2. Add the Cloudflare DNS record for cueline.orbyatravel.com, PROXIED, orange
   cloud. A grey-cloud record is blackholed by UFW on this box.

3. No certificate work. The orbyatravel.com certificate is a wildcard.

4. Record the allocation in SERVER-SETUP.txt section 7:
     $HOST_PORT  cueline  signalling (Docker)

5. Add the CI deploy key to /root/.ssh/authorized_keys with the restrict prefix.

NEXT
