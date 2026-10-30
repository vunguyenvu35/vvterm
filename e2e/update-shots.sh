#!/usr/bin/env bash
# Screenshots of the update features (the Update chip, About, the update switch, Donate) into docs/updates.
# Like run.sh but short: a fresh data directory, a stand-in for GitHub's "latest release" answering 9.9.9, and a
# build that says it is 1.1.0, so the app sees a newer version.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export PATH="$PATH:$(go env GOPATH)/bin"
trap 'kill ${WAILS_PID:-0} ${HTTP_PID:-0} 2>/dev/null || true' EXIT

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

mkdir -p "$WORK/gh" "$WORK/data" "$WORK/shots"
cat > "$WORK/gh/latest" <<'JSON'
{"tag_name":"v9.9.9","html_url":"https://github.com/vunguyenvu35/vvterm/releases/tag/v9.9.9","body":"A newer release."}
JSON
GH_PORT="$(free_port)"
(cd "$WORK/gh" && python3 -m http.server "$GH_PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
HTTP_PID=$!

PORT="$(free_port)"
URL="http://127.0.0.1:$PORT"
cd "$ROOT"
# `wails dev -browser` opens the default browser at the dev server. The walkthrough drives its own Chromium, and an extra tab
# showing the unlock screen (a focused password field) makes macOS turn on secure input for every app, which stops input
# tools such as OpenKey and GoTiengViet. `open` and `xdg-open` do nothing for the wails process.
mkdir -p "$WORK/noopen"
for c in open xdg-open; do printf '#!/bin/sh\nexit 0\n' > "$WORK/noopen/$c"; chmod +x "$WORK/noopen/$c"; done

PATH="$WORK/noopen:$PATH" VVTERM_UPDATE_URL="http://127.0.0.1:$GH_PORT/latest" VVTERM_NO_NATIVE_DIALOGS=1 VVTERM_DATA_DIR="$WORK/data" \
  wails dev -browser -devserver "127.0.0.1:$PORT" -skipbindings -loglevel error -ldflags "-X vvterm/app.Version=1.1.0" > "$WORK/wails.log" 2>&1 &
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
VVTERM_URL="$URL" SHOT_DIR="$WORK/shots" node update-shots.mjs
mkdir -p "$ROOT/docs/updates"
cp "$WORK"/shots/*.png "$ROOT/docs/updates/"
echo "screenshots copied to docs/updates"
