#!/usr/bin/env bash
# Copies the shared core from the CI Speed Check GitHub Action into src/core as exact byte copies.
# Usage: scripts/sync-core.sh [path-to-ci-speed-check]    (default: ../ci-speed-check)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="${1:-$here/../ci-speed-check}"
src="$(cd "$src" && pwd)/src"

if [ ! -f "$src/rules.js" ] || [ ! -f "$src/history.js" ] || [ ! -f "$src/vendor/js-yaml.min.js" ]; then
  echo "sync-core: $src does not look like the ci-speed-check action (rules.js, history.js, vendor/js-yaml.min.js)" >&2
  exit 1
fi

mkdir -p "$here/src/core/vendor"
for f in rules.js history.js vendor/js-yaml.min.js vendor/LICENSE-js-yaml; do
  cp -f "$src/$f" "$here/src/core/$f"
  cmp -s "$src/$f" "$here/src/core/$f" || { echo "sync-core: copy of $f differs from the original" >&2; exit 1; }
  echo "synced $f  $(sha256sum "$here/src/core/$f" | cut -d' ' -f1)"
done
