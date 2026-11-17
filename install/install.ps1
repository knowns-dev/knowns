# Knowns CLI installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.ps1 | iex
#
# Options (via env vars):
#   $env:KNOWNS_INSTALL_DIR  — install directory (default: ~\.knowns\bin)
#   $env:KNOWNS_VERSION      — specific version (default: latest)
#   $env:KNOWNS_BASE_URL     — release download prefix (default: GitHub releases)
#   $env:KNOWNS_NO_MODIFY_PATH — set to 1 to leave your user PATH alone (a hint is printed instead)

$ErrorActionPreference = "Stop"

$Repo = "knowns-dev/knowns"
$Binary = "knowns.exe"
$AliasBinary = "kn.exe"
$Engine = "knowns-engine.exe"
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

    # Find the archive root: the folder with layout.json (launcher + engine archives) or knowns.exe.
    # In a launcher archive knowns.exe is the ENGINE (so an older updater installs something that
    # runs) and knowns.launcher.exe is the launcher; layout.json says which becomes which.
    $LayoutFile = Get-ChildItem -Path $TmpDir -Filter "layout.json" -Recurse | Select-Object -First 1
    $LauncherSrc = $null
    if ($LayoutFile) {
        $ExtractRoot = $LayoutFile.Directory.FullName
        $layout = Get-Content -Raw -Path $LayoutFile.FullName | ConvertFrom-Json
        if ($layout.layout -ne 1) {
            Write-Host "  x Unsupported archive layout $($layout.layout); update install.ps1" -ForegroundColor Red
            exit 1
        }
        $EngineSrc = Join-Path $ExtractRoot $layout.engine.file
        $LauncherSrc = Join-Path $ExtractRoot $layout.launcher.file
        if (-not (Test-Path $EngineSrc) -or -not (Test-Path $LauncherSrc)) {
            Write-Host "  x Archive is missing the launcher or the engine" -ForegroundColor Red
            exit 1
        }
    } else {
        # knowns.exe specifically (not knowns-embed.exe or the like)
        $ExtractedBin = Get-ChildItem -Path $TmpDir -Filter "knowns.exe" -Recurse | Select-Object -First 1
        if (-not $ExtractedBin) {
            Write-Host "  x knowns.exe not found in archive" -ForegroundColor Red
            exit 1
        }
        $ExtractRoot = $ExtractedBin.Directory.FullName
        $EngineSrc = $ExtractedBin.FullName
    }

    # Install bundle
    Write-Host "  . Installing to $InstallDir..." -NoNewline -ForegroundColor DarkGray
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    # A running exe cannot be overwritten or deleted on Windows but can be renamed, so each file is
    # moved aside to <name>.old first. A previous .old that is still running is locked: give the new
    # one a unique name rather than fail; the next install sweeps them.
    # The files go in as one unit: every new file is first copied next to its destination, then each
    # is swapped in, and a failure puts the already swapped ones back.
    function Install-Set($Items) {
        $staged = @()
        try {
            foreach ($it in $Items) {
                $tmp = "$($it.Dest).new"
                Copy-Item -Path $it.Source -Destination $tmp -Force -ErrorAction Stop
                $staged += $tmp
            }
        } catch {
            foreach ($t in $staged) { Remove-Item -Path $t -Force -ErrorAction SilentlyContinue }
            throw
        }
        $done = @()
        try {
            foreach ($it in $Items) {
                $aside = $null
                if (Test-Path $it.Dest) {
                    $aside = "$($it.Dest).old"
                    Remove-Item -Path $aside -Force -ErrorAction SilentlyContinue
                    if (Test-Path $aside) { $aside = "$($it.Dest).old.$([DateTime]::UtcNow.Ticks)" }
                    Move-Item -Path $it.Dest -Destination $aside -Force -ErrorAction Stop
                }
                try {
                    Move-Item -Path "$($it.Dest).new" -Destination $it.Dest -Force -ErrorAction Stop
                } catch {
                    if ($aside) { Move-Item -Path $aside -Destination $it.Dest -Force -ErrorAction SilentlyContinue }
                    throw
                }
                $done += @{ Dest = $it.Dest; Aside = $aside }
            }
        } catch {
            [array]::Reverse($done)
            foreach ($d in $done) {
                Remove-Item -Path $d.Dest -Force -ErrorAction SilentlyContinue
                if ($d.Aside) { Move-Item -Path $d.Aside -Destination $d.Dest -Force -ErrorAction SilentlyContinue }
            }
            foreach ($t in $staged) { Remove-Item -Path $t -Force -ErrorAction SilentlyContinue }
            throw
        }
    }
    function Remove-Exe($Path) {
        if (-not (Test-Path $Path)) { return }
        Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
        if (Test-Path $Path) { Move-Item -Path $Path -Destination "$Path.old.$([DateTime]::UtcNow.Ticks)" -Force -ErrorAction SilentlyContinue }
    }
    Get-ChildItem -Path $InstallDir -Filter "*.exe.old*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
    }

    $EngineDest = Join-Path $InstallDir $Engine
    $BinaryDest = Join-Path $InstallDir $Binary
    $AliasDest = Join-Path $InstallDir $AliasBinary
    if ($LauncherSrc) {
        # The engine first (an older launcher keeps working with it), then the launcher as knowns.exe
        # and as the kn.exe copy.
        Install-Set @(
            @{ Source = $EngineSrc; Dest = $EngineDest },
            @{ Source = $LauncherSrc; Dest = $BinaryDest },
            @{ Source = $LauncherSrc; Dest = $AliasDest }
        )
    } else {
        # An archive without a launcher (0.35 and older): the engine alone is knowns.exe and kn.exe.
        Install-Set @(
            @{ Source = $EngineSrc; Dest = $BinaryDest },
            @{ Source = $EngineSrc; Dest = $AliasDest }
        )
        Remove-Exe $EngineDest
    }
    # knowns-proxy.exe was a transitional name of the launcher.
    Remove-Exe (Join-Path $InstallDir "knowns-proxy.exe")

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

    # Add to PATH if not already there. KNOWNS_NO_MODIFY_PATH=1 leaves the persistent user PATH alone.
    $UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        if ($env:KNOWNS_NO_MODIFY_PATH -eq "1") {
            Write-Host "  . KNOWNS_NO_MODIFY_PATH=1: your PATH was not changed. To use knowns, add this directory to it:" -ForegroundColor DarkGray
            Write-Host "      $InstallDir" -ForegroundColor DarkGray
        } else {
            [System.Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
            $env:Path = "$InstallDir;$env:Path"
            Write-Host "  + Added $InstallDir to PATH" -ForegroundColor Green
        }
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
