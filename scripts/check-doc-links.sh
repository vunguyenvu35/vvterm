#!/usr/bin/env bash
# Every screenshot that README.md and docs/*.md link to must exist. The end-to-end run numbers its
# screenshots, so a new step shifts the numbers and breaks links: this tells which ones.
set -euo pipefail
cd "$(dirname "$0")/.."
bad=0
for f in README.md docs/*.md; do
  d=$(dirname "$f")
  for p in $(grep -o '(\(docs/\)\{0,1\}screenshots/[^)]*)' "$f" | tr -d '()'); do
    case $p in docs/*) t=$p ;; *) t="$d/$p" ;; esac
    [ -f "$t" ] || { echo "broken image link in $f: $p"; bad=1; }
  done
done
exit $bad
