<#
  Phase 2B acceptance checklist: the version manager and the version menu.

  THIS SCRIPT IS THE DOCUMENT THE USER WORKS FROM. It does not assert anything about
  the UI itself - WebView2 exposes no assertable accessibility tree and no injection
  path (src-tauri/NOTES.md), so what the version section RENDERS can only be confirmed
  by eye. What it does instead is remove every OTHER uncertainty, so that when
  something looks wrong it is unambiguous:

    1. checks the release build exists (section 7.4: acceptance uses the release
       binary, with NO dev server running - a debug build or a leftover Vite server
       can pass while the shipped artifact is broken),
    2. checks the two real harness versions are present and complete,
    3. isolates the run from the PRESERVED library the live tests depend on,
    4. pre-completes the first run so the wizard cannot hide the dashboard,
    5. prints the checklist, and
    6. optionally launches the launcher and reports what it can see.

  WHY IT PRE-COMPLETES THE FIRST RUN. `welcome::gate_decision` hides the dashboard
  when `first_run_completed` is false, and the preserved library has no
  `settings.json` - so a plain launch opens the WIZARD, not the dashboard, and every
  version check would be unreachable. The script writes the two settings the launcher
  needs; every other field falls back to its documented default.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File src-tauri/test/version-manager-check.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File src-tauri/test/version-manager-check.ps1 -Launch
    powershell -NoProfile -ExecutionPolicy Bypass -File src-tauri/test/version-manager-check.ps1 -Reuse

  -Launch   starts the launcher and watches for its windows (one run at a time).
  -Reuse    keeps the isolated data dir from a previous run instead of rebuilding it,
            which skips the ~973 MB copy when re-running the checklist.

  NOTHING HERE TOUCHES %LOCALAPPDATA%\DSH-Dock. The data dir is a scratch copy under
  .test-tmp, and DSH_HOME is pointed into the scratch dir too, so the user's real
  harness home is never read or written.
#>

[CmdletBinding()]
param(
    [switch]$Launch,
    [switch]$Reuse
)

$ErrorActionPreference = 'Stop'

# --- where things live -----------------------------------------------------

$repoRoot     = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$releaseExe   = Join-Path $repoRoot 'src-tauri\target\release\dsh-dock.exe'
$preserved    = Join-Path $repoRoot '.test-tmp\library-live'
$preservedVer = Join-Path $preserved 'versions'
$dataDir      = Join-Path $repoRoot '.test-tmp\version-manager-check'
$dataVersions = Join-Path $dataDir 'versions'
$dshHome      = Join-Path $dataDir 'dsh-home'

Write-Host "DSH-Dock Phase 2B acceptance checklist"
Write-Host "  repo root : $repoRoot"
Write-Host "  release   : $releaseExe"
Write-Host "  data dir  : .test-tmp\version-manager-check  (isolated copy)"
Write-Host ""

$problems = @()

# --- preflight 1: the release build, and no dev server ---------------------

if (-not (Test-Path $releaseExe)) {
    $problems += "No release build at $releaseExe. Build it first: npm run tauri -- build"
} else {
    $info = Get-Item $releaseExe
    Write-Host ("[ok]   release build present: {0:N0} bytes, built {1}" -f $info.Length, $info.LastWriteTime)
}

# Section 2.7: Get-NetTCPConnection does not detect IPv6-only listeners, so netstat.
# A Vite server on 1420 means a DEV server is running, and section 7.4 says a release
# binary tested that way can pass while the artifact is broken.
$vite = (& netstat -ano 2>$null) | Where-Object { $_ -match '^\s*TCP\s+\S+:1420\s+\S+\s+LISTENING' }
if ($vite) {
    Write-Host "[warn] something is LISTENING on port 1420 - a dev server may be running."
    Write-Host "       Section 7.4: stop it before trusting this run. A release binary that"
    Write-Host "       passes with Vite up can still fail from a clean launch."
} else {
    Write-Host "[ok]   nothing is listening on 1420 (no dev server)"
}

# --- preflight 2: the real versions are present and complete ---------------

foreach ($version in @('0.2.0-rc.1', '0.2.0-rc.2')) {
    $bin = Join-Path $preservedVer "$version\node_modules\@deepseek-ai\dsh\lib\bin.js"
    $web = Join-Path $preservedVer "$version\node_modules\@deepseek-ai\dsh-web-app\package.json"
    if ((Test-Path $bin) -and (Test-Path $web)) {
        Write-Host "[ok]   $version is present and complete in the preserved library"
    } else {
        $problems += "$version is incomplete in $preservedVer (bin.js=$([bool](Test-Path $bin)) web-app=$([bool](Test-Path $web))). Re-run the live install: `$env:RUN_LIVE='1'; node sidecar/test/library-live.js"
    }
}
if (-not (Test-Path (Join-Path $preservedVer 'catalogue.json'))) {
    Write-Host "[warn] the preserved library has no catalogue.json, so the Installed list will show"
    Write-Host "       'unknown date' for both versions. That is the documented cold-start case (Q76)."
}

# --- isolation: copy the library so a DELETE cannot destroy the evidence ----

<#
  WHY A COPY AND NOT THE PRESERVED DIR DIRECTLY.

  The checklist includes deleting a version, which REMOVES A TREE. Pointed at the
  preserved library that would destroy the evidence base the live switch test
  (Step 11) depends on. The copy costs ~973 MB and a few seconds; the destructive step
  is then safe.

  WHY IT IS NOT A HARDLINK COPY. It was tried and removed. `New-Item -ItemType
  HardLink` (and the `Copy-Item` fallback in its catch) fails on this tree with
  "Could not find a part of the path" for paths past MAX_PATH - the npm dependency tree
  contains several, e.g.
  `...\@opentelemetry\resources\build\esm\detectors\platform\node\machine-id\getMachineId-unsupported.d.ts`.
  A hardlink needs the destination path to exist as a directory, and the deep-path
  handling is not reliable there. `robocopy /SL` was the first attempt and does NOT
  hardlink regular files at all - `/SL` copies SYMBOLIC LINKS as links, and this tree
  has none, so it quietly performed a full copy while the comment claimed otherwise
  (verified with `fsutil hardlink list`).

  So: one mode, a real copy, documented. The `Remove-Item` replacement below exists for
  the same MAX_PATH reason - clearing the tree for a re-run.
#>
if ($Reuse -and (Test-Path $dataVersions)) {
    Write-Host "[ok]   reusing the isolated data dir from a previous run (-Reuse)"
} else {
    # `Remove-Item -Recurse -Force` FAILS on an npm tree: some dependency paths exceed
    # MAX_PATH, and PowerShell 5.1's provider throws "Could not find a part of the path"
    # partway through, leaving a half-deleted directory. `rmdir /s /q` handles long
    # paths and is the reliable way to clear one.
    if (Test-Path $dataDir) {
        # Verify the resolved path before deleting: this is the scratch dir, never the
        # preserved library, and the check makes that a fact rather than an assumption.
        $resolved = (Resolve-Path $dataDir).Path
        if ($resolved -notlike '*\.test-tmp\version-manager-check') {
            throw "Refusing to delete $resolved - not the expected scratch dir."
        }
        & cmd /c rmdir /s /q "`"$resolved`"" 2>$null
        if (Test-Path $dataDir) { throw "Could not clear $resolved" }
    }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

    Write-Host "       building the isolated copy (~973 MB, a few seconds)..."
    # ROBCOPY, NOT `Copy-Item`. An npm dependency tree contains paths past MAX_PATH
    # (e.g. `...\@opentelemetry\resources\build\esm\detectors\platform\node\machine-id\
    # getMachineId-unsupported.d.ts`), and `Copy-Item` fails on them with "Could not
    # find a part of the path" partway through - leaving a HALF-COPIED library, which is
    # worse than no copy because the run would then fail for a reason that looks like a
    # launcher bug. `robocopy` handles long paths, and `/E` copies subdirectories
    # including empty ones.
    #
    # `/NFL /NDL /NJH /NJS /NP` suppress the per-file and per-directory noise and the
    # progress percentage; only a summary is wanted. robocopy exit codes 0-7 are SUCCESS
    # (1 = files copied, 2 = extra files, 3 = both); 8 and above are real failures.
    $null = & robocopy $preservedVer $dataVersions /E /NFL /NDL /NJH /NJS /NP 2>$null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE while building the isolated copy."
    }
    Write-Host "[ok]   isolated copy ready at .test-tmp\version-manager-check\versions"
}

# --- pre-complete the first run so the wizard cannot hide the dashboard ----

$settingsFile = Join-Path $dataDir 'settings.json'
if (-not (Test-Path $settingsFile)) {
    @{
        auto_update_channel = 'rc'
        first_run_completed = $true
    } | ConvertTo-Json | Set-Content -Path $settingsFile -Encoding utf8
    Write-Host "[ok]   wrote settings.json with first_run_completed=true"
    Write-Host "       (without this the launcher opens the FIRST-RUN WIZARD and hides the dashboard,"
    Write-Host "        because the preserved library has no settings.json)"
} else {
    Write-Host "[ok]   settings.json already present"
}

New-Item -ItemType Directory -Path $dshHome -Force | Out-Null

# --- the checklist ---------------------------------------------------------

if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "CANNOT RUN THE CHECKLIST - fix these first:"
    $problems | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

Write-Host ""
Write-Host "======================================================================"
Write-Host " ACCEPTANCE CHECKLIST - 2B version manager"
Write-Host "======================================================================"
Write-Host ""
Write-Host " Mode A (default): this script launches the app for you."
Write-Host "   Re-run with -Launch, or start it yourself with the two variables below."
Write-Host ""
Write-Host "   `$env:DSH_DOCK_DATA_DIR = '.test-tmp\version-manager-check'"
Write-Host "   `$env:DSH_HOME          = '.test-tmp\version-manager-check\dsh-home'"
Write-Host "   & 'src-tauri\target\release\dsh-dock.exe'"
Write-Host ""
Write-Host " BEFORE YOU START - what the version section looks like when it is CORRECT:"
Write-Host "   * the dashboard window is titled DSH-Dock and shows a 'Versions' card"
Write-Host "     below the Harness card"
Write-Host "   * 'Installed' lists v0.2.0-rc.2 and v0.2.0-rc.1, both badged 'installed',"
Write-Host "     with their install dates from the catalogue"
Write-Host "   * 'Available' lists registry versions, newest first (v0.2.1-alpha.1 first)"
Write-Host "   * NO 'below 0.0.0' badge appears anywhere. MIN_SUPPORTED_DSH is still the"
Write-Host "     placeholder '0.0.0', which the UI treats as 'no floor' - so nothing can be"
Write-Host "     below it. A badge here would be the BUG, not the feature. (Step 11 sets the"
Write-Host "     real floor, and only then should a badge appear.)"
Write-Host ""
Write-Host "----------------------------------------------------------------------"
Write-Host ""
Write-Host " 1. THE APP OPENS"
Write-Host "    Do    : launch it."
Write-Host "    Expect: the dashboard appears (NOT the wizard - the script pre-completed"
Write-Host "            the first run) and the 'Versions' card is visible."
Write-Host ""
Write-Host " 2. THE INSTALLED LIST IS REAL"
Write-Host "    Do    : look at 'Installed'."
Write-Host "    Expect: v0.2.0-rc.2 and v0.2.0-rc.1, both 'installed', with dates."
Write-Host "            If a date says 'unknown date', tell me - the catalogue was missed."
Write-Host ""
Write-Host " 3. THE AVAILABLE LIST IS REAL"
Write-Host "    Do    : look at 'Available'."
Write-Host "    Expect: a count of published versions and a table, NEWEST FIRST, starting"
Write-Host "            with v0.2.1-alpha.1. 'stable'/'rc'/'alpha' channel badges appear."
Write-Host "            The two installed versions show a 'Switch' button, not 'Download'."
Write-Host "            If the registry is unreachable you get a sentence and a 'Try again'"
Write-Host "            button - that is the designed failure, not a crash."
Write-Host ""
Write-Host " 4. SWITCH FROM THE DASHBOARD"
Write-Host "    Do    : click 'Switch' on v0.2.0-rc.1 (it must NOT be the running one first:"
Write-Host "            if v0.2.0-rc.1 already shows 'Running', start v0.2.0-rc.2 instead)."
Write-Host "    Expect: the job panel appears saying it is switching; then the Harness card"
Write-Host "            shows the new version and 'running'. A cold boot takes"
Write-Host "            37-70s - the panel says so, and it is not a hang."
Write-Host "    NOTE  : switching STOPS the old harness. Any in-flight harness session is"
Write-Host "            closed. That is the design (section 8.1)."
Write-Host ""
Write-Host " 5. SWITCH FROM THE MENU, WITH THE DASHBOARD CLOSED   <-- the important one"
Write-Host "    Do    : (a) close the dashboard window (the harness window may stay open)."
Write-Host "            (b) in the menu bar: Harness > Recent Versions > pick the version"
Write-Host "                that is NOT currently running."
Write-Host "    Expect: the switch dispatches with NO dashboard open - a window reopens on"
Write-Host "            the Versions section carrying a short report, and the Harness menu"
Write-Host "            label updates to the new version."
Write-Host "    BUG IF: the click does nothing at all, or the menu label never changes."
Write-Host "            This is Q74: the menu switch deliberately does not route through"
Write-Host "            the dashboard, so a silent no-op here is the failure this step"
Write-Host "            exists to catch."
Write-Host ""
Write-Host " 6. 'SHOW ALL VERSIONS...'"
Write-Host "    Do    : menu bar: Harness > Recent Versions > 'Show all versions...'"
Write-Host "    Expect: the entry is ENABLED (2B flipped it from the disabled"
Write-Host "            'Show all versions... (Phase 2)') and the dashboard opens scrolled"
Write-Host "            to the Versions card."
Write-Host ""
Write-Host " 7. DOWNLOAD A VERSION, AND WATCH THE PHASES"
Write-Host "    Do    : in 'Available', click 'Download' on a version NOT installed -"
Write-Host "            v0.1.7-rc.2 is a good pick (small, old, far from the current one)."
Write-Host "    Expect: a four-phase indicator appears in order: Resolving, Downloading,"
Write-Host "            Linking, Validating. Downloading is the long one (minutes). The"
Write-Host "            version then appears in 'Installed' with today's date."
Write-Host "    NOTE  : a download INSTALLS AND DOES NOT START (Q86). The running harness"
Write-Host "            must be untouched by it."
Write-Host "    ALSO  : the phases are coarse by design. There is no percentage - the"
Write-Host "            sidecar reports a phase it means, never a guess."
Write-Host ""
Write-Host " 8. DELETE A VERSION"
Write-Host "    Do    : click 'Delete' on a version that is NOT running and NOT the one you"
Write-Host "            just downloaded if you want to keep it (try the one from step 7)."
Write-Host "    Expect: the row disappears and the Available row for it goes back to"
Write-Host "            'Download'."
Write-Host "    CHECK : clicking 'Delete' on the RUNNING version is impossible - the button"
Write-Host "            is disabled. The real guard is in the sidecar either way."
Write-Host ""
Write-Host " 9. A PARTIAL TREE (only if one is present)"
Write-Host "    Do    : look for a row badged 'partial'."
Write-Host "    Expect: TWO buttons - 'Switch' (which REPAIRS it: reinstalls, then starts)"
Write-Host "            and 'Clean up' (which removes it). There is deliberately no separate"
Write-Host "            'Repair' button, because a repair IS a switch."
Write-Host "    NOTE  : if no partial row exists, that is fine - the preserved library has"
Write-Host "            none. To create one: start a download and kill the app mid-download;"
Write-Host "            the leftover directory will read as 'partial' with a Clean up button."
Write-Host ""
Write-Host "10. A FAILED SWITCH (optional; needs a broken tree)"
Write-Host "    Do    : make a version's tree unusable, then switch to it. One way:"
Write-Host "              Rename-Item '.test-tmp\version-manager-check\versions\0.1.7-rc.2\node_modules\@deepseek-ai\dsh-web-app' 'gone'"
Write-Host "            then click 'Switch' on that version."
Write-Host "    Expect: an error card that NAMES the failed version, states that the harness"
Write-Host "            is not running, names the PREVIOUS version as still installed, and"
Write-Host "            offers 'Switch back to v<previous>'."
Write-Host "    BUG IF: it reports success, or leaves a stale 'running' badge, or the error"
Write-Host "            does not say which version failed."
Write-Host "    NOTE  : no automatic rollback - that is Q80, and it is deliberate. The way"
Write-Host "            back is a click, not a silent undo."
Write-Host ""
Write-Host "----------------------------------------------------------------------"
Write-Host " WHAT TO REPORT BACK"
Write-Host "   For each numbered step: PASS, or what you saw instead."
Write-Host "   The two most valuable if they misbehave: step 5 (menu switch with the"
Write-Host "   dashboard closed) and step 10 (the failed-switch card)."
Write-Host ""
Write-Host " WHEN YOU ARE DONE"
Write-Host "   Close the launcher. If a harness is still running from this run, stop it from"
Write-Host "   the dashboard first - this script will NOT kill anything it did not spawn,"
Write-Host "   and it cannot tell your harness from one you started yourself."
Write-Host ""

# --- optional launch -------------------------------------------------------

if (-not $Launch) {
    Write-Host " Not launched (no -Launch given). Start it with the variables printed above."
    exit 0
}

$env:DSH_DOCK_DATA_DIR = $dataDir
$env:DSH_HOME = $dshHome

Write-Host " Launching the release build..."
$app = Start-Process -FilePath $releaseExe -PassThru
Write-Host "   launcher pid: $($app.Id)"

Start-Sleep -Seconds 8

if ($app.HasExited) {
    Write-Host "[FAIL] the launcher exited immediately with code $($app.ExitCode)."
    Write-Host "       Check %LOCALAPPDATA%\DSH-Dock\\..\..\launcher.log, or the data dir's logs\ folder:"
    Write-Host "       $dataDir\logs\launcher.log"
    exit 1
}

# Enumerate the windows that belong to this launcher, so "it opened" is a fact rather
# than an impression. WebView2 gives us no DOM, but the window titles are real.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinProbe {
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

$windows = [WinProbe]::List() | Where-Object { $_.Pid -eq $app.Id }
Write-Host ""
if ($windows) {
    Write-Host " Windows owned by this launcher:"
    $windows | ForEach-Object { Write-Host ("   title='{0}' visible={1}" -f $_.Title, $_.Visible) }
    $visible = @($windows | Where-Object { $_.Visible })
    if ($visible.Count -eq 0) {
        Write-Host ""
        Write-Host "[WARN] the launcher has windows but none are visible. Section 2.7: before"
        Write-Host "       suspecting code, check the integrity label - a Low Mandatory Level on"
        Write-Host "       this tree makes WebView2 refuse to initialise, and the window is"
        Write-Host "       created and destroyed with no error."
        Write-Host "         icacls `"$repoRoot`" | Select-String 'Mandatory Label'"
    }
} else {
    Write-Host "[WARN] no windows found for the launcher pid yet. It may still be starting;"
    Write-Host "       look at the screen, then at:"
    Write-Host "         $dataDir\logs\launcher.log"
}

Write-Host ""
Write-Host " Now work through the checklist above, starting at step 1."
Write-Host " Leave this window open if you want the launch details; closing it does NOT"
Write-Host " close the launcher."
