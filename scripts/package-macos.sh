#!/usr/bin/env bash
# Package build/bin/vvterm.app into dist/vvterm-<version>-macos.{dmg,zip}.
# Usage: scripts/package-macos.sh [--build]   (--build runs `make build` first)
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(cat VERSION)"
APP="build/bin/vvterm.app"
OUT="dist"
BASE="vvterm-${VERSION}-macos"

if [ "${1:-}" = "--build" ]; then
  make build
fi

if [ ! -d "$APP" ]; then
  echo "error: $APP not found (run 'make build' or pass --build)" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT/$BASE.zip" "$OUT/$BASE.dmg"

# ZIP: ditto keeps symlinks, resource forks and signatures intact.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$BASE.zip"

# DMG: app + /Applications shortcut for drag-to-install.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "vvterm $VERSION" -srcfolder "$STAGE" \
  -fs HFS+ -format UDZO -ov "$OUT/$BASE.dmg" >/dev/null

(cd "$OUT" && shasum -a 256 "$BASE.dmg" "$BASE.zip" | tee "$BASE.sha256")
echo "done: $OUT/$BASE.dmg, $OUT/$BASE.zip"
