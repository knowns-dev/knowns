# Knowns CLI installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.ps1 | iex
#
# Options (via env vars):
#   $env:KNOWNS_INSTALL_DIR  — install directory (default: ~\.knowns\bin)
#   $env:KNOWNS_VERSION      — specific version (default: latest)
#   $env:KNOWNS_BASE_URL     — release download prefix (default: GitHub releases)

$ErrorActionPreference = "Stop"

$Repo = "knowns-dev/knowns"
$Binary = "knowns.exe"
$AliasBinary = "kn.exe"
$DefaultInstallDir = Join-Path $env:USERPROFILE ".knowns\bin"
$KnownsHome = Join-Path $env:USERPROFILE ".knowns"
$InstallDir = if ($env:KNOWNS_INSTALL_DIR) { $env:KNOWNS_INSTALL_DIR } else { $DefaultInstallDir }

# ─── Platform detection ───────────────────────────────────────────────

function Get-Platform {
    $arch = if ([System.Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or
            [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") {
            "arm64"
        } else {
            "x64"
        }
    } else {
        Write-Host "  x Unsupported: 32-bit systems are not supported" -ForegroundColor Red
        exit 1
    }
    return "win-$arch"
}

# ─── Version resolution ──────────────────────────────────────────────

function Get-Version {
    if ($env:KNOWNS_VERSION) {
        $v = $env:KNOWNS_VERSION
        if (-not $v.StartsWith("v")) { $v = "v$v" }
        return $v
    }

    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    if (-not $release.tag_name) {
        Write-Host "  x Failed to determine latest version" -ForegroundColor Red
        exit 1
    }
    return $release.tag_name
}

# ─── Main ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Knowns CLI Installer" -ForegroundColor Cyan
Write-Host ""

$Platform = Get-Platform
$Version = Get-Version

$Archive = "knowns-$Platform.tar.gz"
$BaseUrl = if ($env:KNOWNS_BASE_URL) { $env:KNOWNS_BASE_URL.TrimEnd('/') } else { "https://github.com/$Repo/releases/download" }
$Url = "$BaseUrl/$Version/$Archive"
$ChecksumUrl = "$Url.sha256"

Write-Host "  Version:  $Version" -ForegroundColor DarkGray
Write-Host "  Platform: $Platform" -ForegroundColor DarkGray
Write-Host "  Install:  $InstallDir" -ForegroundColor DarkGray
Write-Host ""

# Create temp dir
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "knowns-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    # Download archive
    Write-Host "  . Downloading $Archive..." -NoNewline -ForegroundColor DarkGray
    Invoke-WebRequest -Uri $Url -OutFile (Join-Path $TmpDir $Archive) -UseBasicParsing
    Write-Host "`r  + Downloaded $Archive        " -ForegroundColor Green

    # Download & verify checksum
    Write-Host "  . Verifying checksum..." -NoNewline -ForegroundColor DarkGray
    try {
        Invoke-WebRequest -Uri $ChecksumUrl -OutFile (Join-Path $TmpDir "$Archive.sha256") -UseBasicParsing
        $expected = (Get-Content (Join-Path $TmpDir "$Archive.sha256")).Split(" ")[0]
        $actual = (Get-FileHash (Join-Path $TmpDir $Archive) -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) {
            Write-Host "`r  x Checksum mismatch!" -ForegroundColor Red
            Write-Host "    Expected: $expected" -ForegroundColor Red
            Write-Host "    Got:      $actual" -ForegroundColor Red
            exit 1
        }
        Write-Host "`r  + Checksum verified          " -ForegroundColor Green
    } catch {
        Write-Host "`r  - Checksum file not available, skipped" -ForegroundColor DarkGray
    }

    # Extract
    Write-Host "  . Extracting..." -NoNewline -ForegroundColor DarkGray
    tar -xzf (Join-Path $TmpDir $Archive) -C $TmpDir
    Write-Host "`r  + Extracted                  " -ForegroundColor Green

    # Find the main binary (knowns.exe specifically — avoid matching knowns-embed.exe)
    $ExtractedBin = Get-ChildItem -Path $TmpDir -Filter "knowns.exe" -Recurse | Select-Object -First 1
    if (-not $ExtractedBin) {
        Write-Host "  x knowns.exe not found in archive" -ForegroundColor Red
        exit 1
    }
    $ExtractRoot = $ExtractedBin.Directory.FullName

    # Install bundle
    Write-Host "  . Installing to $InstallDir..." -NoNewline -ForegroundColor DarkGray
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path $ExtractedBin.FullName -Destination (Join-Path $InstallDir $Binary) -Force
    Copy-Item -Path $ExtractedBin.FullName -Destination (Join-Path $InstallDir $AliasBinary) -Force

    # Colocated ONNX Runtime DLLs
    foreach ($pattern in @("onnxruntime*.dll")) {
        Get-ChildItem -Path $ExtractRoot -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination (Join-Path $InstallDir $_.Name) -Force
        }
    }
    Write-Host "`r  + Installed to $InstallDir\$Binary        " -ForegroundColor Green
    Write-Host "  + Installed alias $InstallDir\$AliasBinary" -ForegroundColor Green

    $metadata = @{
        method = "script"
        managedBy = "knowns-script"
        updateStrategy = "self-update"
        channel = "stable"
        platform = "windows"
        arch = if ($Platform -like "*-arm64") { "arm64" } else { "amd64" }
        binaryPath = (Join-Path $InstallDir $Binary)
        version = $Version.TrimStart('v')
        installedAt = [DateTime]::UtcNow.ToString("o")
    }
    New-Item -ItemType Directory -Path $KnownsHome -Force | Out-Null
    # Windows PowerShell 5.1's -Encoding UTF8 adds a BOM; write BOM-less UTF-8.
    [IO.File]::WriteAllText((Join-Path $KnownsHome "install.json"), ($metadata | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  + Recorded install metadata in $KnownsHome\install.json" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
        $env:Path = "$InstallDir;$env:Path"
        Write-Host "  + Added $InstallDir to PATH" -ForegroundColor Green
    }

    # Verify
    Write-Host ""
    try {
        $installedVersion = & (Join-Path $InstallDir $Binary) --version 2>$null
        Write-Host "  Knowns CLI $installedVersion installed successfully!" -ForegroundColor Green
    } catch {
        Write-Host "  Knowns CLI installed successfully!" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "  Get started:" -ForegroundColor DarkGray
    Write-Host "    knowns init" -ForegroundColor DarkGray
    Write-Host "    knowns task create `"My first task`"" -ForegroundColor DarkGray
    Write-Host "" 
    Write-Host "  Uninstall:" -ForegroundColor DarkGray
    Write-Host "    irm https://github.com/$Repo/releases/download/$Version/uninstall.ps1 | iex" -ForegroundColor DarkGray
    Write-Host ""

} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
