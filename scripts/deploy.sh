#!/usr/bin/env bash
# VVTerm deploy script (macOS).
#
#   scripts/deploy.sh dev  [--fast] [--fixtures] [--run] [--dry-run]
#   scripts/deploy.sh prod [--version X.Y.Z] [--e2e] [--tag] [--publish] [--yes]
#                          [--allow-dirty] [--allow-branch] [--skip-tests] [--platform P] [--dry-run]
#
# dev   Builds a debug app (devtools enabled) and installs it as "VVTerm Dev" next to the production
#       app, with its own bundle id and data directory, plus a `vvterm-dev` launcher.
# prod  Release pipeline: gates -> tests -> build -> sign -> notarize -> zip + SHA256SUMS.
#       Nothing leaves your machine unless you pass --publish (which also needs --tag and a confirmation).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$(go env GOPATH 2>/dev/null || echo "$HOME/go")/bin"

DRY=0
say()  { printf '\033[1m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { printf '+ %s\n' "$*"; [ "$DRY" = 1 ] || "$@"; }

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

TARGET="${1:-}"
[ -n "$TARGET" ] || usage 1
shift || true
case "$TARGET" in dev|prod) ;; -h|--help) usage 0 ;; *) die "unknown target '$TARGET' (use dev or prod)" ;; esac

# ---------- options ----------
FAST=0 FIXTURES=0 LAUNCH=0
VERSION_ARG="" E2E=0 TAG=0 PUBLISH=0 YES=0 ALLOW_DIRTY=0 ALLOW_BRANCH=0 SKIP_TESTS=0 PLATFORM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --fast) FAST=1 ;;
    --fixtures) FIXTURES=1 ;;
    --run) LAUNCH=1 ;;
    --version) VERSION_ARG="${2:?--version needs a value}"; shift ;;
    --e2e) E2E=1 ;;
    --tag) TAG=1 ;;
    --publish) PUBLISH=1 ;;
    --yes) YES=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-branch) ALLOW_BRANCH=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --platform) PLATFORM="${2:?--platform needs a value}"; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown option '$1'" ;;
  esac
  shift
done

# shellcheck disable=SC1090
. "deploy/env.$TARGET"
[ "$(uname -s)" = Darwin ] || die "this script builds the macOS app; run it on a Mac"
for t in go node npm wails; do command -v "$t" >/dev/null || die "missing tool: $t"; done

BASE_VERSION="$(tr -d '[:space:]' < VERSION)"
[[ "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must be semver X.Y.Z, got '$BASE_VERSION'"
APP_SRC="build/bin/vvterm.app"
ARCH="${PLATFORM:+${PLATFORM#*/}}"; ARCH="${ARCH:-$(uname -m)}"; [ "$ARCH" = x86_64 ] && ARCH=amd64
PLATFORM_ARGS=(); [ -n "$PLATFORM" ] && PLATFORM_ARGS=(-platform "$PLATFORM")

run_tests() {
  say "Go: vet + tests (race)"
  run go vet ./...
  run go test -race -count=1 ./...
  say "Frontend: typecheck + tests"
  run bash -c 'cd frontend && npm ci --no-audit --no-fund && npx tsc --noEmit && npx vitest run'
}

build_app() { # $1 = version string, rest = extra wails flags
  local version="$1"; shift
  say "Building VVTerm $version"
  run wails build -ldflags "-X vvterm/app.Version=$version" -trimpath ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} "$@"
  [ "$DRY" = 1 ] || [ -d "$APP_SRC" ] || die "build did not produce $APP_SRC"
}

# ============================== dev ==============================
deploy_dev() {
  local sha version app launcher
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  version="$BASE_VERSION-dev.$sha"
  app="$DEV_APP_DIR"; launcher="$DEV_BIN_DIR/vvterm-dev"

  if [ "$FAST" = 1 ]; then warn "--fast: skipping tests"; else
    say "Quick checks"
    run go vet ./...
    run go test -count=1 ./internal/... ./app/...
    run bash -c 'cd frontend && npx tsc --noEmit && npx vitest run'
  fi
  build_app "$version" -debug

  say "Installing as VVTerm Dev -> $app"
  run mkdir -p "$(dirname "$app")"
  run rm -rf "$app"
  run ditto "$APP_SRC" "$app"
  if [ "$DRY" != 1 ]; then
    local plist="$app/Contents/Info.plist"
    set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"; }
    set_plist CFBundleName "VVTerm Dev"
    set_plist CFBundleDisplayName "VVTerm Dev"
    set_plist CFBundleIdentifier "com.wails.vvterm-dev"
    codesign --force --deep --sign - "$app" >/dev/null 2>&1 || warn "ad-hoc codesign failed (the app may still run locally)"
  else
    echo "+ (patch Info.plist: name 'VVTerm Dev', bundle id com.wails.vvterm-dev; ad-hoc codesign)"
  fi

  say "Launcher -> $launcher (data in $DEV_DATA_DIR)"
  run mkdir -p "$DEV_BIN_DIR" "$DEV_DATA_DIR"
  if [ "$DRY" != 1 ]; then
    cat > "$launcher" <<LAUNCH
#!/usr/bin/env bash
# Starts VVTerm Dev with its own data directory (never touches the production data).
exec open -n --env "VVTERM_DATA_DIR=$DEV_DATA_DIR" "$app" "\$@"
LAUNCH
    chmod +x "$launcher"
  else
    echo "+ (write launcher that runs: open -n --env VVTERM_DATA_DIR=... '$app')"
  fi

  if [ "$FIXTURES" = 1 ]; then
    say "Dev fixtures (demo SSH servers on :2201/:2202, Git remote on :9418)"
    run docker compose --profile dev up -d --build
  fi
  [ "$LAUNCH" = 1 ] && { say "Launching"; run "$launcher"; }
  say "Dev deploy done: $version"
}

# ============================== prod ==============================
gate() { say "Gate: $1"; }

deploy_prod() {
  local version="${VERSION_ARG:-$BASE_VERSION}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z, got '$version'"
  [ "$version" = "$BASE_VERSION" ] || die "--version $version differs from the VERSION file ($BASE_VERSION): bump VERSION first"
  [ "$PUBLISH" = 0 ] || [ "$TAG" = 1 ] || die "--publish needs --tag"

  gate "release notes describe $version"
  grep -q "^# VVTerm $version\$" RELEASE_NOTES.md || die "RELEASE_NOTES.md has no '# VVTerm $version' heading: write the notes first"

  gate "git state"
  if [ "$ALLOW_DIRTY" = 1 ]; then warn "--allow-dirty: building from an unclean tree"; else
    [ -z "$(git status --porcelain)" ] || die "working tree is not clean (commit or stash, or use --allow-dirty)"
  fi
  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$ALLOW_BRANCH" = 1 ]; then warn "--allow-branch: releasing from '$branch'"; else
    [ "$branch" = "$RELEASE_BRANCH" ] || die "releases are cut from '$RELEASE_BRANCH', you are on '$branch'"
  fi
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    [ "$(git rev-list -n1 "v$version")" = "$(git rev-parse HEAD)" ] || die "tag v$version already exists and points elsewhere"
  fi

  if [ "$SKIP_TESTS" = 1 ]; then warn "--skip-tests: releasing WITHOUT running the test suite"; else run_tests; fi
  [ "$E2E" = 1 ] && { say "End-to-end walkthrough"; run ./e2e/run.sh; }

  build_app "$version"

  say "Signing"
  if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    run codesign --force --deep --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$APP_SRC"
    run codesign --verify --deep --strict --verbose=2 "$APP_SRC"
  else
    warn "CODESIGN_IDENTITY not set: ad-hoc signing only (Gatekeeper will block this build on other Macs)"
    run codesign --force --deep --sign - "$APP_SRC"
  fi

  say "Packaging"
  local zip="$DIST_DIR/VVTerm-$version-macos-$ARCH.zip"
  run mkdir -p "$DIST_DIR"
  run rm -f "$zip"
  run ditto -c -k --keepParent "$APP_SRC" "$zip"

  if [ -n "${NOTARY_PROFILE:-}" ] && [ -n "${CODESIGN_IDENTITY:-}" ]; then
    say "Notarizing (this can take a few minutes)"
    run xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    run xcrun stapler staple "$APP_SRC"
    run rm -f "$zip"
    run ditto -c -k --keepParent "$APP_SRC" "$zip"
  elif [ -n "${NOTARY_PROFILE:-}" ]; then
    warn "NOTARY_PROFILE is set but CODESIGN_IDENTITY is not: skipping notarization"
  else
    warn "not notarized (set NOTARY_PROFILE after signing with a Developer ID)"
  fi

  say "Checksums"
  run bash -c "cd '$DIST_DIR' && shasum -a 256 *.zip > SHA256SUMS && cat SHA256SUMS"

  if [ "$TAG" = 1 ]; then
    say "Tagging v$version (local)"
    git rev-parse -q --verify "refs/tags/v$version" >/dev/null && echo "tag v$version already at HEAD" \
      || run git tag -a "v$version" -m "VVTerm $version"
  fi

  if [ "$PUBLISH" = 1 ]; then
    command -v gh >/dev/null || die "--publish needs the GitHub CLI (gh)"
    say "Publish plan"
    echo "  1. git push origin v$version"
    echo "  2. gh release create v$version  (assets: $zip, $DIST_DIR/SHA256SUMS; notes: RELEASE_NOTES.md)"
    if [ "$YES" != 1 ] && [ "$DRY" != 1 ]; then
      read -r -p "Type the version ($version) to confirm publishing: " answer
      [ "$answer" = "$version" ] || die "confirmation mismatch, nothing published"
    fi
    run git push origin "v$version"
    run gh release create "v$version" "$zip" "$DIST_DIR/SHA256SUMS" --title "VVTerm $version" --notes-file RELEASE_NOTES.md
  else
    say "Not published. To release: $0 prod --tag --publish"
  fi
  say "Prod build done: $zip"
}

case "$TARGET" in
  dev) deploy_dev ;;
  prod) deploy_prod ;;
esac
