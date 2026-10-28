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

# A free port, so this never collides with a "wails dev" you already have open (default 34115).
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
URL="http://127.0.0.1:$PORT"
for p in 2201 2202; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is busy (docker compose --profile dev?). Stop that first: the demo SSH servers need 2201 and 2202." >&2
    exit 1
  fi
done

VVTERM_NO_NATIVE_DIALOGS=1 VVTERM_DATA_DIR="$WORK/data" wails dev -browser -devserver "127.0.0.1:$PORT" -skipbindings -loglevel error > "$WORK/wails.log" 2>&1 &
WAILS_PID=$!
UP=0
for _ in $(seq 1 90); do
  curl -s -o /dev/null -m 2 "$URL" && UP=1 && break
  sleep 2
done
[ "$UP" = 1 ] || { echo "the dev server did not start; see $WORK/wails.log" >&2; exit 1; }

cd "$ROOT/e2e"
[ -d node_modules ] || npm install --no-audit --no-fund
npx playwright install chromium >/dev/null
VVTERM_URL="$URL" DEMOSERVER="$WORK/demoserver" SSH_CONFIG_DIR="$WORK/ssh" SHOT_DIR="$WORK/shots" node walkthrough.mjs
mkdir -p "$ROOT/docs/screenshots"
rm -f "$ROOT"/docs/screenshots/*.png # numbering changes between runs: drop stale shots
cp "$WORK"/shots/*.png "$ROOT/docs/screenshots/"
echo "screenshots copied to docs/screenshots"
