# Freeze the FastAPI backend with PyInstaller and stage it as a Tauri sidecar.
#
# Usage (from repo root):
#   powershell -File scripts/build_sidecar.ps1
#
# Output:
#   src-tauri/binaries/ifc-backend-<target-triple>.exe
#
# After this finishes, `npm run tauri:build` will pick the binary up via
# `bundle.externalBin` in tauri.conf.json and embed it in the installer.
#
# NOTE on PS 5.1 quirks: native exes like PyInstaller write INFO lines to
# stderr. We deliberately do NOT set $ErrorActionPreference='Stop' here -
# it would convert every INFO line into a terminating error. We check
# $LASTEXITCODE after each native call instead.

# Repo root = parent of this script's directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# Ensure rustc is reachable so we can read the host triple.
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path (Join-Path $cargoBin 'rustc.exe')) {
        $env:PATH = "$cargoBin;$env:PATH"
    } else {
        Write-Error "rustc not found. Install with: winget install Rustlang.Rustup"
        exit 1
    }
}

$hostLine = (& rustc -vV) | Select-String '^host:'
if (-not $hostLine) {
    Write-Error "Could not parse host triple from rustc -vV"
    exit 1
}
$Triple = ($hostLine -split '\s+')[1]
Write-Host "[build_sidecar] target triple: $Triple"

# Sanity-check Python + PyInstaller.
$pyVersion = & python --version
if ($LASTEXITCODE -ne 0) { Write-Error "python not on PATH"; exit 1 }
Write-Host "[build_sidecar] $pyVersion"

& python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[build_sidecar] installing pyinstaller..."
    & python -m pip install --quiet pyinstaller
    if ($LASTEXITCODE -ne 0) { Write-Error "pip install pyinstaller failed"; exit 1 }
}

# Bundle the Node fragment-converter (backend/sidecar) into a single
# dist/index.cjs + staged web-ifc wasm, so installed apps can spawn it with
# plain `node` - no node_modules, no npx. sidecar_manager.py prefers this
# bundle over the `npx tsx` dev fallback (see resolve_sidecar_command).
# npm is always present on Tauri build machines (frontend build needs it).
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm not found on PATH (needed to bundle backend/sidecar)"
    exit 1
}
Push-Location (Join-Path $RepoRoot 'backend\sidecar')
try {
    Write-Host "[build_sidecar] npm install (backend/sidecar)..."
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed in backend/sidecar"; exit 1 }
    Write-Host "[build_sidecar] bundling fragment converter (esbuild)..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed in backend/sidecar"; exit 1 }
} finally {
    Pop-Location
}

# Run PyInstaller inside backend/ so paths in the spec resolve.
Push-Location (Join-Path $RepoRoot 'backend')
try {
    Write-Host "[build_sidecar] running PyInstaller (this takes a few minutes)..."
    & python -m PyInstaller --clean --noconfirm ifc-backend.spec
    if ($LASTEXITCODE -ne 0) {
        Write-Error "PyInstaller exited with $LASTEXITCODE. Inspect backend\build\ifc-backend\warn-ifc-backend.txt"
        exit 1
    }
} finally {
    Pop-Location
}

$src = Join-Path $RepoRoot 'backend\dist\ifc-backend.exe'
if (-not (Test-Path $src)) {
    Write-Error "Expected backend\dist\ifc-backend.exe not produced. Check backend\build\ifc-backend\warn-ifc-backend.txt for hidden-import warnings."
    exit 1
}

$binariesDir = Join-Path $RepoRoot 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $binariesDir | Out-Null

$dest = Join-Path $binariesDir "ifc-backend-$Triple.exe"
Copy-Item -Path $src -Destination $dest -Force
$sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "[build_sidecar] staged $dest ($sizeMb MB)"

Write-Host ""
Write-Host "Next:"
Write-Host "  npm run tauri:build"
Write-Host "  # installer lands in src-tauri\target\release\bundle\"
