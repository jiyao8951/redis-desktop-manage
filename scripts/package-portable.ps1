# Builds ONLY the portable single-file executable (no NSIS/MSI bundles) and
# copies it to dist-release/, so the release directory always holds exactly one
# file.
#
# Usage:
#   bun run package:portable
#   powershell -ExecutionPolicy Bypass -File scripts\package-portable.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot "lib-versions.ps1")

$distDir = Join-Path $root "dist-release"
$releaseExe = Join-Path $root "src-tauri/target/release/resp-app.exe"

try {
    Assert-Command "node" "Install Node.js 20.19+ and reopen the terminal."
    Assert-Command "bun" "Install Bun (https://bun.sh) and reopen the terminal."
    Assert-Command "cargo" "Install the Rust toolchain with the MSVC target (rustup default stable-x86_64-pc-windows-msvc)."

    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        throw "node_modules is missing. Run 'bun install' before packaging."
    }

    $project = Get-ProjectVersion -Root $root
    $version = $project.Version
    Write-Host "Version: $version ($($project.Identifier))" -ForegroundColor Cyan

    # Known local issue: a corrupted target/release/incremental cache makes
    # rustc 1.99 ICE (`no entry found for key` in rustc_metadata). This is a
    # build flag only; no project file or tauri config is touched.
    $env:CARGO_INCREMENTAL = "0"

    Write-Host "Building frontend + Rust release binary (no bundles)..." -ForegroundColor Cyan
    # `tauri build` runs `bun run build` (tsc --noEmit + vp build) first.
    # --no-bundle keeps NSIS and WiX out of the flow entirely.
    bun run tauri:build -- --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "tauri build --no-bundle failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path $releaseExe)) {
        throw "Expected binary not found: $releaseExe"
    }
    if ((Get-Item $releaseExe).Length -le 0) {
        throw "Binary is empty: $releaseExe"
    }

    # Clear dist-release only after a successful build, so a failed run never
    # leaves a half-written or stale release directory behind.
    if (Test-Path $distDir) {
        Remove-Item $distDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $distDir | Out-Null

    $finalName = "RedisDesktopManager_${version}_portable_x64.exe"
    $finalPath = Join-Path $distDir $finalName
    Copy-Item $releaseExe $finalPath

    $items = @(Get-ChildItem $distDir -Force)
    if ($items.Count -ne 1) {
        throw "dist-release must contain exactly one file, found $($items.Count)."
    }

    $hash = (Get-FileHash $finalPath -Algorithm SHA256).Hash.ToLower()
    Write-Host ""
    Write-Host "Portable executable:" -ForegroundColor Green
    Write-Host "  $finalPath"
    Write-Host ("  {0} bytes" -f (Get-Item $finalPath).Length)
    Write-Host "  SHA256 $hash"
} catch {
    Write-Host ""
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
