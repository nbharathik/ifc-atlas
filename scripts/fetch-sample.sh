#!/usr/bin/env bash
# Downloads the BasicHouse.ifc sample model (~50 MB) from the GitHub Release
# into the two places the app and tests expect it:
#   data/fixtures/BasicHouse.ifc   (tests + benchmarks + demo build)
#   frontend/public/BasicHouse.ifc (served at /BasicHouse.ifc by the Vite
#                                   dev server for quick manual testing)
#
# Usage:  ./scripts/fetch-sample.sh [--force]

set -euo pipefail

SAMPLE_URL="https://github.com/nbharathik/ifc-atlas/releases/download/v1.0.0/BasicHouse.ifc"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGETS=(
  "$REPO_ROOT/data/fixtures/BasicHouse.ifc"
  "$REPO_ROOT/frontend/public/BasicHouse.ifc"
)

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

all_present=1
for t in "${TARGETS[@]}"; do
  [[ -f "$t" ]] || all_present=0
done
if [[ $all_present -eq 1 && $FORCE -eq 0 ]]; then
  echo "Sample model already present:"
  printf '  %s\n' "${TARGETS[@]}"
  echo "Use --force to re-download."
  exit 0
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "Downloading BasicHouse.ifc (~50 MB) from:"
echo "  $SAMPLE_URL"
curl -fL --progress-bar -o "$tmp" "$SAMPLE_URL"

size=$(wc -c < "$tmp")
if [[ "$size" -lt 1000000 ]]; then
  echo "Download looks wrong ($size bytes). Check the release asset URL." >&2
  exit 1
fi

for t in "${TARGETS[@]}"; do
  mkdir -p "$(dirname "$t")"
  cp "$tmp" "$t"
  echo "  -> $t"
done
echo "Done."
