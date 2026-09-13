<#
  Phase 1 acceptance sequence (the decisive tests).

  Automates, against the REAL Tauri binary:

    4. Close the launcher while the harness is running -> the harness survives.
    5. Relaunch -> the new sidecar ADOPTS the same harness (same pid, no respawn).

  Plus the surrounding lifecycle: a fresh sidecar starts `stopped`, a start
  reaches `running`, and the recorded pid/url are stable across the launcher's
  death.

  WHY THIS IS DRIVEN OVER HTTP: clicking "Start Harness" in the webview cannot be
  automated (WebView2 exposes no assertable accessibility tree - see
  src-tauri/NOTES.md). But /harness/start is the SAME code path the button
  invokes through the `harness_start` command, and everything this test asserts
  (detached survival, adoption, no second spawn) happens AFTER that point. So the
  process-level sequence is fully automated; only the click itself is manual.

  Usage:  powershell -NoProfile -File src-tauri/test/acceptance.ps1
  Exits 0 on success, 1 on failure.

  Requires: a built debug binary (cargo build) and an installed harness.
#>

$ErrorActionPreference = 'Stop'

$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe        = Join-Path $repoRoot 'src-tauri\target\debug\dsh-dock.exe'
$dataDir    = Join-Path $repoRoot '.test-tmp\acceptance-data'
$stateFile  = Join-Path $dataDir 'runtime-state.json'
$portFile   = Join-Path $dataDir 'sidecar.port'

$failures = 0
# Last observed harness status text, set by Get-HarnessStatus. Script scope so
# Wait-For closures can read it reliably (the $script: prefix inside a param()
# default is resolved before the script scope exists).
$stateText = ''
$lastStatus = ''

function Check([string]$Label, [bool]$Ok, [string]$Detail = '') {
    $status = if ($Ok) { 'PASS' } else { 'FAIL' }
    $suffix = if ($Detail) { " - $Detail" } else { '' }
    Write-Host "  [$status] $Label$suffix"
    if (-not $Ok) { $script:failures++ }
}

function Get-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 20 -ErrorAction Stop }
    catch { return $null }
}

function Post-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 20 -ErrorAction Stop }
    catch { return $null }
}

<#
  Reads harness status and records it in $script:lastStatus.

  Wrapped in a function because Wait-For takes a scriptblock and a bare
  `$script:x = ...` assignment inside one resolves inconsistently across
  PowerShell versions.
#>
function Get-HarnessStatus([int]$Port) {
    $result = Get-Json "http://127.0.0.1:$Port/harness/status"
    if ($null -ne $result) { $script:lastStatus = [string]$result.status }
    return $result
}

<#
  Launches the app with extra environment variables, then restores them.

  Deliberately not `Start-Process -Environment` (PowerShell 7.4+ only).
#>
function Start-Launcher([string]$Exe, [hashtable]$Env) {
    $saved = @{}
    foreach ($key in $Env.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $Env[$key], 'Process')
    }
    try {
        return Start-Process -FilePath $Exe -PassThru
    } finally {
        foreach ($key in $Env.Keys) {
            [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
        }
    }
}

function Wait-For([scriptblock]$Condition, [int]$TimeoutSec = 30, [int]$IntervalMs = 250) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $false
}

function Get-SidecarPort([int]$ProcessId) {
    # netstat -ano, never Get-NetTCPConnection (section 2.7).
    $lines = & netstat -ano 2>$null
    foreach ($line in $lines) {
        if ($line -match '^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            if ([int]$Matches[2] -eq $ProcessId) { return [int]$Matches[1] }
        }
    }
    return 0
}

function Get-SidecarChildPid([int]$ParentPid) {
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*sidecar*index.js*' } |
             Select-Object -First 1
    if ($child) { return [int]$child.ProcessId }
    return 0
}

<#
  Waits for the sidecar to be reachable and returns its LISTENING port.

  Why netstat on the sidecar's own pid rather than DSH_DOCK_PORT_FILE: the port
  file persists across a relaunch, so reading it could hand back the PREVIOUS
  sidecar's port. That would make the adoption assertions pass against a dead
  process - exactly the kind of false green this test exists to prevent.

  NOTE: the parameter is `$ProcessId`, never `$Pid` - PowerShell's `$PID` is a
  read-only automatic variable and assigning to it (case-insensitively) throws.

  netstat -ano, never Get-NetTCPConnection (section 2.7).
#>
function Wait-ForSidecarPort([int]$ProcessId, [int]$TimeoutSec = 40) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $port = Get-SidecarPort $ProcessId
        if ($port -gt 0) {
            $health = Get-Json "http://127.0.0.1:$port/health"
            if ($health -and $health.ok -eq $true) { return $port }
        }
        Start-Sleep -Milliseconds 250
    }
    return 0
}

function Get-MainWindowHandle([int]$ProcessId) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { return $proc.MainWindowHandle }
    return 0
}

<#
  Sends a raw HTTP GET over a real TCP connection and returns the status code,
  or 0 when nothing answered.

  Deliberately not Invoke-WebRequest: the harness answers the token URL with a
  303 (token -> signed cookie redirect), which Invoke-WebRequest treats as an
  error, and Windows PowerShell 5.1 has no -SkipHttpErrorCheck to suppress that.
  A raw socket also keeps this honest as "is something listening and speaking
  HTTP", which is exactly what section 2.7 asks for.
#>
function Get-HttpStatus([string]$Url) {
    try {
        $uri = [Uri]$Url
        $client = New-Object System.Net.Sockets.TcpClient
        $connect = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(4000, $false)) { $client.Close(); return 0 }
        $client.EndConnect($connect)

        $path = if ($uri.PathAndQuery) { $uri.PathAndQuery } else { '/' }
        $request = "GET $path HTTP/1.1`r`nHost: $($uri.Host):$($uri.Port)`r`nConnection: close`r`nUser-Agent: dsh-dock-acceptance`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($request)

        $stream = $client.GetStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $stream.ReadTimeout = 4000
        $buffer = New-Object byte[] 256
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $client.Close()

        if ($read -le 0) { return 0 }
        $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        if ($text -match '^HTTP/\d\.\d\s+(\d{3})') { return [int]$Matches[1] }
        return 0
    } catch {
        return 0
    }
}

Write-Host 'DSH-Dock Phase 1 acceptance sequence'
Write-Host "  exe:      $([System.IO.Path]::GetFileName($exe))"
Write-Host "  data dir: .test-tmp\acceptance-data"

if (-not (Test-Path $exe)) {
    Check 'the debug binary exists' $false "run: cargo build --manifest-path src-tauri\Cargo.toml"
    Write-Host "`nRESULT: $failures check(s) failed"
    exit 1
}

# Start from a clean slate so "adopt" cannot be satisfied by a leftover.
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
if (Test-Path $stateFile) { Remove-Item $stateFile -Force }
if (Test-Path $portFile)  { Remove-Item $portFile -Force }

$app1 = $null
$app2 = $null
$harnessPid = 0
$harnessUrl = $null

try {
    # ---------------------------------------------------------------------
    Write-Host "`n[1] Launch the launcher"
    # ---------------------------------------------------------------------
    # DSH_DOCK_PORT_FILE is a test-only mirror of the sidecar's port (see
    # src-tauri/NOTES.md); the Rust shell never reads it.
    $app1 = Start-Launcher -Exe $exe -Env @{
        DSH_DOCK_DATA_DIR = $dataDir
        DSH_DOCK_PORT_FILE = $portFile
    }

    $sidecarPid1 = 0
    $sawChild = Wait-For { $script:sidecarPid1 = Get-SidecarChildPid $app1.Id; return ($script:sidecarPid1 -gt 0) } 60
    Check 'the launcher spawned its sidecar as a child process' $sawChild "sidecar pid=$sidecarPid1"

    if (-not $sawChild) { throw 'No sidecar child process appeared.' }

    $sidecarPort = Wait-ForSidecarPort $sidecarPid1 40
    Check 'the sidecar is listening and healthy on 127.0.0.1' ($sidecarPort -gt 0) "port=$sidecarPort"
    if ($sidecarPort -le 0) { throw 'The sidecar never became reachable.' }
    Check 'the announced port file agrees with the listening socket' ((Get-Content $portFile -Raw).Trim() -eq "$sidecarPort") "file=$((Get-Content $portFile -Raw).Trim()) socket=$sidecarPort"

    $status0 = Get-HarnessStatus $sidecarPort
    Check 'status is `stopped` on a clean start' ($status0.status -eq 'stopped') "status=$($status0.status)"

    # ---------------------------------------------------------------------
    Write-Host "`n[2] Start the harness (the same path the Start button invokes)"
    # ---------------------------------------------------------------------
    $startRes = Post-Json "http://127.0.0.1:$sidecarPort/harness/start"
    Check 'start was accepted' ($null -ne $startRes) 

    $running = Wait-For {
        $null = Get-HarnessStatus $sidecarPort
        return ($script:lastStatus -eq 'running' -or $script:lastStatus -eq 'error')
    } 300 500
    Check 'the harness reached `running`' ($lastStatus -eq 'running') "final status=$lastStatus"

    $status1 = Get-HarnessStatus $sidecarPort
    $harnessPid = [int]$status1.pid
    $harnessUrl = $status1.url
    Check 'a harness pid is reported' ($harnessPid -gt 0) "pid=$harnessPid"
    Check 'the harness url is the IPv4 literal with a token' ($harnessUrl -like 'http://127.0.0.1:*token=*') $harnessUrl
    Check 'the harness process is alive' ($null -ne (Get-Process -Id $harnessPid -ErrorAction SilentlyContinue))
    Check 'runtime-state.json records it' (Test-Path $stateFile)

    # ---------------------------------------------------------------------
    Write-Host "`n[3] Close the launcher while the harness is running"
    # ---------------------------------------------------------------------
    $handle = Get-MainWindowHandle $app1.Id
    Check 'the main window exists (so this is a real window close)' ($handle -ne 0)

    if ($handle -ne 0) {
        $closed = (Get-Process -Id $app1.Id).CloseMainWindow()
        Check 'the close request was delivered' ($closed -eq $true)
    }

    $appGone = Wait-For { $null -eq (Get-Process -Id $app1.Id -ErrorAction SilentlyContinue) } 30
    Check 'the launcher process exited' $appGone
    if (-not $appGone) { Stop-Process -Id $app1.Id -Force -ErrorAction SilentlyContinue }

    Start-Sleep -Seconds 2

    # TEST 4 -----------------------------------------------------------------
    Check 'THE HARNESS SURVIVED the launcher closing' ($null -ne (Get-Process -Id $harnessPid -ErrorAction SilentlyContinue)) "harness pid=$harnessPid"

    # The harness answers the token URL with a 303 (it exchanges the token for a
    # signed cookie and redirects). A 3xx IS the proof of serving; following the
    # redirect would loop, so the status code is read from the raw response.
    $servingStatus = Get-HttpStatus $harnessUrl
    Check 'the harness is STILL SERVING on its recorded url' ($servingStatus -gt 0) "http status=$servingStatus"

    Check 'the sidecar is gone with the launcher' ($null -eq (Get-Process -Id $sidecarPid1 -ErrorAction SilentlyContinue)) "sidecar pid=$sidecarPid1"

    # ---------------------------------------------------------------------
    Write-Host "`n[4] Relaunch and adopt (no second spawn)"
    # ---------------------------------------------------------------------
    $app2 = Start-Launcher -Exe $exe -Env @{
        DSH_DOCK_DATA_DIR = $dataDir
        DSH_DOCK_PORT_FILE = $portFile
    }

    $sidecarPid2 = 0
    $sawChild2 = Wait-For { $script:sidecarPid2 = Get-SidecarChildPid $app2.Id; return ($script:sidecarPid2 -gt 0) } 60
    Check 'the relaunched launcher spawned a sidecar' $sawChild2 "sidecar pid=$sidecarPid2"
    Check 'this is a NEW sidecar process' ($sidecarPid2 -gt 0 -and $sidecarPid2 -ne $sidecarPid1) "old=$sidecarPid1 new=$sidecarPid2"

    # Resolved from the NEW sidecar's own socket, so a stale port file cannot
    # make the adoption assertions pass against the dead first sidecar.
    $sidecarPort2 = Wait-ForSidecarPort $sidecarPid2 40
    Check 'the new sidecar is listening and healthy' ($sidecarPort2 -gt 0) "port=$sidecarPort2"
    if ($sidecarPort2 -le 0) { throw 'The relaunched sidecar never became reachable.' }

    # TEST 5 -----------------------------------------------------------------
    $status2 = Get-HarnessStatus $sidecarPort2
    Check 'status is `running` IMMEDIATELY after relaunch (adopted)' ($status2.status -eq 'running') "status=$($status2.status)"
    Check 'the ADOPTED pid is the original harness pid' ([int]$status2.pid -eq $harnessPid) "$($status2.pid) vs $harnessPid"
    Check 'the ADOPTED url is the original url' ($status2.url -eq $harnessUrl)

    # A start on an adopted harness must be a no-op returning 200.
    $adoptStart = Post-Json "http://127.0.0.1:$sidecarPort2/harness/start"
    Check 'start on the adopted harness reports running' ($adoptStart.status -eq 'running') "status=$($adoptStart.status)"
    Check 'NO second harness was spawned' ([int]$adoptStart.pid -eq $harnessPid) "$($adoptStart.pid) vs $harnessPid"
    Check 'the harness process is still the same one' ($null -ne (Get-Process -Id $harnessPid -ErrorAction SilentlyContinue))

    # ---------------------------------------------------------------------
    Write-Host "`n[5] Clean shutdown"
    # ---------------------------------------------------------------------
    $stopRes = Post-Json "http://127.0.0.1:$sidecarPort2/harness/stop"
    Check 'stop reported `stopped`' ($stopRes.status -eq 'stopped') "status=$($stopRes.status)"
    Start-Sleep -Seconds 1
    Check 'the harness process is gone after stop' ($null -eq (Get-Process -Id $harnessPid -ErrorAction SilentlyContinue))
    Check 'state was cleared' (-not (Test-Path $stateFile))

} catch {
    Check "acceptance sequence threw: $($_.Exception.Message)" $false
} finally {
    foreach ($p in @($app1, $app2)) {
        if ($p) {
            $live = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
            if ($live) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    # Leave no orphan harness behind from this test.
    if ($harnessPid -gt 0) {
        $live = Get-Process -Id $harnessPid -ErrorAction SilentlyContinue
        if ($live) { Stop-Process -Id $harnessPid -Force -ErrorAction SilentlyContinue }
    }
    # Make sure no launcher-spawned sidecar is left.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*sidecar/index.js*' -and $_.CommandLine -like '*acceptance*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'RESULT: all checks passed'
    exit 0
} else {
    Write-Host "RESULT: $failures check(s) failed"
    exit 1
}
