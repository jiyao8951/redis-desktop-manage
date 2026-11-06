# Shared helpers for the Windows packaging scripts.
# The version check lives here only, so build-windows.ps1 and
# package-portable.ps1 cannot drift apart.

function Assert-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing '$Name'. $Hint"
    }
}

function Get-ProjectVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Root
    )

    # tauri.conf.json is the authoritative version; fail early when the three
    # manifests drift so the artifact name and the exe version always match.
    $tauriConfig = Get-Content (Join-Path $Root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json
    $packageJson = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
    $cargoVersion = (Select-String -Path (Join-Path $Root "src-tauri/Cargo.toml") -Pattern '^version = "([^"]+)"' |
        Select-Object -First 1).Matches[0].Groups[1].Value

    if ($tauriConfig.version -ne $packageJson.version -or $tauriConfig.version -ne $cargoVersion) {
        throw "Version mismatch: tauri.conf.json=$($tauriConfig.version), package.json=$($packageJson.version), Cargo.toml=$cargoVersion"
    }

    return [pscustomobject]@{
        Version    = $tauriConfig.version
        Identifier = $tauriConfig.identifier
    }
}
