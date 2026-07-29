#!/usr/bin/env bash
# Deploys sirony-connect. Run from the project root ON THE VPS.
#
#   ./deploy/deploy.sh
#
# Idempotent: safe to re-run for updates.
set -euo pipefail

cd "$(dirname "$0")/.."

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

# --- Secrets -----------------------------------------------------------------
# Generated on the server so the database password never leaves this machine.
if [ ! -f .env ]; then
  log "No .env found — generating one"
  POSTGRES_PASSWORD="$(openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-32)"
  cat > .env <<EOF
POSTGRES_USER=connect
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=connect
HOST_PORT=${HOST_PORT:-8097}
PUBLIC_ORIGIN=https://connect.sirony.in
LOG_LEVEL=info
EOF
  chmod 600 .env
  echo "    .env written (mode 600)"
else
  echo "    .env already present — leaving it alone"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
HOST_PORT="${HOST_PORT:-8097}"

# --- Preflight ---------------------------------------------------------------
log "Checking that port ${HOST_PORT} is free"
# Ignore a binding owned by this project, so re-runs don't trip the check.
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:${HOST_PORT}\b"; then
  if docker compose ps --status running 2>/dev/null | grep -q .; then
    echo "    port ${HOST_PORT} held by this project — fine, redeploying"
  else
    fail "port ${HOST_PORT} is already in use by another project.
    You have several sirony-* projects on this box. Pick a free port:
      ss -tlnp | grep LISTEN
    then set HOST_PORT in .env and re-run. Remember to update
    deploy/nginx/connect.sirony.in.conf to match."
  fi
fi

log "Checking DNS for connect.sirony.in"
if ! getent hosts connect.sirony.in >/dev/null 2>&1; then
  cat <<'EOF'
    WARNING: connect.sirony.in does not resolve.

    The containers will still start and be reachable on the loopback port,
    but nginx + certbot cannot issue a certificate until DNS exists.
    Add an A record:  connect.sirony.in -> 147.93.107.173
EOF
fi

# --- Deploy ------------------------------------------------------------------
log "Building and starting containers"
docker compose up -d --build

log "Waiting for the app to report ready"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/readyz" >/dev/null 2>&1; then
    echo "    ready after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    docker compose logs --tail 40 app
    fail "app did not become ready within 30s (logs above)"
  fi
  sleep 1
done

log "Deployed"
docker compose ps
cat <<EOF

Local check:
  curl http://127.0.0.1:${HOST_PORT}/healthz

Still to do for public access at https://connect.sirony.in:
  1. A record: connect.sirony.in -> 147.93.107.173
  2. sudo cp deploy/nginx/connect.sirony.in.conf /etc/nginx/sites-available/connect.sirony.in
     sudo ln -sf /etc/nginx/sites-available/connect.sirony.in /etc/nginx/sites-enabled/
  3. sudo certbot --nginx -d connect.sirony.in
  4. sudo nginx -t && sudo systemctl reload nginx
EOF
