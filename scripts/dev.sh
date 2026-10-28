#!/usr/bin/env bash
# Sets up a fresh macOS machine for development, then starts `make dev`.
#
#   scripts/dev.sh              set up whatever is missing, then run make dev
#   scripts/dev.sh --setup-only set up, do not start the app
#
# Installs (only when missing): Xcode Command Line Tools, Go, Node, and the Wails CLI pinned to the
# version in go.mod, so `wails dev` does not rewrite go.mod / go.sum.
set -euo pipefail
cd "$(dirname "$0")/.."

SETUP_ONLY=0
[ "${1:-}" = "--setup-only" ] && SETUP_ONLY=1

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script only supports macOS"

# Xcode Command Line Tools (needed by Wails to build on macOS). The installer is a GUI dialog.
if ! xcode-select -p >/dev/null 2>&1; then
  say "installing Xcode Command Line Tools"
  xcode-select --install || true
  die "finish the Xcode Command Line Tools installer, then run this script again"
fi

# Go and Node come from Homebrew.
need_brew=()
command -v go >/dev/null 2>&1 || need_brew+=(go)
command -v npm >/dev/null 2>&1 || need_brew+=(node)
if [ "${#need_brew[@]}" -gt 0 ]; then
  command -v brew >/dev/null 2>&1 || die "missing ${need_brew[*]} and Homebrew is not installed (https://brew.sh)"
  say "brew install ${need_brew[*]}"
  brew install "${need_brew[@]}"
fi

# Go must be at least the version go.mod asks for.
want_go=$(awk '/^go /{print $2}' go.mod)
have_go=$(go env GOVERSION | sed 's/^go//')
if [ "$(printf '%s\n%s\n' "$want_go" "$have_go" | sort -V | head -n1)" != "$want_go" ]; then
  die "Go $want_go or newer is required, found $have_go (brew upgrade go)"
fi

# Wails CLI at exactly the version go.mod pins.
want_wails=$(awk '$1=="github.com/wailsapp/wails/v2"{print $2; exit}' go.mod)
WAILS="$(go env GOPATH)/bin/wails"
have_wails=""
[ -x "$WAILS" ] && have_wails=$("$WAILS" version 2>/dev/null | grep -o 'v[0-9][0-9.]*' | head -n1 || true)
if [ "$have_wails" != "$want_wails" ]; then
  say "installing Wails CLI $want_wails (found: ${have_wails:-none})"
  go install "github.com/wailsapp/wails/v2/cmd/wails@$want_wails"
fi

say "go $have_go, node $(node -v), wails $want_wails"

[ "$SETUP_ONLY" -eq 1 ] && { say "setup done"; exit 0; }

say "make dev"
exec make dev
