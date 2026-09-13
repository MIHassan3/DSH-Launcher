<#
  Console-window regression check.

  Verifies that the processes the launcher creates do NOT get a console window -
  the "stray black node.exe window" bug. It spawns real children using the exact
  spawn shapes the product uses, then asks `console_probe.exe` whether each one
  has a console attached.

  The probe is a GUI-subsystem binary with no console of its own, which is what
  makes `AttachConsole` a valid test: it can only succeed if the target has one.

  Usage:  powershell -NoProfile -File src-tauri/test/console-check.ps1
  Exits 0 on success, 1 on failure.

  First run builds the probe with rustc (a few seconds).
#>

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tmp      = Join-Path $repoRoot '.test-tmp\console-check'
$probeSrc = Join-Path $PSScriptRoot 'console-probe.rs'
$probe    = Join-Path $tmp 'console_probe.exe'

$failures = 0
function Check([string]$Label, [bool]$Ok, [string]$Detail = '') {
    $status = if ($Ok) { 'PASS' } else { 'FAIL' }
    $suffix = if ($Detail) { " - $Detail" } else { '' }
    Write-Host "  [$status] $Label$suffix"
    if (-not $Ok) { $script:failures++ }
}

<#
  True when a verdict means "the target exists and has no console".

  The probe reports `none`, `none(err=6)` or `none(err=31)` depending on how the
  target was created - Windows returns different codes and both mean the same
  thing here. Asserting equality against "none" made healthy processes look like
  failures.
#>
function Is-NoConsole([string]$Verdict) {
    return $Verdict -like 'none*'
}

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'console-check: not applicable off Windows'
    exit 0
}

Write-Host 'DSH-Dock console-window check'

New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$rustc = Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe'
if (-not (Test-Path $rustc)) { $rustc = 'rustc' }

if (-not (Test-Path $probe)) {
    Write-Host '  building console_probe.exe...'
    & $rustc -O -o $probe $probeSrc 2>&1 | Out-String | Write-Host
}
Check 'the console probe was built' (Test-Path $probe)

$script:probeSeq = 0
function Test-Console([int]$ProcessId) {
    # The probe writes its verdict to a FILE: FreeConsole detaches it from the
    # caller's terminal, so anything printed afterwards can be lost.
    $script:probeSeq++
    $out = Join-Path $tmp "verdict-$($script:probeSeq).txt"
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    & $probe $ProcessId $out 2>$null | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-Path $out) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path $out)) { return '(no-verdict)' }
    return (Get-Content $out -Raw).Trim()
}

# ---------------------------------------------------------------------------
Write-Host "`n[1] Control: a child WITHOUT CREATE_NO_WINDOW gets a console"
# ---------------------------------------------------------------------------
# This proves the probe can actually detect a console - without it, every
# "none" result below would be meaningless.
$plain = Start-Process -FilePath 'node' -ArgumentList '-e', 'setTimeout(()=>{},4000)' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 900
$plainVerdict = Test-Console $plain.Id
Check 'a plain console-subsystem child reports a console' ($plainVerdict -eq 'console') "verdict=$plainVerdict"
Stop-Process -Id $plain.Id -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
Write-Host "`n[2] The SIDECAR spawn shape must have no console"
# ---------------------------------------------------------------------------
# Mirrors src-tauri/src/lib.rs spawn_sidecar: node, piped stdio, detached-ish,
# CREATE_NO_WINDOW. Started via Start-Process we cannot pass creationFlags, so
# this uses the shell's own mechanism: the real launcher.
$dataDir = Join-Path $tmp 'data'
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$exe = Join-Path $repoRoot 'src-tauri\target\release\dsh-dock.exe'
Check 'the release binary exists' (Test-Path $exe) 'run: cargo build --release'

$env:DSH_DOCK_DATA_DIR = $dataDir
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 6

$sidecar = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($app.Id)" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*sidecar*index.js*' } |
           Select-Object -First 1
Check 'the launcher spawned a sidecar' ($null -ne $sidecar)

if ($sidecar) {
    $verdict = Test-Console $sidecar.ProcessId
    Check 'the SIDECAR has no console window' (Is-NoConsole $verdict) "verdict=$verdict pid=$($sidecar.ProcessId)"
}

# ---------------------------------------------------------------------------
Write-Host "`n[3] The HARNESS spawn shape must have no console"
# ---------------------------------------------------------------------------
if ($sidecar) {
    $port = 0
    foreach ($line in (& netstat -ano 2>$null)) {
        if ($line -match '^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            if ([int]$Matches[2] -eq [int]$sidecar.ProcessId) { $port = [int]$Matches[1]; break }
        }
    }
    Check 'the sidecar is listening' ($port -gt 0) "port=$port"

    if ($port -gt 0) {
        # The harness may already be running from a previous state file, in which
        # case `start` adopts it; either way we end up with a live harness pid.
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/harness/start" -Method Post -TimeoutSec 30
        $deadline = (Get-Date).AddSeconds(300)
        do {
            Start-Sleep -Milliseconds 700
            $s = Invoke-RestMethod -Uri "http://127.0.0.1:$port/harness/status" -TimeoutSec 20
        } while ($s.status -eq 'starting' -and (Get-Date) -lt $deadline)

        Check 'the harness reached running' ($s.status -eq 'running') "status=$($s.status)"

        if ($s.pid) {
            $verdict = Test-Console ([int]$s.pid)
            Check 'the HARNESS has no console window' (Is-NoConsole $verdict) "verdict=$verdict pid=$($s.pid)"
        }

        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/harness/stop" -Method Post -TimeoutSec 20 -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
Write-Host "`n[4] The launcher itself must have no console"
# ---------------------------------------------------------------------------
if ($app) {
    $verdict = Test-Console $app.Id
    Check 'the launcher GUI process has no console window' (Is-NoConsole $verdict) "verdict=$verdict"
}

# Cleanup.
#
# Deliberately narrow: only processes whose command line names THIS test's data
# directory are stopped. Killing node processes by name would also kill unrelated
# node processes - including the DSH runtime that may be hosting the shell
# running this script, which tears down the whole job (observed).
if ($app) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*console-check*' -or $_.CommandLine -like "*$dataDir*" } |
    Where-Object { $_.CommandLine -notlike '*runner.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'RESULT: all checks passed'
    exit 0
} else {
    Write-Host "RESULT: $failures check(s) failed"
    exit 1
}
