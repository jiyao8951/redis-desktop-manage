# Builds ONLY the portable single-file executable (no NSIS/MSI bundles) and
# refreshes dist-release/ so the release directory always holds exactly one
# file. This script is the implementation behind `bun run tauri:build`, the
# single packaging entry point.
#
# Usage:
#   bun run tauri:build

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
    bun run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "tauri build --no-bundle failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path $releaseExe)) {
        throw "Expected binary not found: $releaseExe"
    }
    if ((Get-Item $releaseExe).Length -le 0) {
        throw "Binary is empty: $releaseExe"
    }

    # Never delete dist-release before the build: it may still hold the last
    # good release if the build fails. The folder is refreshed in place only
    # after the binary exists and passed the checks above.
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null

    $finalName = "RedisDesktopManager_${version}_portable_x64.exe"
    $finalPath = Join-Path $distDir $finalName
    $stagingPath = Join-Path $distDir ("{0}.partial" -f $finalName)
    Copy-Item $releaseExe $stagingPath -Force
    Copy-Item $stagingPath $finalPath -Force
    Remove-Item $stagingPath -Force

    # Keep exactly one artifact: drop files left behind by older runs.
    Get-ChildItem $distDir -Force |
        Where-Object { $_.Name -ne $finalName } |
        Remove-Item -Force -Recurse

    $items = @(Get-ChildItem $distDir -Force)
    if ($items.Count -ne 1 -or $items[0].Name -ne $finalName) {
        throw "dist-release must contain exactly '$finalName', found: $(($items | ForEach-Object { $_.Name }) -join ', ')."
    }

    # --no-bundle must not leave installers behind. Stale bundle output from an
    # earlier `tauri build` run is removed so only the portable exe survives.
    $bundleDir = Join-Path $root "src-tauri/target/release/bundle"
    if (Test-Path $bundleDir) {
        Remove-Item $bundleDir -Recurse -Force
    }
    if (Test-Path $bundleDir) {
        throw "Unexpected bundle output in $bundleDir; only the portable exe is allowed."
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
