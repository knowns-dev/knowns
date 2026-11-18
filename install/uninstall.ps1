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

# The launcher is knowns.exe (and the kn.exe copy), the engine sits beside it as knowns-engine.exe
# (spec mcp-thin-proxy D10), knowns-proxy.exe is the launcher's old name. The *.old, *.new and
# *.tmp leftovers of an install or update go too; one still held by a running process stays and is
# reported, the next install sweeps it.
$names = @($Binary, $AliasBinary, "knowns-engine.exe", "knowns-proxy.exe")
$targets = @()
foreach ($name in $names) {
    $targets += (Join-Path $InstallDir $name)
    $targets += @(Get-ChildItem -Path $InstallDir -Filter "$name.*" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}
foreach ($target in ($targets | Select-Object -Unique)) {
    if (Test-Path $target) {
        try {
            Remove-Item -Path $target -Force -ErrorAction Stop
            Write-Host "  + Removed $target" -ForegroundColor Green
            $removed = $true
        } catch {
            # A running exe cannot be deleted but can be renamed out of the way.
            try {
                Move-Item -Path $target -Destination "$target.old.$([DateTime]::UtcNow.Ticks)" -Force -ErrorAction Stop
                Write-Host "  + Moved aside $target (in use; remove the .old file after it exits)" -ForegroundColor Yellow
                $removed = $true
            } catch {
                Write-Host "  x Could not remove $target ($($_.Exception.Message))" -ForegroundColor Red
            }
        }
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
