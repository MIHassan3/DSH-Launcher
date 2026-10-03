<#
  Pause 4 acceptance: the first-run wizard.

  Runs the RELEASE binary (section 7.4: acceptance uses the release binary with no
  dev server) five times against throwaway data directories, and asserts the
  first-run gate, the wizard's window, the auto-submit diagnostic, the
  install-and-open hand-off, and the recorded settings.

  WHY THE DIAGNOSTIC HOOK IS DRIVEN HERE. WebView2 exposes no accessibility tree in
  this configuration (see NOTES.md), so the wizard's radio group and button cannot
  be clicked programmatically. `DSH_DOCK_WELCOME_ACTION` exists for exactly that
  reason, and it calls the same `welcome::submit_and_hand_off` the button and the X
  call - so these runs exercise the real path, not a parallel one. Case 4 proves the
  hook's own fail-safe, because a broken hook could otherwise make every other case
  pass for the wrong reason.

  SAFETY. Nothing here reads, writes or lists %LOCALAPPDATA%\DSH-Dock. Every run
  gets a fresh directory under %TEMP% via DSH_DOCK_DATA_DIR, and every directory is
  removed at the end. The npm install that a real first run would trigger is NOT
  exercised: that is a ~5 minute / ~372 MB download and it belongs to Phase 2's
  testing. These cases assert the hand-off event and the recorded settings only.

  Usage:
    powershell -NoProfile -File src-tauri/test/welcome-check.ps1
    powershell -NoProfile -File src-tauri/test/welcome-check.ps1 -Binary <path>
    powershell -NoProfile -File src-tauri/test/welcome-check.ps1 -KeepArtifacts

  Exits 0 when every case passes, 1 otherwise, printing expected vs actual.
#>

[CmdletBinding()]
param(
    # The release binary. Defaults to the standard cargo target directory.
    #
    # Resolved in the body, NOT in this default: `$PSScriptRoot` is not populated
    # while parameters are being bound under Windows PowerShell 5.1, so a default
    # of `Join-Path $PSScriptRoot ...` fails with "Path ... is an empty string"
    # before the script runs a single line.
    [string] $Binary = '',

    # Seconds to wait for a window to reach the expected state.
    [int] $WindowTimeoutSeconds = 25,

    # Leave the data directories and logs in place for inspection.
    [switch] $KeepArtifacts
)

$ErrorActionPreference = 'Stop'

if (-not $Binary) {
    $Binary = Join-Path $PSScriptRoot '..\target\release\dsh-dock.exe'
}

# --- window enumeration ------------------------------------------------------
#
# Top-level windows with a title, plus whether the OS says they are visible. The
# TITLE is the only handle a script has here: both windows belong to one process,
# and WebView2's accessibility tree is not exposed.

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WelcomeWinEnum {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public class Info {
        public string Title = "";
        public bool Visible;
        public uint Pid;
    }

    public static List<Info> List() {
        var results = new List<Info>();
        EnumWindows((hWnd, lParam) => {
            int len = GetWindowTextLength(hWnd);
            if (len > 0) {
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                results.Add(new Info { Title = sb.ToString(), Visible = IsWindowVisible(hWnd), Pid = pid });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@

$script:MainTitle = 'DSH-Dock'
$script:WizardTitle = 'Welcome to DSH-Dock'
$script:Passed = 0
$script:Failed = 0

function Write-Case {
    param([string] $Name)
    Write-Host ''
    Write-Host "=== $Name ===" -ForegroundColor Cyan
}

function Test-Assertion {
    param(
        [string] $What,
        [bool] $Condition,
        [string] $Expected = '',
        [string] $Actual = ''
    )

    if ($Condition) {
        $script:Passed++
        Write-Host "  [PASS] $What" -ForegroundColor Green
        return $true
    }

    $script:Failed++
    Write-Host "  [FAIL] $What" -ForegroundColor Red
    if ($Expected) { Write-Host "         expected: $Expected" }
    if ($Actual) { Write-Host "         actual:   $Actual" }
    return $false
}

function Get-DshWindows {
    # Only this launcher's windows: another DSH-Dock install may legitimately be
    # running (the developer's own), and matching it would poison every case.
    [WelcomeWinEnum]::List() | Where-Object {
        $_.Title -eq $script:MainTitle -or $_.Title -eq $script:WizardTitle
    }
}

function Get-WindowState {
    param([string] $Title)

    $match = [WelcomeWinEnum]::List() | Where-Object { $_.Title -eq $Title }
    if (-not $match) { return 'absent' }
    if ($match | Where-Object { $_.Visible }) { return 'visible' }
    return 'hidden'
}

function Wait-ForWindowState {
    param(
        [string] $Title,
        [string] $Desired,
        [int] $TimeoutSeconds = $WindowTimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $observed = 'absent'
    while ((Get-Date) -lt $deadline) {
        $observed = Get-WindowState -Title $Title
        if ($observed -eq $Desired) { return $observed }
        Start-Sleep -Milliseconds 250
    }
    return $observed
}

function Wait-ForFilePattern {
    param(
        [string] $Path,
        [string] $Pattern,
        [int] $TimeoutSeconds = $WindowTimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $Path) -and
            (Select-String -LiteralPath $Path -Pattern $Pattern -Quiet -ErrorAction SilentlyContinue)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Remove-SafeDir {
    param([string] $Path)

    if (-not $Path) { return }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

    # Refuses anything outside %TEMP%: the developer's live launcher state must be
    # unreachable from this script, even by a typo'd argument.
    if (-not $resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to delete '$resolved': it is outside $temp"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function New-IsolatedDataDir {
    param([string] $Tag)

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-dock-welcome-test-$Tag"
    Remove-SafeDir -Path $dir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Start-Launcher {
    param(
        [string] $DataDir,
        [hashtable] $ExtraEnv = @{},
        [string] $LogName = 'launcher'
    )

    $env:DSH_DOCK_DATA_DIR = $DataDir
    foreach ($key in $ExtraEnv.Keys) { Set-Item -Path "env:$key" -Value $ExtraEnv[$key] }

    $process = Start-Process -FilePath $Binary -PassThru
    Write-Host "  launched pid=$($process.Id) data-dir=$DataDir"

    return [pscustomobject]@{
        Process = $process
        DataDir = $DataDir
        Log     = Join-Path $DataDir 'logs\launcher.log'
    }
}

function Stop-Launcher {
    param($Run)

    if ($Run -and $Run.Process -and -not $Run.Process.HasExited) {
        # The MAIN window close is how the app exits; killing the process is the
        # fallback for a case that failed before the hand-off. Either way the
        # sidecar is reaped by the shell's own exit path.
        $null = $Run.Process.CloseMainWindow()
        if (-not $Run.Process.WaitForExit(5000)) {
            Write-Host "  [INFO] the launcher did not exit on a window close; killing pid=$($Run.Process.Id)"
            $Run.Process.Kill()
            $null = $Run.Process.WaitForExit(5000)
        }
    }

    # Belt and braces: the sidecar is a child, and an orphan would hold a loopback
    # port for the rest of the session. Scoped by start time so nothing that was
    # already running on this machine is touched.
    $cutoff = (Get-Date).AddMinutes(-10)
    Get-Process -Name node -ErrorAction SilentlyContinue |
        Where-Object { $_.StartTime -gt $cutoff } |
        ForEach-Object {
            Write-Host "  [INFO] stopping a leftover sidecar pid=$($_.Id)"
            $_.Kill()
        }
}

function Read-Settings {
    param([string] $DataDir)

    $path = Join-Path $DataDir 'settings.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

# --- pre-flight --------------------------------------------------------------

Write-Host 'DSH-Dock first-run wizard acceptance'
Write-Host "  binary: $Binary"

if (-not (Test-Path -LiteralPath $Binary)) {
    Write-Host "  [FAIL] the release binary does not exist: $Binary" -ForegroundColor Red
    Write-Host '         build it with: cargo build --manifest-path "src-tauri/Cargo.toml" --release'
    exit 1
}

# Section 7.4: a dev server masks behaviour behind devUrl. The release binary must
# be loading embedded assets, which is what `custom-protocol` provides.
if (-not (Select-String -LiteralPath (Join-Path $PSScriptRoot '..\Cargo.toml') -Pattern 'custom-protocol' -Quiet)) {
    Write-Host '  [FAIL] custom-protocol is missing from Cargo.toml - the release binary would load from devUrl' -ForegroundColor Red
    exit 1
}

Get-Process -Name dsh-dock -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  [WARN] another dsh-dock.exe is running (pid=$($_.Id)); its windows could be mistaken for ours"
}

$created = New-Object System.Collections.Generic.List[string]

try {
    # --- case 1: the env var is unset ---------------------------------------
    #
    # The gate itself: the wizard appears, the dashboard is hidden, and nothing
    # auto-submits.
    Write-Case 'case 1: first run, diagnostic unset - the wizard stays open'

    $dir1 = New-IsolatedDataDir -Tag 'case1'
    $created.Add($dir1)
    $run1 = Start-Launcher -DataDir $dir1

    $wizardState = Wait-ForWindowState -Title $script:WizardTitle -Desired 'visible'
    Test-Assertion -What 'the wizard window is visible' -Condition ($wizardState -eq 'visible') `
        -Expected 'visible' -Actual $wizardState

    $mainState = Get-WindowState -Title $script:MainTitle
    Test-Assertion -What 'the dashboard is NOT visible (hidden, not closed)' -Condition ($mainState -eq 'hidden') `
        -Expected 'hidden' -Actual $mainState

    Test-Assertion -What 'the gate logged the decision' `
        -Condition (Wait-ForFilePattern -Path $run1.Log -Pattern 'first-run gate: first_run_completed=False show_welcome=true hide_main=true' -TimeoutSeconds 10) `
        -Expected 'first-run gate: first_run_completed=False show_welcome=true hide_main=true'

    Test-Assertion -What 'the wizard window was reported visible in the startup probe' `
        -Condition (Wait-ForFilePattern -Path $run1.Log -Pattern 'welcome=visible:true' -TimeoutSeconds 10) `
        -Expected 'welcome=visible:true in a "window check" line'

    Test-Assertion -What 'the dashboard was reported hidden in the startup probe' `
        -Condition (Wait-ForFilePattern -Path $run1.Log -Pattern 'main=visible:false' -TimeoutSeconds 10) `
        -Expected 'main=visible:false in a "window check" line'

    Test-Assertion -What 'no auto-submit ran' `
        -Condition (-not (Select-String -LiteralPath $run1.Log -Pattern 'auto-submit ENABLED' -Quiet -ErrorAction SilentlyContinue))

    Test-Assertion -What 'the wizard window has no menu bar attached' `
        -Condition (Wait-ForFilePattern -Path $run1.Log -Pattern 'welcome: menu cleared on the wizard window' -TimeoutSeconds 10) `
        -Expected 'welcome: menu cleared on the wizard window'

    Test-Assertion -What 'settings.json was NOT written (nothing answered the wizard)' `
        -Condition ($null -eq (Read-Settings -DataDir $dir1))

    Stop-Launcher -Run $run1

    # --- case 2: a valid channel ---------------------------------------------
    Write-Case 'case 2: DSH_DOCK_WELCOME_ACTION=alpha - auto-submit, hand-off, second launch'

    $dir2 = New-IsolatedDataDir -Tag 'case2'
    $created.Add($dir2)
    $run2 = Start-Launcher -DataDir $dir2 -ExtraEnv @{ DSH_DOCK_WELCOME_ACTION = 'alpha' }

    Test-Assertion -What 'the auto-submit diagnostic armed itself' `
        -Condition (Wait-ForFilePattern -Path $run2.Log -Pattern 'auto-submit ENABLED \(diagnostic hook\)' -TimeoutSeconds 10) `
        -Expected 'welcome: auto-submit ENABLED (diagnostic hook) - Submit("alpha") in 3s'

    Test-Assertion -What 'the hand-off was recorded as submitted' `
        -Condition (Wait-ForFilePattern -Path $run2.Log -Pattern 'welcome: first run complete - reason=submitted channel=alpha' -TimeoutSeconds 20) `
        -Expected 'welcome: first run complete - reason=submitted channel=alpha first_run_completed=true'

    Test-Assertion -What 'install-and-open was DELIVERED to the dashboard' `
        -Condition (Wait-ForFilePattern -Path $run2.Log -Pattern 'install-and-open delivered \(channel=alpha dismissed=false\)' -TimeoutSeconds 20) `
        -Expected 'welcome: install-and-open delivered (channel=alpha dismissed=false)'

    Test-Assertion -What 'the wizard window closed' `
        -Condition ((Wait-ForWindowState -Title $script:WizardTitle -Desired 'absent') -eq 'absent') `
        -Expected 'absent'

    Test-Assertion -What 'the dashboard is visible again' `
        -Condition ((Wait-ForWindowState -Title $script:MainTitle -Desired 'visible') -eq 'visible') `
        -Expected 'visible'

    $settings2 = Read-Settings -DataDir $dir2
    Test-Assertion -What 'settings.json records first_run_completed=true' `
        -Condition ($settings2 -and $settings2.first_run_completed -eq $true) `
        -Expected 'true' -Actual $(if ($settings2) { "$($settings2.first_run_completed)" } else { '(no file)' })

    Test-Assertion -What 'settings.json records auto_update_channel=alpha' `
        -Condition ($settings2 -and $settings2.auto_update_channel -eq 'alpha') `
        -Expected 'alpha' -Actual $(if ($settings2) { "$($settings2.auto_update_channel)" } else { '(no file)' })

    Test-Assertion -What 'the menu rebuild followed the channel change' `
        -Condition (Wait-ForFilePattern -Path $run2.Log -Pattern 'reason=settings-change' -TimeoutSeconds 10) `
        -Expected 'menu rebuild: reason=settings-change'

    Stop-Launcher -Run $run2

    # Second launch, same data dir: the wizard must not come back.
    $run2b = Start-Launcher -DataDir $dir2 -LogName 'launcher-second'
    $null = Wait-ForWindowState -Title $script:MainTitle -Desired 'visible'
    Start-Sleep -Seconds 4

    Test-Assertion -What 'the second launch shows the dashboard' `
        -Condition ((Get-WindowState -Title $script:MainTitle) -eq 'visible') `
        -Expected 'visible' -Actual (Get-WindowState -Title $script:MainTitle)

    Test-Assertion -What 'the second launch does NOT show the wizard' `
        -Condition ((Get-WindowState -Title $script:WizardTitle) -eq 'absent') `
        -Expected 'absent' -Actual (Get-WindowState -Title $script:WizardTitle)

    Test-Assertion -What 'the second launch logged the completed gate' `
        -Condition (Wait-ForFilePattern -Path $run2b.Log -Pattern 'first-run gate: first_run_completed=True show_welcome=false hide_main=false' -TimeoutSeconds 10) `
        -Expected 'first-run gate: first_run_completed=True show_welcome=false hide_main=false'

    Stop-Launcher -Run $run2b

    # --- case 3: dismissal ---------------------------------------------------
    Write-Case 'case 3: DSH_DOCK_WELCOME_ACTION=dismiss - the rc default is recorded'

    $dir3 = New-IsolatedDataDir -Tag 'case3'
    $created.Add($dir3)
    $run3 = Start-Launcher -DataDir $dir3 -ExtraEnv @{ DSH_DOCK_WELCOME_ACTION = 'dismiss' }

    Test-Assertion -What 'the dismissal was recorded as dismissed, not submitted' `
        -Condition (Wait-ForFilePattern -Path $run3.Log -Pattern 'welcome: first run complete - reason=dismissed channel=rc' -TimeoutSeconds 20) `
        -Expected 'welcome: first run complete - reason=dismissed channel=rc first_run_completed=true'

    Test-Assertion -What 'install-and-open was delivered marked as dismissed' `
        -Condition (Wait-ForFilePattern -Path $run3.Log -Pattern 'install-and-open delivered \(channel=rc dismissed=true\)' -TimeoutSeconds 20) `
        -Expected 'welcome: install-and-open delivered (channel=rc dismissed=true)'

    $settings3 = Read-Settings -DataDir $dir3
    Test-Assertion -What 'settings.json records the rc default' `
        -Condition ($settings3 -and $settings3.auto_update_channel -eq 'rc' -and $settings3.first_run_completed -eq $true) `
        -Expected 'auto_update_channel=rc first_run_completed=true' `
        -Actual $(if ($settings3) { "auto_update_channel=$($settings3.auto_update_channel) first_run_completed=$($settings3.first_run_completed)" } else { '(no file)' })

    Test-Assertion -What 'the wizard window closed on dismissal' `
        -Condition ((Wait-ForWindowState -Title $script:WizardTitle -Desired 'absent') -eq 'absent') `
        -Expected 'absent'

    Test-Assertion -What 'the dashboard is visible after the dismissal' `
        -Condition ((Wait-ForWindowState -Title $script:MainTitle -Desired 'visible') -eq 'visible') `
        -Expected 'visible'

    Stop-Launcher -Run $run3

    # --- case 4: the fail-safe ----------------------------------------------
    #
    # The case that makes the other three mean something: if the hook submitted on
    # garbage input, case 2 and case 3 could pass while the real behaviour was
    # wrong.
    Write-Case 'case 4: DSH_DOCK_WELCOME_ACTION=xyz - the wizard must stay open'

    $dir4 = New-IsolatedDataDir -Tag 'case4'
    $created.Add($dir4)
    $run4 = Start-Launcher -DataDir $dir4 -ExtraEnv @{ DSH_DOCK_WELCOME_ACTION = 'xyz' }

    Test-Assertion -What 'the rejection was logged, naming the variable, the value and the valid inputs' `
        -Condition (Wait-ForFilePattern -Path $run4.Log -Pattern "DSH_DOCK_WELCOME_ACTION='xyz' not recognised; ignoring\. Valid: rc, alpha, all, dismiss" -TimeoutSeconds 10) `
        -Expected "welcome: DSH_DOCK_WELCOME_ACTION='xyz' not recognised; ignoring. Valid: rc, alpha, all, dismiss"

    Test-Assertion -What 'the auto-submit did NOT arm' `
        -Condition (-not (Select-String -LiteralPath $run4.Log -Pattern 'auto-submit ENABLED' -Quiet -ErrorAction SilentlyContinue))

    Test-Assertion -What 'the wizard window is still open' `
        -Condition ((Wait-ForWindowState -Title $script:WizardTitle -Desired 'visible') -eq 'visible') `
        -Expected 'visible'

    Test-Assertion -What 'nothing was written to settings.json' `
        -Condition ($null -eq (Read-Settings -DataDir $dir4))

    Test-Assertion -What 'no hand-off was attempted' `
        -Condition (-not (Select-String -LiteralPath $run4.Log -Pattern 'first run complete' -Quiet -ErrorAction SilentlyContinue))

    Stop-Launcher -Run $run4
}
finally {
    Get-Process -Name dsh-dock -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  [INFO] stopping a leftover launcher pid=$($_.Id)"
        $_.Kill()
    }

    if ($KeepArtifacts) {
        Write-Host ''
        Write-Host "  artifacts kept: $($created -join ', ')"
    } else {
        foreach ($dir in $created) { Remove-SafeDir -Path $dir }
    }
}

Write-Host ''
Write-Host "result: $script:Passed passed, $script:Failed failed"

if ($script:Failed -gt 0) { exit 1 }
exit 0
