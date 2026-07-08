# Downloads the BasicHouse.ifc sample model (~50 MB) from the GitHub Release
# into the two places the app and tests expect it:
#   data/fixtures/BasicHouse.ifc   (tests + benchmarks + demo build)
#   frontend/public/BasicHouse.ifc (served at /BasicHouse.ifc by the Vite
#                                   dev server for quick manual testing)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fetch-sample.ps1
#         scripts/fetch-sample.ps1 -Force      # re-download even if present

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$SampleUrl = "https://github.com/nbharathik/ifc-atlas/releases/download/v1.0.0/BasicHouse.ifc"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Targets = @(
    (Join-Path $RepoRoot "data\fixtures\BasicHouse.ifc"),
    (Join-Path $RepoRoot "frontend\public\BasicHouse.ifc")
)

$existing = $Targets | Where-Object { Test-Path $_ }
if ($existing.Count -eq $Targets.Count -and -not $Force) {
    Write-Host "Sample model already present:"
    $Targets | ForEach-Object { Write-Host "  $_" }
    Write-Host "Use -Force to re-download."
    exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "BasicHouse.ifc.download"
Write-Host "Downloading BasicHouse.ifc (~50 MB) from:"
Write-Host "  $SampleUrl"
Invoke-WebRequest -Uri $SampleUrl -OutFile $tmp -UseBasicParsing

$size = (Get-Item $tmp).Length
if ($size -lt 1MB) {
    Remove-Item $tmp -Force
    throw "Download looks wrong ($size bytes). Check the release asset URL."
}

foreach ($target in $Targets) {
    $dir = Split-Path -Parent $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Copy-Item $tmp $target -Force
    Write-Host "  -> $target"
}
Remove-Item $tmp -Force
Write-Host "Done. $([math]::Round($size / 1MB, 1)) MB."
