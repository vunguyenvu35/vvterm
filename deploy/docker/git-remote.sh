#!/bin/sh
# Dev-only Git remote for testing VVTerm sync: anonymous git:// with push enabled.
# NEVER expose this beyond localhost; it has no authentication.
set -eu
REPO=/srv/git/vvterm-sync.git
if [ ! -d "$REPO" ]; then
  git init --bare --initial-branch=main "$REPO"
fi
exec git daemon --reuseaddr --verbose --export-all --enable=receive-pack --base-path=/srv/git /srv/git
