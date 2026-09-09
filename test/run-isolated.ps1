# run-isolated.ps1
# Launches the launcher (built exe, or the .ps1 directly) in a fully isolated
# sandbox so it can be tested WITHOUT touching the real install
# (%LOCALAPPDATA%\DeepSeekHarness) or the real dsh profile (%USERPROFILE%\.dsh)
# that the user's live DeepSeek Harness session uses.
#
# Usage:
#   .\test\run-isolated.ps1            start an isolated instance (first run)
#   .\test\run-isolated.ps1 -Raw       run dsh-app.ps1 instead of the built exe
#   .\test\run-isolated.ps1 -Clean     wipe the isolated sandbox and exit
#
# Each launch keeps its own private runtime, edge profile, settings and dsh
# home, listens on its own port (8877), and can only ever kill processes that
# belong to itself. The real install is untouched.

param([switch]$Clean, [switch]$Raw)

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:TEMP 'DSHLauncher-Test'
$data = Join-Path $root 'data'
$home = Join-Path $root 'dsh-home'
$port = '8877'

if ($Clean) {
    if (Test-Path $root) {
        Remove-Item $root -Recurse -Force
        Write-Host "Removed $root"
    } else {
        Write-Host 'Sandbox is already clean.'
    }
    exit 0
}

# Do not start a second instance against the same sandbox while one is running.
$mutexName = 'DSHLauncherTest_' + ($data -replace '[^A-Za-z0-9]', '_')
$m = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $m.WaitOne(0)) {
    Write-Host 'An isolated test instance is already running. Close its window first, or run -Clean.' -ForegroundColor Yellow
    exit 1
}
$m.ReleaseMutex()
$m.Dispose()

New-Item -ItemType Directory -Force -Path $root | Out-Null

$env:DSH_DATA_DIR = $data
$env:DSH_HOME     = $home
$env:DSH_PORT     = $port

if ($Raw) {
    $ps1 = Join-Path $PSScriptRoot '..\Windows\dsh-app.ps1'
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ps1`"")
} else {
    $exe = Join-Path $PSScriptRoot '..\Windows\build\DSHLauncher.exe'
    if (-not (Test-Path $exe)) {
        throw "Built launcher not found at $exe - run build.ps1 first (or use -Raw)."
    }
    Start-Process $exe
}

Write-Host 'Isolated instance started.' -ForegroundColor Green
Write-Host "  Data dir : $data   (runtime, edge profile, settings, logs)"
Write-Host "  DSH_HOME : $home   (dsh profile/sessions for this test only)"
Write-Host "  Port     : $port"
Write-Host ''
Write-Host 'The real install in %LOCALAPPDATA%\DeepSeekHarness and %USERPROFILE%\.dsh is untouched.'
Write-Host 'To wipe the sandbox later:  .\test\run-isolated.ps1 -Clean'
