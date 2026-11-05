# Builds the Windows installers (NSIS setup .exe and optionally MSI) for new/.
# This script was NOT executed while creating the sources. Run it on a machine
# with Node.js 20.19+ (required by the Vite+ toolchain), Rust (stable, MSVC
# toolchain), the WebView2 runtime and the WiX/NSIS prerequisites that Tauri
# downloads on the first bundle run.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Bundles nsis
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipInstall

param(
    [ValidateSet("nsis", "msi", "all")]
    [string]$Bundles = "all",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot "lib-versions.ps1")

Assert-Command "node" "Install Node.js 20.19+ and reopen the terminal."
Assert-Command "bun" "Install Bun (https://bun.sh) and reopen the terminal."
Assert-Command "cargo" "Install the Rust toolchain with the MSVC target (rustup default stable-x86_64-pc-windows-msvc)."

$project = Get-ProjectVersion -Root $root
Write-Host "Version: $($project.Version) ($($project.Identifier))" -ForegroundColor Cyan

if (-not (Test-Path "node_modules")) {
    if ($SkipInstall) {
        throw "node_modules is missing and -SkipInstall was set."
    }
    Write-Host "Installing frontend dependencies (bun install)..." -ForegroundColor Cyan
    bun install
}

$bundleArg = if ($Bundles -eq "all") { "nsis,msi" } else { $Bundles }
Write-Host "Building Redis Desktop Manager bundles: $bundleArg" -ForegroundColor Cyan
# `tauri build` runs `bun run build` (tsc --noEmit + vp build) before compiling
# the Rust workspace.
bun run tauri:build -- --bundles $bundleArg
if ($LASTEXITCODE -ne 0) {
    throw "tauri build failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Artifacts:" -ForegroundColor Green
Get-ChildItem -Path "src-tauri/target/release/bundle" -Recurse -File -Include *.exe, *.msi |
    ForEach-Object { Write-Host "  $($_.FullName)" }

Write-Host ""
Write-Host "Portable executable:" -ForegroundColor Green
Write-Host "  src-tauri/target/release/resp-app.exe"
