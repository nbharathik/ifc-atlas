#!/usr/bin/env bash
# Freeze the FastAPI backend with PyInstaller and stage it as a Tauri sidecar.
# Unix (Linux/macOS) port of scripts/build_sidecar.ps1.
#
# Usage (from repo root):
#   bash scripts/build_sidecar.sh
#
# Output:
#   src-tauri/binaries/ifc-backend-<target-triple>
#
# After this finishes, `npm run tauri:build` picks the binary up via
# `bundle.externalBin` in tauri.conf.json and embeds it in the bundle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Ensure rustc is reachable so we can read the host triple.
if ! command -v rustc >/dev/null 2>&1; then
  if [ -x "$HOME/.cargo/bin/rustc" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    echo "ERROR: rustc not found. Install via https://rustup.rs" >&2
    exit 1
  fi
fi

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$TRIPLE" ]; then
  echo "ERROR: could not parse host triple from rustc -vV" >&2
  exit 1
fi
echo "[build_sidecar] target triple: $TRIPLE"

# Sanity-check Python + PyInstaller. Override the interpreter with PYTHON=...
PYTHON="${PYTHON:-python3}"
echo "[build_sidecar] $("$PYTHON" --version)"

if ! "$PYTHON" -c "import PyInstaller" 2>/dev/null; then
  echo "[build_sidecar] installing pyinstaller..."
  "$PYTHON" -m pip install --quiet pyinstaller
fi

# Bundle the Node fragment-converter (backend/sidecar) into a single
# dist/index.cjs + staged web-ifc wasm, so installed apps can spawn it with
# plain `node` - no node_modules, no npx. sidecar_manager.py prefers this
# bundle over the `npx tsx` dev fallback (see resolve_sidecar_command).
# npm is always present on Tauri build machines (frontend build needs it).
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found on PATH (needed to bundle backend/sidecar)" >&2
  exit 1
fi
echo "[build_sidecar] bundling fragment converter (npm install + build)..."
(cd backend/sidecar && npm install --no-audit --no-fund && npm run build)

# Run PyInstaller inside backend/ so paths in the spec resolve.
echo "[build_sidecar] running PyInstaller (this takes a few minutes)..."
(cd backend && "$PYTHON" -m PyInstaller --clean --noconfirm ifc-backend.spec)

# On Unix the EXE() name has no extension (Windows gets .exe automatically).
SRC="backend/dist/ifc-backend"
if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not produced. Check backend/build/ifc-backend/warn-ifc-backend.txt for hidden-import warnings." >&2
  exit 1
fi

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/ifc-backend-$TRIPLE"
cp -f "$SRC" "$DEST"
chmod +x "$DEST"
SIZE_MB="$(du -m "$DEST" | cut -f1)"
echo "[build_sidecar] staged $DEST (${SIZE_MB} MB)"

echo ""
echo "Next:"
echo "  npm run tauri:build"
echo "  # bundles land in src-tauri/target/release/bundle/"
