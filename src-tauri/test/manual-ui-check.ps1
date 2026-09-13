<#
  Interactive helper for the Step 6 checks that CANNOT be automated.

  WebView2 exposes no assertable accessibility tree and no injection path
  (src-tauri/NOTES.md), so "the dashboard rendered", "the Start button appeared"
  and "the harness window opened and rendered" must be confirmed by eye. This
  script removes every OTHER uncertainty so the visual check is unambiguous:

    1. launches the real launcher against an isolated data dir,
    2. drives the harness to `running` over the same HTTP path the button uses,
    3. reports the current window set, then
    4. waits while you click "Open Harness" and reports the window set again.

  Anything it cannot see, it says so rather than guessing.

  Usage:  powershell -NoProfile -File src-tauri/test/manual-ui-check.ps1
#>

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinList {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public class Info { public string Title = ""; public bool Visible; public uint Pid; }

    public static List<Info> List() {
        var results = new List<Info>();
        EnumWindows((hWnd, lParam) => {
            int len = GetWindowTextLength(hWnd);
            if (len > 0) {
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                uint pid; GetWindowThreadProcessId(hWnd, out pid);
                results.Add(new Info { Title = sb.ToString(), Visible = IsWindowVisible(hWnd), Pid = pid });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@

function Show-Windows([string]$Label) {
    Write-Host "`n--- $Label ---"
    $found = [WinList]::List() | Where-Object { $_.Title -like '*DSH-Dock*' -or $_.Title -like '*DeepSeek Harness*' }
    if (-not $found) { Write-Host '  (no DSH-Dock or DeepSeek Harness windows)'; return }
    $found | ForEach-Object {
        Write-Host ("  title='{0}' visible={1} pid={2}" -f $_.Title, $_.Visible, $_.Pid)
    }
}

function Get-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 20 -ErrorAction Stop }
    catch { return $null }
}

function Get-SidecarPort([int]$ProcessId) {
    # netstat -ano, never Get-NetTCPConnection (section 2.7).
    #
    # NOTE: the port and pid are captured INSIDE a single ForEach-Object body.
    # Passing the raw line into `Where-Object` first would re-evaluate $Matches
    # against the *filtered* result and lose the capture groups - matching twice
    # in one pass is the reliable form.
    $lines = & netstat -ano 2>$null
    foreach ($line in $lines) {
        if ($line -match '^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $listenPort = [int]$Matches[1]
            $listenPid = [int]$Matches[2]
            if ($listenPid -eq $ProcessId) { return $listenPort }
        }
    }
    return 0
}

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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe      = Join-Path $repoRoot 'src-tauri\target\debug\dsh-dock.exe'
$dataDir  = Join-Path $repoRoot '.test-tmp\manual-ui-data'
$liveData = Join-Path $repoRoot '.test-tmp\live-data'

# Reuse the already-installed harness if present, so this does not re-download.
if ((Test-Path (Join-Path $liveData 'versions')) -and -not (Test-Path (Join-Path $dataDir 'versions'))) {
    Write-Host "Seeding the data dir from .test-tmp\live-data (no re-download)..."
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Copy-Item (Join-Path $liveData 'versions') -Destination $dataDir -Recurse -Force
}

$env:DSH_DOCK_DATA_DIR = $dataDir
$env:DSH_HOME = Join-Path $dataDir 'dsh-home'
New-Item -ItemType Directory -Path $env:DSH_HOME -Force | Out-Null

Write-Host "DSH-Dock manual UI check"
Write-Host "  data dir: .test-tmp\manual-ui-data"

$app = Start-Process -FilePath $exe -PassThru

<#
  Finds the sidecar this launcher spawned.

  Matching on the parent pid is the precise answer and is what
  src-tauri/test/acceptance.ps1 uses. The retry loop matters because the child
  does not exist for the first fraction of a second after the launcher starts.
#>
$sidecarPid = 0
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and $sidecarPid -eq 0) {
    if ($app.HasExited) { break }
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($app.Id)" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*sidecar*index.js*' } |
             Select-Object -First 1
    if ($child) { $sidecarPid = [int]$child.ProcessId }
    else { Start-Sleep -Milliseconds 250 }
}

if (-not $sidecarPid) {
    Write-Host '  [FAIL] the sidecar never started.'
    if ($app.HasExited) {
        Write-Host "  The launcher exited early (exit code $($app.ExitCode))."
    } else {
        Write-Host "  The launcher is still running (pid $($app.Id)); killing it so it is not left behind."
        Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
}

$port = Wait-ForSidecarPort $sidecarPid 40
if ($port -le 0) {
    Write-Host '  [FAIL] the sidecar never became reachable on 127.0.0.1.'
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  sidecar pid:  $sidecarPid"
Write-Host "  sidecar port: $port"

Show-Windows 'BEFORE start (expect only the DSH-Dock dashboard)'
Write-Host '  Expected in the dashboard: badge shows "stopped" and a "Start Harness" button.'

$null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/harness/start" -Method Post -TimeoutSec 20
Write-Host "`nDriving the harness to running (same path as the Start button)..."
$status = $null
$deadline = (Get-Date).AddSeconds(300)
while ((Get-Date) -lt $deadline) {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/harness/status" -TimeoutSec 20
    if ($status.status -eq 'running' -or $status.status -eq 'error') { break }
    Start-Sleep -Milliseconds 500
}
Write-Host "  harness status: $($status.status)  pid=$($status.pid)"
Write-Host "  url: $($status.url)"

Write-Host "`n>>> MANUAL STEPS (the app is left running for you) <<<"
Write-Host "  1. In the DSH-Dock window: the badge should read 'running' (it may show 'starting' for a few seconds)."
Write-Host "     A 'Start Harness' button appears only when stopped; with 'running' you should see 'Open Harness' and 'Stop Harness'."
Write-Host "  2. Click 'Open Harness'."
Write-Host "  3. Confirm a second window titled 'DeepSeek Harness' opens AND renders the harness UI"
Write-Host "     (the token URL is exchanged for a cookie, so the page should load rather than show an auth error)."
Write-Host "  4. Click 'Stop Harness' and confirm the harness window closes."
Write-Host "  5. Close the DSH-Dock window and confirm it exits (the harness is already stopped here)."
Write-Host ""
Write-Host "To verify the window set from another terminal, run:"
Write-Host "  powershell -NoProfile -File src-tauri\test\window-check.ps1"
Write-Host ""
Write-Host "Cleanup when you are finished:"
Write-Host "  Stop-Process -Id $($app.Id) -Force"
Write-Host ""

Show-Windows 'CURRENT (the app is up; the harness window appears only after you click Open Harness)'
