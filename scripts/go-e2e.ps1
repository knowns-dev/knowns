# Runs the Go e2e suite (tests/) with a throwaway home directory on Windows.
#
# The suite runs the knowns binary with the caller's environment, so without this wrapper every
# run registers its TestCLI_* / TestMCP_* temp projects in the real %USERPROFILE%\.knowns\runtime\
# projects.json (and can touch the rest of %USERPROFILE%\.knowns). tests/ is frozen Go code
# (spec D2), so the isolation lives here instead.
#
# Usage: [$env:TEST_BINARY = "path\to\knowns.exe"] scripts\go-e2e.ps1 [go test flags...]
#   powershell -File scripts\go-e2e.ps1 -v -timeout 90m
#   $env:TEST_BINARY = "cli\dist\windows-x64\knowns.exe"; scripts\go-e2e.ps1 -v -run TestCLI
# Without TEST_BINARY the suite uses bin\knowns.exe (building it if missing). Exit code is go test's.
# go test flags are taken from $args, so PowerShell does not try to bind -v or -run itself.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# go test runs in tests\, so a relative TEST_BINARY would resolve there. Pin it to the caller's cwd.
if ($env:TEST_BINARY) {
  if (-not [IO.Path]::IsPathRooted($env:TEST_BINARY)) {
    $env:TEST_BINARY = Join-Path (Get-Location).Path $env:TEST_BINARY
  }
  if (-not (Test-Path -LiteralPath $env:TEST_BINARY -PathType Leaf)) {
    [Console]::Error.WriteLine("go-e2e: TEST_BINARY is not a file: $($env:TEST_BINARY)")
    exit 2
  }
}

# Pin Go's caches and its env file to their real locations BEFORE moving the home directories;
# otherwise go would rebuild everything into the temp home and lose `go env -w` settings.
$env:GOPATH = (& go env GOPATH)
$env:GOMODCACHE = (& go env GOMODCACHE)
$env:GOCACHE = (& go env GOCACHE)
$env:GOENV = (& go env GOENV)

$tmpHome = Join-Path ([IO.Path]::GetTempPath()) ("knowns-go-e2e-home-" + [Guid]::NewGuid().ToString("N").Substring(0, 12))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

$saved = @{}
foreach ($name in "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "KNOWNS_RUNTIME_INLINE", "KNOWNS_RUNTIME_ROOT", "KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT", "KNOWNS_PROJECT", "NO_UPDATE_CHECK") {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$status = 1
try {
  # Go and Bun take the home dir from USERPROFILE on Windows; HOME covers git and anything Unix-minded.
  $env:HOME = $tmpHome
  $env:USERPROFILE = $tmpHome
  # Claude Desktop config and other per-user state live under APPDATA / LOCALAPPDATA.
  $env:APPDATA = Join-Path $tmpHome "AppData\Roaming"
  $env:LOCALAPPDATA = Join-Path $tmpHome "AppData\Local"
  New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
  foreach ($name in "KNOWNS_RUNTIME_INLINE", "KNOWNS_RUNTIME_ROOT", "KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT", "KNOWNS_PROJECT") {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  if (-not $env:NO_UPDATE_CHECK) { $env:NO_UPDATE_CHECK = "1" }

  Push-Location $repoRoot
  try {
    # Windows PowerShell 5.1 can turn native stderr into terminating errors under "Stop".
    $ErrorActionPreference = "Continue"
    & go test ./tests/ -count=1 @args
    $status = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process") }
  # A child that just exited can hold a handle for a moment; retry before giving up.
  for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $tmpHome); $i++) {
    Remove-Item -LiteralPath $tmpHome -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tmpHome) { Start-Sleep -Milliseconds 300 }
  }
  if (Test-Path -LiteralPath $tmpHome) { [Console]::Error.WriteLine("go-e2e: could not remove $tmpHome") }
}
exit $status
