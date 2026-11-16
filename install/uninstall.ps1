# Knowns CLI uninstaller for Windows
# Usage:
#   irm https://raw.githubusercontent.com/knowns-dev/knowns/main/install/uninstall.ps1 | iex
#
# Options (via env vars):
#   $env:KNOWNS_INSTALL_DIR  — install directory (default: ~\.knowns\bin)

$ErrorActionPreference = "Stop"

$Binary = "knowns.exe"
$AliasBinary = "kn.exe"
$DefaultInstallDir = Join-Path $env:USERPROFILE ".knowns\bin"
$InstallDir = if ($env:KNOWNS_INSTALL_DIR) { $env:KNOWNS_INSTALL_DIR } else { $DefaultInstallDir }

function Remove-UserPathEntry {
    param([string]$Target)

    $current = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $current) {
        return
    }

    $updated = (($current -split ';') | Where-Object { $_ -and $_.TrimEnd('\\') -ne $Target.TrimEnd('\\') }) -join ';'
    if ($updated -ne $current) {
        [System.Environment]::SetEnvironmentVariable("Path", $updated, "User")
        $env:Path = (($env:Path -split ';') | Where-Object { $_ -and $_.TrimEnd('\\') -ne $Target.TrimEnd('\\') }) -join ';'
        Write-Host "  + Removed $Target from PATH" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "  Knowns CLI Uninstaller" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Install:  $InstallDir" -ForegroundColor DarkGray
Write-Host ""

$removed = $false

foreach ($name in @($Binary, $AliasBinary, "knowns-proxy.exe", "knowns-proxy.exe.old")) {
    $target = Join-Path $InstallDir $name
    if (Test-Path $target) {
        Remove-Item -Path $target -Force
        Write-Host "  + Removed $target" -ForegroundColor Green
        $removed = $true
    }
}

Remove-UserPathEntry -Target $InstallDir

if ((Test-Path $InstallDir) -and -not (Get-ChildItem -Path $InstallDir -Force | Select-Object -First 1)) {
    Remove-Item -Path $InstallDir -Force
}

if (-not $removed) {
    Write-Host "  - No Knowns binaries found in $InstallDir" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Knowns CLI uninstall complete" -ForegroundColor Green
Write-Host "  Project folders and .knowns data were left untouched" -ForegroundColor DarkGray
Write-Host ""
