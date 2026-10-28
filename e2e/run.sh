#!/usr/bin/env bash
# Runs the end-to-end walkthrough on a fresh data directory:
#   1. builds the demo SSH server
#   2. starts `wails dev -browser` (real Go backend, SQLite, vault) on http://localhost:34115
#   3. drives the UI with Playwright and writes screenshots to docs/screenshots
# The demo SSH servers are started and stopped by walkthrough.mjs itself.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export PATH="$PATH:$(go env GOPATH)/bin"
trap 'kill ${WAILS_PID:-0} 2>/dev/null || true' EXIT

cd "$ROOT"
go build -o "$WORK/demoserver" ./cmd/demoserver

mkdir -p "$WORK/ssh/config.d" "$WORK/data" "$WORK/shots"
printf 'Include config.d/*\n' > "$WORK/ssh/config"
cat > "$WORK/ssh/config.d/legacy-staging" <<'CFG'
# vvterm: env=staging tags=mariadb,internal
Host db-staging
    HostName 10.20.0.5
    Port 2222
    User dba
    ProxyJump bastion-legacy
    LocalForward 3306 127.0.0.1:3306

Host bastion-legacy
    HostName bastion.legacy.example.com
    User ops
CFG

VVTERM_DATA_DIR="$WORK/data" wails dev -browser -skipbindings -loglevel error > "$WORK/wails.log" 2>&1 &
WAILS_PID=$!
for _ in $(seq 1 90); do
  curl -s -o /dev/null -m 2 http://localhost:34115 && break
  sleep 2
done

cd "$ROOT/e2e"
[ -d node_modules ] || npm install --no-audit --no-fund
npx playwright install chromium >/dev/null
DEMOSERVER="$WORK/demoserver" SSH_CONFIG_DIR="$WORK/ssh" SHOT_DIR="$WORK/shots" node walkthrough.mjs
mkdir -p "$ROOT/docs/screenshots"
cp "$WORK"/shots/*.png "$ROOT/docs/screenshots/"
echo "screenshots copied to docs/screenshots"
