# dsh-app.ps1
# Launches the DeepSeek Harness as a desktop app, checking for updates first.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as
# Windows-1252, and a stray em dash or curly quote will break parsing.

$ErrorActionPreference = 'Stop'

# Ensure STA for Windows Forms
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    [System.Threading.Thread]::CurrentThread.SetApartmentState('STA')
}

# ==== configuration ========================================================
$DefaultChannel = 'latest'   # 'latest' (release line) or 'alpha'
$DefaultPort    = 8765       # pinned: keeps the Edge PWA identity stable
$Mode     = 'edge-app'       # 'edge-app' | 'pwa' | 'browser'
$PwaName  = 'DeepSeek Harness'
$Package  = '@deepseek-ai/dsh'
$DialogTimeout = 4           # seconds before the status card dismisses itself; 0 = never
# dsh builds its plugin tree during the first served session after an install,
# and that reload drops the open page ("connecting... disconnected"). It only
# happens when the profile in $DSH_HOME has to be built - which is every new
# machine. Prompting for one restart after an install is the reliable remedy.
$PromptRestartAfterInstall = $true
# $env:DSH_HOME = 'C:\Users\me\.dsh'   # uncomment to isolate this app's profile
#
# Isolated test mode: every path below is derived from $DataDir, so pointing
# DSH_DATA_DIR (and DSH_HOME for the dsh profile, DSH_PORT for the server) at
# private folders runs this launcher against its own copy of everything and
# never touches the default install:
#   $env:DSH_DATA_DIR = 'C:\temp\DSHLauncher-Test\data'
#   $env:DSH_HOME     = 'C:\temp\DSHLauncher-Test\dsh-home'
#   $env:DSH_PORT     = '8877'
# The single-instance lock and the orphan cleanup follow $DataDir too, so a
# test copy and the real install never see each other's processes or data.
$DataDir = if ($env:DSH_DATA_DIR) { $env:DSH_DATA_DIR.Trim() } else { Join-Path $env:LOCALAPPDATA 'DeepSeekHarness' }
$Port    = if ($env:DSH_PORT -match '^\d+$') { [int]$env:DSH_PORT } else { $DefaultPort }
# ===========================================================================

$appDir       = $DataDir
$runtimeDir   = Join-Path $appDir 'runtime'
$profileDir   = Join-Path $appDir 'edge-profile'
$outLog       = Join-Path $appDir 'dsh.out.log'
$errLog       = Join-Path $appDir 'dsh.err.log'
$settingsPath = Join-Path $appDir 'settings.json'
$manifest     = Join-Path $runtimeDir 'node_modules\@deepseek-ai\dsh\package.json'

# dsh keeps its plugin tree here, separate from our runtime folder.
$profileRoot  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$webProfile   = Join-Path $profileRoot 'profiles\web'

New-Item -ItemType Directory -Force -Path $appDir, $runtimeDir, $profileDir | Out-Null

# Any unexpected terminating error is logged to crash.log and surfaced in a
# popup instead of silently killing the windowless app.
trap {
    $tmsg = ''
    try { $tmsg = [string]$_.Exception.Message } catch { }
    $tline = 0
    try { $tline = $_.InvocationInfo.ScriptLineNumber } catch { }
    $ttext = ''
    try { $ttext = ([string]$_.InvocationInfo.Line).Trim() } catch { }
    try {
        Add-Content (Join-Path $appDir 'crash.log') ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  line ' + $tline + '  ' + $tmsg + '  at: ' + $ttext)
    } catch { }
    try {
        if ($splash -and -not $splash.IsDisposed) { $splash.Close() }
        if ($shell) {
            $shell.Popup('Unexpected error: ' + $tmsg + "`n(line " + $tline + ')`n`nDetails were written to:`n' + (Join-Path $appDir 'crash.log'), 0, 'DeepSeek Harness', 16) | Out-Null
        }
    } catch { }
    exit 1
}

# ==== process ownership ====================================================
# Cleanup is scoped to THIS data dir: only processes whose command line runs
# a dsh from $runtimeDir are considered ours. A second install (or a test
# copy) under another data dir is never touched.
function Get-OwnedHarnessProcesses {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$runtimeDir*" }
}

function Stop-OrphanHarness {
    Get-OwnedHarnessProcesses |
        ForEach-Object { Invoke-KillTree $_.ProcessId }
}

function Stop-Harness {
    if ($harness -and -not $harness.HasExited) {
        Invoke-KillTree $harness.Id
    }
    Stop-OrphanHarness   # catch any child that outlived its parent
}

# Kill a process and its children tolerantly. taskkill failures (e.g. a child
# that is already exiting or protected) must never become terminating errors,
# so the kill goes through Start-Process and is retried once, then ignored.
function Invoke-KillTree([int]$procId) {
    if (-not $procId) { return }
    $tk = Join-Path $env:windir 'System32\taskkill.exe'
    for ($try = 0; $try -lt 2; $try++) {
        try {
            Start-Process -FilePath $tk -ArgumentList @('/PID', "$procId", '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
        } catch { }
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return }
    }
}

function Test-PortFree($p) {
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop(); $true
    } catch { $false }
}

function Get-ProfilePluginCount {
    @(Get-ChildItem (Join-Path $webProfile 'node_modules\@deepseek-ai') -ErrorAction SilentlyContinue).Count
}

# ==== version helpers ======================================================
# Compare dotted versions with an optional prerelease suffix, e.g.
# "0.1.2-rc.1" < "0.1.2" < "0.1.3-alpha.1". Returns -1, 0 or 1.
# Input is defensively sanitised: a trailing/leading space or a leading "v" is
# tolerated, and anything that is not version-shaped is logged and treated as
# equal. A malformed tag from a registry response must never crash the
# launcher - a version check is not worth losing a running session over.
function Compare-DshVersion {
    param([string]$a, [string]$b)

    $a = ([string]$a).Trim()
    $b = ([string]$b).Trim()
    if ($a -eq $b) { return 0 }

    if ($a -notmatch '^v?\d+(\.\d+)*' -or $b -notmatch '^v?\d+(\.\d+)*') {
        try {
            $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  version-compare skipped  a=[' + $a + ']  b=[' + $b + ']'
            Add-Content (Join-Path $appDir 'launcher.log') $line
        } catch { }
        return 0
    }
    $a = $a -replace '^v', ''
    $b = $b -replace '^v', ''

    function Parse-DshVersion([string]$v, [ref]$nums, [ref]$pre) {
        $v = ($v -split '\+')[0]
        $pre.Value = ''
        $i = $v.IndexOf('-')
        if ($i -ge 0) { $pre.Value = $v.Substring($i + 1); $v = $v.Substring(0, $i) }
        $n = @($v -split '\.')
        while ($n.Count -lt 3) { $n += '0' }
        $nums.Value = $n
    }
    function Compare-DshIdent([string]$x, [string]$y) {
        $nx = 0; $ny = 0
        $ix = [int]::TryParse($x, [ref]$nx)
        $iy = [int]::TryParse($y, [ref]$ny)
        if ($ix -and $iy) { return [math]::Sign($nx - $ny) }
        if ($ix) { return -1 }                          # numeric sorts before text
        if ($iy) { return 1 }
        return [math]::Sign([string]::Compare($x, $y, $true))
    }

    $na = $null; $pa = ''
    Parse-DshVersion $a ([ref]$na) ([ref]$pa)
    $nb = $null; $pb = ''
    Parse-DshVersion $b ([ref]$nb) ([ref]$pb)

    for ($i = 0; $i -lt 3; $i++) {
        if ([int]$na[$i] -ne [int]$nb[$i]) { return [math]::Sign([int]$na[$i] - [int]$nb[$i]) }
    }
    if ($pa -eq '' -and $pb -ne '') { return 1 }        # release beats prerelease
    if ($pa -ne '' -and $pb -eq '') { return -1 }
    if ($pa -eq $pb) { return 0 }
    $ia = @($pa -split '\.'); $ib = @($pb -split '\.')
    $m = [Math]::Min($ia.Count, $ib.Count)
    for ($i = 0; $i -lt $m; $i++) {
        $c = Compare-DshIdent $ia[$i] $ib[$i]
        if ($c -ne 0) { return $c }
    }
    return [math]::Sign($ia.Count - $ib.Count)
}
# ==== end version helpers ==================================================

# ==== node resolution ======================================================
# Node and npm must never depend on the PATH of the running process: PATH is
# fixed when a process starts, so a Node.js installed a moment ago (by this
# installer, by winget, or by an update) is invisible to it. Instead we find
# node.exe on disk - well-known roots first, then this process PATH, then the
# machine/user PATH from the registry - and drive npm through node itself.
function Find-NodeExe {
    $cands = @()
    foreach ($root in @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))) {
        if ($root -and (Test-Path $root)) { $cands += (Join-Path $root 'node.exe') }
    }
    foreach ($dir in ($env:PATH -split ';')) {
        if ($dir) { $cands += (Join-Path $dir 'node.exe') }
    }
    foreach ($hive in 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'HKCU:\Environment') {
        try {
            $p = (Get-ItemProperty -Path $hive -Name Path -ErrorAction Stop).Path
            foreach ($dir in ($p -split ';')) {
                if ($dir) { $cands += (Join-Path $dir 'node.exe') }
            }
        } catch { }
    }
    foreach ($c in $cands) { if (Test-Path $c) { return $c } }
    $null
}

function Install-NodeSilently {
    # Best effort: fetch the LTS build through winget. Returns true when a
    # winget process was started (call Find-NodeExe afterwards to verify).
    try {
        $wg = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
        if (-not $wg) {
            $p = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
            if (Test-Path $p) { $wg = $p }
        }
        if (-not $wg) { return $false }
        $pr = Start-Process $wg -PassThru -WindowStyle Hidden -ArgumentList @(
            'install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent',
            '--accept-package-agreements', '--accept-source-agreements')
        try { $null = $pr.Handle } catch { }
        $pr.WaitForExit()
        return $true
    } catch { return $false }
}
# ==== end node resolution ==================================================

# ==== launcher self update ==================================================
# The launcher is a single per-user exe. A newer build is downloaded in the
# background, verified against the SHA-256 published in the release notes, and
# staged. The user approves it with a gentle message; the swap (rename the
# running exe aside, move the new one in) happens on the next start, so the
# running instance is never touched. None of this runs on the boot path.
function Get-LauncherExePath {
    try { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { '' }
}
function Get-LauncherVersion {
    $p = Get-LauncherExePath
    if ($p -and $p -match 'DSHLauncher\.exe$' -and (Test-Path $p)) {
        try { return [string][System.Diagnostics.FileVersionInfo]::GetVersionInfo($p).FileVersion } catch { }
    }
    '0.1.2.0'   # matches build.ps1; dev .ps1 runs never self-offer older tags
}
# ==== update notes helpers (tested by test/unit-release-notes.ps1) ==========
# Release notes carry one checksum line per asset. Only the line that names the
# launcher asset is trusted; there is deliberately no loose "find any hash
# nearby" fallback, so the Setup's checksum can never be picked up by mistake.
function Get-LauncherChecksumFromNotes([string]$body) {
    if (-not $body) { return $null }
    $mm = [regex]::Match($body, '(?im)^\s*Launcher\s+SHA-?256\s*:\s*([0-9a-fA-F]{64})\s*$')
    if (-not $mm.Success) { return $null }
    $mm.Groups[1].Value.ToLowerInvariant()
}
# ==== end update notes helpers ==============================================

function Test-LauncherUpdateAvailable {
    # Returns @{ tag; url; checksum } when the published release is newer, or $null.
    try {
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/MIHassan3/DSH-Launcher/releases/latest' `
            -Headers @{ 'User-Agent' = 'DSH-Launcher' } -TimeoutSec 8
    } catch { return $null }
    $tag = [string]$rel.tag_name
    $cur = Get-LauncherVersion
    if (-not $tag -or -not $cur) { return $null }
    if ((Compare-DshVersion ($tag -replace '^v', '') $cur) -le 0) { return $null }
    $asset = @($rel.assets | Where-Object { $_.name -eq 'DSHLauncher.exe' }) | Select-Object -First 1
    if (-not $asset) { return $null }
    # Fail closed: without a published launcher checksum nothing is offered.
    $checksum = Get-LauncherChecksumFromNotes ([string]$rel.body)
    if (-not $checksum) { return $null }
    return @{ tag = $tag; url = [string]$asset.browser_download_url; checksum = $checksum }
}
function Invoke-StageLauncherUpdate($info) {
    $stage = Join-Path $appDir 'launcher.new'
    $part  = $stage + '.part'
    try {
        Invoke-WebRequest -Uri $info.url -OutFile $part -TimeoutSec 90 `
            -Headers @{ 'User-Agent' = 'DSH-Launcher' }
        $h = (Get-FileHash $part -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($h -ne $info.checksum) { Remove-Item $part -Force -ErrorAction SilentlyContinue; return $false }
        $size = (Get-Item $part).Length
        if ($size -lt 100000) { Remove-Item $part -Force -ErrorAction SilentlyContinue; return $false }
        Move-Item $part $stage -Force
        return $true
    } catch {
        try { Remove-Item $part -Force -ErrorAction SilentlyContinue } catch { }
        return $false
    }
}
function Invoke-ApplyStagedLauncherUpdate {
    # Swap a staged, approved launcher into place. Windows allows renaming the
    # running exe; this instance keeps running the old image until it exits.
    $stage = Join-Path $appDir 'launcher.new'
    $exe = Get-LauncherExePath
    if (-not (Test-Path $stage)) { return }
    if (-not $exe -or $exe -match '(powershell|pwsh)(_ise)?\.exe$') { return }
    if (-not (Test-Path $exe)) { return }
    if ((Get-Item $stage).Length -lt 100000) { Remove-Item $stage -Force -ErrorAction SilentlyContinue; return }
    $old = $exe + '.old'
    try {
        Remove-Item $old -Force -ErrorAction SilentlyContinue
        if (Test-Path $exe) { Rename-Item $exe $old -ErrorAction Stop }
        Move-Item $stage $exe -Force -ErrorAction Stop
        Remove-Item $old -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $appDir 'launcher.staged.tag') -Force -ErrorAction SilentlyContinue
    } catch {
        if (-not (Test-Path $exe) -and (Test-Path $old)) {
            try { Rename-Item $old $exe -ErrorAction Stop } catch { }
        }
    }
}
function Test-LauncherSelfUpdateDue {
    # Throttled to ~once a day and suppressed until the reminder time passes.
    $s = Get-Settings
    $now = Get-Date
    if ($s.launcherLastCheck) {
        try { if (($now - [datetime]$s.launcherLastCheck).TotalHours -lt 23) { return $null } } catch { }
    }
    $s.launcherLastCheck = $now.ToString('o')
    Save-Settings $s
    $info = Test-LauncherUpdateAvailable
    if (-not $info) { return $null }
    if ($s.launcherRemindAfter) {
        try { if ($now -lt [datetime]$s.launcherRemindAfter) { return $null } } catch { }
    }
    return $info
}
function Show-LauncherUpdateOffer($tag) {
    # Gentle: auto-dismisses after two minutes (treated like Cancel), so it
    # never blocks the machine. OK applies on the next start, Cancel holds the
    # current version and asks again later (daily reminder).
    $r = $shell.Popup("A new DSH Launcher update is ready ($tag).`n`nIt was downloaded and verified.`n`nInstall it the next time you start the app?`n`nOK     - apply it on my next start`nCancel - keep the current version", 120, 'DSH Launcher update', 1 + 32)
    $s = Get-Settings
    if ($r -eq 1) {
        $s.launcherUpdatePending = $true
        $s.launcherRemindAfter = ''
    } else {
        $s.launcherUpdatePending = $false
        $s.launcherRemindAfter = (Get-Date).AddDays(1).ToString('o')
    }
    Save-Settings $s
}

# ==== resident (tray) helpers ===============================================
function Show-Balloon($ni, $title, $text) {
    if ($ni) { try { $ni.ShowBalloonTip(4000, $title, $text, [Windows.Forms.ToolTipIcon]::Info) } catch { } }
}
function Start-HarnessQuiet {
    # Reboot the harness without any splash text; used by the tray Open action.
    Stop-OrphanHarness
    $usePort = $Port
    for ($i = 0; $i -lt 8 -and -not (Test-PortFree $usePort); $i++) { Start-Sleep -Milliseconds 300 }
    if (-not (Test-PortFree $usePort)) { return $null }
    Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue
    $h = $null
    try {
        $h = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
            -WorkingDirectory $env:USERPROFILE `
            -ArgumentList "`"$dshBin`"", 'web', '--host', '127.0.0.1', '--port', $usePort, '--no-open' `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        try { $null = $h.Handle } catch { }
    } catch { return $null }
    $deadline = (Get-Date).AddSeconds(120)
    $u = $null
    while (-not $u -and (Get-Date) -lt $deadline) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 400
        $text = ''
        foreach ($fl in @($outLog, $errLog)) {
            if (Test-Path $fl) { $text += (Get-Content $fl -Raw -ErrorAction SilentlyContinue) }
        }
        $m = [regex]::Match($text, 'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"''\)\]]*')
        if ($m.Success) { $u = $m.Value.TrimEnd('.', ',') }
        if ($h.HasExited -and -not $u) { break }
    }
    if (-not $u) {
        if (-not $h.HasExited) { Invoke-KillTree $h.Id }
        $script:harness = $null
        return $null
    }
    $script:harness = $h
    $script:lastUrl = $u
    return $u
}
function Ensure-HarnessUp {
    if ($harness -and -not $harness.HasExited) { return $script:lastUrl }
    Start-HarnessQuiet
}
function Open-EdgeWindow {
    # Open (or reopen) the Edge app window for the running harness.
    $url2 = Ensure-HarnessUp
    if (-not $url2) { return $null }
    if ($script:winEdge -and -not $script:winEdge.HasExited) { return $script:winEdge }
    $edge = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $edge) { return $null }
    Initialize-EdgeProfile
    $p = Start-Process $edge -PassThru -ArgumentList @(
        "--app=$url2"
        "--user-data-dir=`"$profileDir`""
        '--no-first-run'
        '--no-default-browser-check'
        '--disable-fre'
        '--no-service-autorun'
        '--disable-sync'
        '--disable-background-mode'
        '--disable-features=msEdgeWelcomePage,msImplicitSignin,msEdgeSplitScreen'
    )
    $script:winEdge = $p
    $p
}
function Check-ResidentUpdates($ni) {
    # dsh: never install mid-session - announce it, the next launch installs it.
    $s = Get-Settings
    $tags = Get-DistTags
    $installed = Get-InstalledVersion
    if ($tags -and $installed) {
        $installed = [string]$installed
        $isAlphaLine = ($installed -match '-alpha')
        if ($isAlphaLine) { $myTag = [string]$tags.alpha } else { $myTag = [string]$tags.latest }
        if ($myTag -and (Compare-DshVersion $myTag $installed) -gt 0 -and $myTag -ne $s.dshNotifiedTag) {
            $s.dshNotifiedTag = [string]$myTag
            Save-Settings $s
            Show-Balloon $ni 'Update pending' "dsh $myTag is available and will install on your next start."
        }
    }
    # launcher: stage in the background, then ask gently.
    $li = Test-LauncherSelfUpdateDue
    if ($li) {
        if (Invoke-StageLauncherUpdate $li) {
            Show-LauncherUpdateOffer $li.tag
        }
    }
}
function Enter-TrayLifecycle($firstEdge) {
    # Resident background mode: closing the window keeps the harness and your
    # sessions alive. The tray icon reopens the window, stops the harness, or
    # checks for updates. Returns when the user chooses Exit.
    $script:winEdge = $firstEdge
    # A captured hashtable is used for tray actions: assigning to a $script:
    # variable inside a GetNewClosure() handler does not reach this scope.
    $tray = @{ action = ''; exit = $false }

    $icon = $null
    try {
        $ep = Get-LauncherExePath
        if ($ep -and (Test-Path $ep)) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($ep) }
    } catch { }
    if (-not $icon) { try { $icon = [System.Drawing.SystemIcons]::Application } catch { } }

    $ni = New-Object Windows.Forms.NotifyIcon
    if ($icon) { $ni.Icon = $icon }
    $ni.Text = 'DeepSeek Harness'
    $ni.Visible = $true

    $menu = New-Object Windows.Forms.ContextMenuStrip
    $itOpen  = $menu.Items.Add('Open DeepSeek Harness')
    $itClose = $menu.Items.Add('Stop the harness')
    $itCheck = $menu.Items.Add('Check for updates now')
    [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    $itExit  = $menu.Items.Add('Exit DSH Launcher')

    $itOpen.Add_Click({  $tray.action = 'open'  }.GetNewClosure())
    $itClose.Add_Click({ $tray.action = 'close' }.GetNewClosure())
    $itCheck.Add_Click({ $tray.action = 'check' }.GetNewClosure())
    $itExit.Add_Click({  $tray.action = 'exit'  }.GetNewClosure())
    $ni.Add_MouseDoubleClick({
        if ($_.Button -eq 'Left') { $tray.action = 'open' }
    }.GetNewClosure())

    $ni.ContextMenuStrip = $menu
    Show-Balloon $ni 'Running in the background' 'The harness keeps running when you close the window. Use this icon to reopen it or exit.'

    $lastPeriodic = Get-Date

    while (-not $tray.exit) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100

        if ($script:winEdge -and $script:winEdge.HasExited) {
            $script:winEdge = $null
            Show-Balloon $ni 'Window closed' 'The harness is still running. Reopen it any time from this icon.'
        }

        $act = $tray.action
        $tray.action = ''
        if ($act -eq 'open') {
            if ($script:winEdge -and -not $script:winEdge.HasExited) {
                Show-Balloon $ni 'Already open' 'The DeepSeek Harness window is already open.'
            } elseif (-not (Open-EdgeWindow)) {
                Show-Balloon $ni 'Could not open' 'The harness did not start. Try again in a moment.'
            }
        }
        elseif ($act -eq 'close') {
            if ($script:winEdge -and -not $script:winEdge.HasExited) { Invoke-KillTree $script:winEdge.Id }
            $script:winEdge = $null
            Stop-Harness
            Show-Balloon $ni 'Stopped' 'The harness was stopped. Reopen it from this icon when you want it back.'
        }
        elseif ($act -eq 'check') {
            Check-ResidentUpdates $ni
        }
        elseif ($act -eq 'exit') {
            if ($script:winEdge -and -not $script:winEdge.HasExited) { Invoke-KillTree $script:winEdge.Id }
            $script:winEdge = $null
            $tray.exit = $true
        }

        if (((Get-Date) - $lastPeriodic).TotalHours -ge 6) {
            $lastPeriodic = Get-Date
            Check-ResidentUpdates $ni
        }
    }

    $ni.Visible = $false
    try { $ni.Dispose() } catch { }
    try { $menu.Dispose() } catch { }
    Stop-Harness
}
# ==== end resident helpers ==================================================

# Single-instance lock: keep the legacy name for the default data dir so a new
# build and a still-running old build of the same install block each other;
# test copies get their own private name instead.
$defaultDataDir = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness'
$mutexName = 'DeepSeekHarnessApp'
if (-not [string]::Equals($DataDir, $defaultDataDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    $mutexName = 'DeepSeekHarnessApp_' + ($DataDir -replace '[^A-Za-z0-9]', '_')
}

$shell = New-Object -ComObject WScript.Shell
function Say($msg, $icon = 64) { $shell.Popup($msg, 15, 'DeepSeek Harness', $icon) | Out-Null }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Scrollable viewer, used when something fails and we need to show real output.
function Show-Log($title, $body) {
    $lf = New-Object Windows.Forms.Form
    $lf.Text          = $title
    $lf.StartPosition = 'CenterScreen'
    $lf.ClientSize    = New-Object Drawing.Size(780, 470)
    $tb = New-Object Windows.Forms.TextBox
    $tb.Multiline  = $true
    $tb.ReadOnly   = $true
    $tb.ScrollBars = 'Both'
    $tb.WordWrap   = $false
    $tb.Dock       = 'Fill'
    $tb.Font       = New-Object Drawing.Font('Consolas', 9)
    $tb.Text       = $body
    $lf.Controls.Add($tb)
    $lf.ShowDialog() | Out-Null
    $lf.Dispose()
}

# --- settings ---------------------------------------------------------------
# autoUpdate            : install newer builds of your own channel silently
#                         (default on); turn it off to be asked instead.
# launcherLastCheck     : ISO timestamp of the last launcher-update check.
# launcherUpdatePending : user approved a staged launcher update (applied on
#                         the next start, then cleared).
# launcherRemindAfter   : ISO timestamp; do not ask about the launcher update
#                         again before this moment (used after a Cancel).
# dshNotifiedTag        : the dsh version already announced as pending.
function Get-Settings {
    $d = @{
        autoUpdate = $true
        launcherLastCheck = ''
        launcherUpdatePending = $false
        launcherRemindAfter = ''
        dshNotifiedTag = ''
    }
    if (Test-Path $settingsPath) {
        try {
            $j = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($null -ne $j.autoUpdate) { $d.autoUpdate = [bool]$j.autoUpdate }
            if ($j.launcherLastCheck) { $d.launcherLastCheck = [string]$j.launcherLastCheck }
            if ($null -ne $j.launcherUpdatePending) { $d.launcherUpdatePending = [bool]$j.launcherUpdatePending }
            if ($j.launcherRemindAfter) { $d.launcherRemindAfter = [string]$j.launcherRemindAfter }
            if ($j.dshNotifiedTag) { $d.dshNotifiedTag = [string]$j.dshNotifiedTag }
        } catch { }
    }
    $d
}
function Save-Settings($s) {
    try { [pscustomobject]$s | ConvertTo-Json | Set-Content $settingsPath -Encoding utf8 } catch { }
}

# --- splash -----------------------------------------------------------------
$splash = New-Object Windows.Forms.Form
$splash.FormBorderStyle = 'None'
$splash.StartPosition   = 'CenterScreen'
$splash.Size            = New-Object Drawing.Size(500, 262)
$splash.BackColor       = [Drawing.Color]::FromArgb(24, 24, 27)
$splash.TopMost         = $true
$splash.Text            = 'DeepSeek Harness'
$splash.KeyPreview      = $true

function New-Label($text, $x, $y, $w, $size, $argb) {
    $l = New-Object Windows.Forms.Label
    $l.Text      = $text
    $l.Location  = New-Object Drawing.Point($x, $y)
    $l.Size      = New-Object Drawing.Size($w, ([int]$size * 2 + 8))
    $l.ForeColor = [Drawing.Color]::FromArgb($argb)
    $l.Font      = New-Object Drawing.Font('Segoe UI', $size)
    $l.BackColor = [Drawing.Color]::Transparent
    $l
}

$lblTitle  = New-Label 'DeepSeek Harness' 28 22  440 15 0xFFF4F4F5
$lblStatus = New-Label 'Starting...'      28 56  440 10 0xFF9CA3AF
$lblVer    = New-Label ''                 28 80  440  9 0xFF6B7280
$lblRel    = New-Label ''                 28 116 440  9 0xFFB4B4BB
$lblAlp    = New-Label ''                 28 138 440  9 0xFFB4B4BB

$bar = New-Object Windows.Forms.ProgressBar
$bar.Style    = 'Marquee'
$bar.Location = New-Object Drawing.Point(28, 166)
$bar.Size     = New-Object Drawing.Size(444, 8)
$bar.MarqueeAnimationSpeed = 25

$btnAct = New-Object Windows.Forms.Button
$btnAct.Size      = New-Object Drawing.Size(444, 34)
$btnAct.Location  = New-Object Drawing.Point(28, 194)
$btnAct.FlatStyle = 'Flat'
$btnAct.BackColor = [Drawing.Color]::FromArgb(37, 99, 235)
$btnAct.ForeColor = [Drawing.Color]::White
$btnAct.Font      = New-Object Drawing.Font('Segoe UI', 10)
$btnAct.Visible   = $false
$btnAct.Text      = ''

# splashState.choice: $null = undecided, 'act' = action button used,
# 'none' = skip. Captured hashtable - see the tray note above.
$splashState = @{ choice = $null }
$btnAct.Add_Click({ $splashState.choice = 'act' }.GetNewClosure())
$splash.Add_KeyDown({
    if ($_.KeyCode -in @([Windows.Forms.Keys]::Enter, [Windows.Forms.Keys]::Escape)) {
        if ($null -eq $splashState.choice) { $splashState.choice = 'none' }
    }
}.GetNewClosure())

$splash.Controls.AddRange(@($lblTitle, $lblStatus, $lblVer, $lblRel, $lblAlp, $bar, $btnAct))
$splash.Show()

function Status($text) { $lblStatus.Text = $text; [Windows.Forms.Application]::DoEvents() }
function Pump($ms) {
    $end = (Get-Date).AddMilliseconds($ms)
    while ((Get-Date) -lt $end) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 40
    }
}
function Close-Splash { if ($splash -and -not $splash.IsDisposed) { $splash.Close(); $splash.Dispose() } }

# Show the two channel rows on the splash while versions are checked.
function Set-SplashRows($relText, $alpText) {
    if ($lblRel -and -not $lblRel.IsDisposed) { $lblRel.Text = [string]$relText }
    if ($lblAlp -and -not $lblAlp.IsDisposed) { $lblAlp.Text = [string]$alpText }
}

# Show (or hide, when $text is empty) the single contextual action button.
function Set-SplashAction($text) {
    if ($btnAct -and -not $btnAct.IsDisposed) {
        $splashState.choice = $null
        if ([string]$text -eq '') { $btnAct.Visible = $false }
        else { $btnAct.Text = [string]$text; $btnAct.Visible = $true }
    }
}

# Pump the splash until the user acts, presses Enter/Esc, or the timeout
# passes. Returns 'act' or 'none'.
function Wait-SplashDecision($seconds) {
    $splashState.choice = $null
    $end = (Get-Date).AddSeconds([Math]::Max(0, [int]$seconds))
    while ($null -eq $splashState.choice -and (Get-Date) -lt $end) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 40
    }
    if ($null -eq $splashState.choice) { $splashState.choice = 'none' }
    $splashState.choice
}

# --- single instance --------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) { Close-Splash; Say 'DeepSeek Harness is already running.'; exit 0 }

# --- launcher self-update apply ---------------------------------------------
# A staged, user-approved launcher update from a previous session is swapped in
# here, before anything UI-related and without touching the boot path. This
# instance keeps running the old image; every later start is the new version.
$s0 = Get-Settings
if ($s0.launcherUpdatePending) {
    Invoke-ApplyStagedLauncherUpdate
    $s0.launcherUpdatePending = $false
    Save-Settings $s0
}
$s0 = $null

# --- versions ---------------------------------------------------------------
function Get-InstalledVersion {
    if (-not (Test-Path $manifest)) { return $null }
    try { (Get-Content $manifest -Raw | ConvertFrom-Json).version } catch { $null }
}
function Get-Packument {
    if ($script:packument) { return $script:packument }
    try {
        $u = "https://registry.npmjs.org/$($Package -replace '/', '%2F')"
        $script:packument = Invoke-RestMethod -Uri $u -TimeoutSec 8 `
            -Headers @{ Accept = 'application/vnd.npm.install-v1+json' }
    } catch { $script:packument = $null }   # offline: stay on what we have
    $script:packument
}

function Get-DistTags {
    $doc = Get-Packument
    if ($doc) { $doc.'dist-tags' } else { $null }
}

# --- self test --------------------------------------------------------------
# "DSHLauncher.exe -selftest" (or: powershell -File .\dsh-app.ps1 -selftest)
# prints how this run is wired up and exits before any window or dialog opens.
# It never touches the registry, the network or any real install.
if ($args -contains '-selftest') {
    Write-Host 'DSH Launcher self test'
    Write-Host ("  DataDir     : {0}"   -f $DataDir)
    Write-Host ("  Port        : {0}"   -f $Port)
    Write-Host ("  Mutex       : {0}"   -f $mutexName)
    Write-Host ("  runtimeDir  : {0}"   -f $runtimeDir)
    Write-Host ("  profileDir  : {0}"   -f $profileDir)
    Write-Host ("  profileRoot : {0}"   -f $profileRoot)
    Write-Host ("  settingsPath: {0}"   -f $settingsPath)
    $s = Get-Settings
    Write-Host ("  defaults    : autoUpdate={0}" -f $s.autoUpdate)
    Write-Host ("  installed   : {0}" -f (Get-InstalledVersion))
    Write-Host ("  launcher    : {0}" -f (Get-LauncherVersion))
    Write-Host ("  compare rc/alpha 0.1.2-rc.1 vs 0.1.5-alpha.1 : {0}" -f (Compare-DshVersion '0.1.2-rc.1' '0.1.5-alpha.1'))
    Write-Host ("  compare rc vs release 0.1.2-rc.1 vs 0.1.2 : {0}" -f (Compare-DshVersion '0.1.2-rc.1' '0.1.2'))
    $np = Find-NodeExe
    Write-Host ("  node        : {0}" -f $(if ($np) { $np } else { 'not found' }))
    if ($np) { Write-Host ("  node version: {0}" -f (& $np --version 2>$null)) }
    Close-Splash
    exit 0
}

# Yes/No confirmation used before anything that downloads a build, so nobody
# is surprised by the download/install time. Returns true when confirmed.
function Confirm-Install([string]$target, [string]$reason) {
    $body = "About to download and install dsh $target.`r`n"
    if ($reason) { $body += "$reason`r`n" }
    $body += "`r`nDownloading and installing can take several minutes, more on a slow" +
             "`r`nconnection. The app will close and restart by itself when done.`r`n`r`nProceed?"
    $r = $shell.Popup($body, 0, 'DeepSeek Harness', 4 + 32)
    ($r -eq 6)
}

# Shown on the very first run. Only the two current builds are offered - the
# latest release and the latest alpha - because the launcher keeps whatever is
# installed on the latest of its channel automatically. There is no reason to
# pick an older build.
# Returns 'release' | 'alpha' | $null (closed without choosing).
function Show-FirstRunChoice($releaseTag, $alphaTag) {
    $state = @{ choice = $null }

    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(620, 300)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $f.Controls.Add((New-Label 'Welcome - choose a channel' 24 20 560 14 0xFFF4F4F5))

    function New-ChannelButton($text, $y, $enabled) {
        $b = New-Object Windows.Forms.Button
        $b.Text      = $text
        $b.Size      = New-Object Drawing.Size(560, 36)
        $b.Location  = New-Object Drawing.Point(24, $y)
        $b.FlatStyle = 'Flat'
        $b.BackColor = if ($enabled) { [Drawing.Color]::FromArgb(55, 55, 62) } else { [Drawing.Color]::FromArgb(35, 35, 40) }
        $b.ForeColor = if ($enabled) { [Drawing.Color]::White } else { [Drawing.Color]::FromArgb(120, 120, 125) }
        $b.Font      = New-Object Drawing.Font('Segoe UI', 10)
        $b.Enabled   = $enabled
        $b
    }

    $bRelease = New-ChannelButton ('Install release  (' + $releaseTag + ')') 58 ($null -ne $releaseTag)
    $bAlpha   = New-ChannelButton ('Install alpha  (' + $alphaTag + ')')   106 ($null -ne $alphaTag)

    $bRelease.Add_Click({ $state.choice = 'release'; $f.Close() }.GetNewClosure())
    $bAlpha.Add_Click({   $state.choice = 'alpha';   $f.Close() }.GetNewClosure())

    $f.Controls.AddRange(@($bRelease, $bAlpha))

    $note = New-Label ("Alpha builds change often and may be unstable.`r`n" +
                       "Installing downloads now and takes a few minutes. Newer builds of`r`n" +
                       "your channel install automatically afterwards, and you can switch`r`n" +
                       "channels any time from the status card on each start.") 24 160 560 9 0xFF9CA3AF
    $note.Size = New-Object Drawing.Size(560, 90)
    $f.Controls.Add($note)

    $f.AcceptButton = $bRelease
    $f.ShowDialog() | Out-Null
    $f.Dispose()
    $state.choice
}

# --- decide what to install -------------------------------------------------
Status 'Checking for updates...'

$settings  = Get-Settings
$installed = Get-InstalledVersion
if ($installed) { $lblVer.Text = "dsh $installed" }

$tags       = Get-DistTags
$tagRelease = if ($tags) { $tags.latest } else { $null }
$tagAlpha   = if ($tags) { $tags.alpha }  else { $null }

$install = $null

if (-not $installed) {
    # --- first run --------------------------------------------------------
    if (-not $tagRelease -and -not $tagAlpha) {
        Close-Splash
        Say "Could not reach the package registry.`nCheck your internet connection and relaunch." 48
        Stop-Harness
        exit 0
    }

    Status 'Checking available builds...'
    $splash.TopMost = $false
    $choice = Show-FirstRunChoice $tagRelease $tagAlpha
    $splash.TopMost = $true

    if (-not $choice) { Close-Splash; Stop-Harness; exit 0 }   # closed without choosing

    $install = if ($choice -eq 'alpha') { $tagAlpha } else { $tagRelease }
}
else {
    # Which channel the installed build belongs to decides everything else:
    # same-line builds update silently; the other line is one click away.
    $myLine    = if ($installed -match '-alpha') { 'alpha' } else { 'release' }
    $otherLine = if ($myLine -eq 'alpha') { 'release' } else { 'alpha' }
    $myTag     = if ($myLine -eq 'alpha') { $tagAlpha }   else { $tagRelease }
    $otherTag  = if ($myLine -eq 'alpha') { $tagRelease } else { $tagAlpha }

    $cmpSame = if ($myTag) { Compare-DshVersion $myTag $installed } else { 0 }
    $sameUpdate = ($cmpSame -gt 0)

    if ($sameUpdate -and $settings.autoUpdate) {
        # Silent, unattended same-line update (release and alpha alike).
        # The splash announces it; no dialog interrupts the start.
        $install = $myTag
        Status "New $myLine build $myTag found - updating automatically..."
    }
    else {
        # One window does it all: while the splash says "Checking for updates"
        # it also shows both channels and the single switch button. No second
        # dialog pops up over it; ignoring the button (or Enter/Esc) carries on.
        $rowR = ''
        $rowA = ''
        if ($myLine -eq 'release') {
            $rowR = "installed  $installed"
            if ($sameUpdate) { $rowR = "installed  $installed   (newer $myTag)" }
            $rowA = if ($otherTag) { "latest  $otherTag" } else { 'not published' }
        }
        else {
            $rowR = if ($otherTag) { "latest  $otherTag" } else { 'not published' }
            $rowA = "installed  $installed"
            if ($sameUpdate) { $rowA = "installed  $installed   (newer $myTag)" }
        }
        Set-SplashRows "Release channel   $rowR" "Alpha channel      $rowA"

        if ($sameUpdate) {
            Status 'Update available...'
            Set-SplashAction "Update now to $myTag"
        }
        elseif ($otherTag) {
            Set-SplashAction $(if ($myLine -eq 'release') { "Try alpha ($otherTag)" } else { "Go stable ($otherTag)" })
        }

        # Wait only when there is a button to press.
        if ($btnAct.Visible) {
            $decision = Wait-SplashDecision $DialogTimeout
            Set-SplashAction ''          # hide the button again
            if ($decision -eq 'act') {
                if ($sameUpdate) {
                    if (Confirm-Install $myTag "Update on the $myLine channel.") { $install = $myTag }
                }
                elseif ($otherTag) {
                    $reason = "This switches you from the $myLine channel to the $otherLine channel."
                    if ($otherLine -eq 'alpha') {
                        $reason += ' Alpha builds change often and may be unstable.'
                    }
                    if (Confirm-Install $otherTag $reason) { $install = $otherTag }
                }
            }
        }
        Set-SplashRows '' ''
    }
}

# --- node resolution --------------------------------------------------------
# Everything below (npm install and booting the harness) runs node directly by
# path, so it works even when Node was installed after this process started
# and the PATH of this process was never refreshed.
$nodePath = Find-NodeExe
if (-not $nodePath) {
    Status 'Node.js is missing - installing the LTS build...'
    Install-NodeSilently | Out-Null
    $nodePath = Find-NodeExe
}
if (-not $nodePath) {
    Close-Splash
    Say ("Node.js was not found and could not be installed automatically.`n`n" +
         'Install the LTS build from nodejs.org, then relaunch DSH Launcher.') 16
    Stop-Harness
    exit 1
}

$nodeMajor = 0
try {
    $nv = & $nodePath --version 2>$null
    if ($nv -match '^v?(\d+)') { $nodeMajor = [int]$Matches[1] }
} catch { }
if ($nodeMajor -gt 0 -and $nodeMajor -lt 18) {
    Close-Splash
    Say ("Node.js $nodeMajor was found, but the DeepSeek Harness needs Node 18 or newer.`n`n" +
         'Install the current LTS build from nodejs.org, then relaunch.') 16
    Stop-Harness
    exit 1
}
# npm lifecycle scripts can shell out to `node` (koffi's cnoke build step does
# exactly that: cmd.exe /c node ./cnoke.cjs ...) and they resolve it through
# PATH, not through the absolute node path we launched npm with. Prepend the
# resolved Node directory so this process - and every child it spawns - can
# find `node`, including when Node was installed after this process started.
$nodeDir = Split-Path $nodePath
if ($nodeDir) { $env:PATH = $nodeDir + ';' + $env:PATH }

$npmCli = Join-Path (Split-Path $nodePath) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { $npmCli = $null }   # unusual; fall back below

# --- install / update -------------------------------------------------------
if ($install) {
    Status "Installing dsh $install - this takes a minute..."

    # Install into a staging folder and swap it in only once it verifies, so
    # the running version stays on disk until the new one is ready. A failed
    # or interrupted update can therefore never leave the app without a
    # working runtime.
    $stageDir      = $runtimeDir + '.new'
    $swapBackup    = $runtimeDir + '.old'
    $stageManifest = Join-Path $stageDir 'node_modules\@deepseek-ai\dsh\package.json'

    # Clear leftovers from a previous interrupted update.
    foreach ($d in @($stageDir, $swapBackup)) {
        for ($try = 0; $try -lt 3 -and (Test-Path $d); $try++) {
            Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $d) { Pump 700 }
        }
    }

    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    '{ "name": "dsh-app-runtime", "private": true }' |
        Set-Content (Join-Path $stageDir 'package.json') -Encoding utf8

    if ($npmCli) {
        # Drive npm through node itself; no dependence on PATH or cmd.exe.
        $npm = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
            -ArgumentList @("`"$npmCli`"", 'install', "$Package@$install", '--prefix', "`"$stageDir`"", '--no-audit', '--no-fund') `
            -RedirectStandardOutput (Join-Path $appDir 'npm.out.log') `
            -RedirectStandardError  (Join-Path $appDir 'npm.err.log')
    } else {
        # Fallback for an unusual install layout: PATH-based npm.
        $npm = Start-Process cmd.exe -PassThru -WindowStyle Hidden `
            -ArgumentList '/c', "npm install $Package@$install --prefix `"$stageDir`" --no-audit --no-fund" `
            -RedirectStandardOutput (Join-Path $appDir 'npm.out.log') `
            -RedirectStandardError  (Join-Path $appDir 'npm.err.log')
    }

    # Touching .Handle keeps the process handle open, which is what makes
    # ExitCode readable later. Without it, ExitCode is always $null.
    try { $null = $npm.Handle } catch { }

    $installStart = Get-Date
    $lastNote = -15
    while (-not $npm.HasExited) {
        Pump 250
        $el = [int]((Get-Date) - $installStart).TotalSeconds
        if ($el -ge $lastNote + 15) {
            $lastNote = $el
            Status ("Installing dsh $install - {0}m {1}s so far (first install can take several minutes)..." -f [int]($el / 60), ($el % 60))
        }
    }

    $exitCode = 'unavailable'
    try { if ($npm.ExitCode -ne $null) { $exitCode = [string]$npm.ExitCode } } catch { }

    # The manifest on disk is the real test of success; the exit code is only
    # reported for diagnosis.
    $nowVersion = $null
    if (Test-Path $stageManifest) {
        try { $nowVersion = (Get-Content $stageManifest -Raw | ConvertFrom-Json).version } catch { }
    }
    $ok = [bool]$nowVersion
    if ($ok -and $install -match '^\d') { $ok = ($nowVersion -eq $install) }

    if (-not $ok) {
        # A failed install must never destroy the version that still works.
        Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue

        $ne = if (Test-Path (Join-Path $appDir 'npm.err.log')) { Get-Content (Join-Path $appDir 'npm.err.log') -Raw } else { '' }
        $no = if (Test-Path (Join-Path $appDir 'npm.out.log')) { Get-Content (Join-Path $appDir 'npm.out.log') -Raw } else { '' }

        # npm sends warnings to stderr too, so surface the real errors separately.
        $real = ($ne -split "`r?`n" | Where-Object { $_ -match 'npm (error|ERR!)' }) -join "`r`n"
        if (-not $real) { $real = '(no npm error lines found - see full output below)' }

        $stillHave = (Test-Path $manifest) -and [bool](Get-InstalledVersion)
        $advice = ''
        if ($stillHave) {
            $advice = "`nThe previous install was left untouched and will be used."
        } else {
            $advice = @"

If this mentions EPERM, EBUSY or a locked .node / .dll file, a previous harness
is still running. Close the app, then run:

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { `$_.CommandLine -like '*$runtimeDir*' } |
    ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }
  Remove-Item "$runtimeDir" -Recurse -Force

Then relaunch.
"@
        }

        $report = @"
Install of $Package@$install failed.

Exit code : $exitCode
Staging   : $stageDir
Installed : $nowVersion

Lines beginning "npm warn deprecated" are harmless notices, not the failure.
The errors below are the real cause.
$advice

--------------------------- npm errors ---------------------------
$real
--------------------------- full stderr --------------------------
$ne
--------------------------- full stdout --------------------------
$no
"@

        Show-Log 'DeepSeek Harness - install failed' $report

        if ($stillHave) {
            # Keep going with the version that was already installed.
            $installed = Get-InstalledVersion
            $install = $null
            Status "Using previously installed dsh $installed."
        } else {
            Stop-Harness
            exit 1
        }
    }
    else {
        # Swap the verified staging folder into place. Native .node / .dll
        # files stay locked while a harness is alive, so release our own
        # leftovers first or the rename fails.
        Stop-OrphanHarness
        for ($try = 0; $try -lt 4 -and (Test-Path $runtimeDir); $try++) {
            try {
                Rename-Item $runtimeDir $swapBackup -ErrorAction Stop
                break
            } catch { Pump 700 }
        }
        if (Test-Path $runtimeDir) {
            Close-Splash
            Say ("Could not move the old runtime aside - files are still locked:`n$runtimeDir`n`n" +
                 'Close the app, sign out and back in, then relaunch.') 16
            Stop-Harness
            exit 1
        }

        try {
            Rename-Item $stageDir $runtimeDir -ErrorAction Stop
        } catch {
            # Put the previous version back so we are never left without one.
            if (Test-Path $swapBackup) { Rename-Item $swapBackup $runtimeDir -ErrorAction SilentlyContinue }
            Close-Splash
            Say ("The new build could not be moved into place:`n$runtimeDir`n`nThe previous version has been restored.") 16
            Stop-Harness
            exit 1
        }

        for ($try = 0; $try -lt 3 -and (Test-Path $swapBackup); $try++) {
            Remove-Item $swapBackup -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $swapBackup) { Pump 700 }
        }

        $installed = Get-InstalledVersion
    }
}
$lblVer.Text = "dsh $installed"

# --- restart after an install -----------------------------------------------
# dsh finishes building its plugin tree during the first served session, and
# that reload drops the open page ("connecting... disconnected"). The reliable
# remedy is to let that first session run and then start the app once more,
# so after an install the app asks the user to close it and launch again
# (Invoke-CloseAfterInstall below) instead of killing the first session and
# relaunching automatically.

$restartAfterOpen = $PromptRestartAfterInstall -and [bool]$install

# --- start the harness ------------------------------------------------------
Status 'Booting the harness...'
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue
$dshBin = Join-Path $runtimeDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path $dshBin)) {
    Close-Splash
    Say "The dsh entry point is missing:`n$dshBin`n`nDelete the runtime folder and relaunch to reinstall." 16
    Stop-Harness
    exit 1
}

# A harness orphaned by a previous session keeps holding the port, which makes
# every later launch fail with EADDRINUSE. Clear ours out before binding, then
# give Windows a moment to release the socket.
Stop-OrphanHarness

# If the pinned port is still taken afterwards, it belongs to something we do
# not own: refuse rather than drift to a random port, because a second server
# would fight over the same dsh profile and the Edge app identity.
$usePort = $Port
for ($i = 0; $i -lt 12 -and -not (Test-PortFree $usePort); $i++) { Pump 250 }
if (-not (Test-PortFree $usePort)) {
    Close-Splash
    $owner = 'another program'
    try {
        $conn = Get-NetTCPConnection -LocalPort $usePort -State Listen -ErrorAction Stop |
                Select-Object -First 1
        $pn = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        if ($pn) { $owner = "$pn (PID $($conn.OwningProcess))" }
    } catch { }
    Say ("Port $usePort is already in use by $owner.`n`n" +
         'If that is a leftover DeepSeek Harness from an earlier session, just' +
         "`nrelaunch - leftovers are cleaned up automatically.`n`n" +
         'Otherwise close the program using the port and relaunch.') 48
    Stop-Harness
    exit 1
}

# dsh owns its plugin profile and installs it with its own pnpm configuration.
# Do not run pnpm in that folder from here - a plain install produces a tree
# that boots the server but leaves the client bundles mismatched.

# dsh keeps its plugin tree in $DSH_HOME\profiles\<name> and rebuilds it after
# the package version changes. That first boot is slow and can fail outright
# while the profile is still being populated, so allow more time and one retry
# whenever we have just installed something.
$maxAttempts = if ($install) { 2 } else { 1 }
$bootSeconds = if ($install) { 240 } else { 90 }
$url = $null

for ($attempt = 1; $attempt -le $maxAttempts -and -not $url; $attempt++) {

    if ($attempt -gt 1) {
        Status 'First boot did not settle - rebuilding the profile...'
        Stop-OrphanHarness
        Pump 2000
    }

    Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

    # --no-open stops dsh opening the default browser; we supply the window.
    $harness = Start-Process -FilePath $nodePath -PassThru -WindowStyle Hidden `
        -WorkingDirectory $env:USERPROFILE `
        -ArgumentList "`"$dshBin`"", 'web', '--host', '127.0.0.1', '--port', $usePort, '--no-open' `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog

    try { $null = $harness.Handle } catch { }

    # dsh prints its URL once the plugin tree has settled.
    $bootStart = (Get-Date)
    $lastNote = -15
    $deadline = (Get-Date).AddSeconds($bootSeconds)
    while (-not $url -and (Get-Date) -lt $deadline) {
        Pump 400
        $el = [int]((Get-Date) - $bootStart).TotalSeconds
        if ($el -ge $lastNote + 15) {
            $lastNote = $el
            Status ("Waiting for the harness to come up - {0}m {1}s..." -f [int]($el / 60), ($el % 60))
        }
        $text = ''
        foreach ($f in @($outLog, $errLog)) {
            if (Test-Path $f) { $text += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
        }
        $m = [regex]::Match($text, 'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"''\)\]]*')
        if ($m.Success) { $url = $m.Value.TrimEnd('.', ',') }
        if ($harness.HasExited -and -not $url) { break }
    }

    if (-not $url -and $harness -and -not $harness.HasExited) {
        Invoke-KillTree $harness.Id
    }
}

# Runs even if the console is closed or the script is interrupted, so a harness
# is never left holding the port. Stop-Harness and Stop-OrphanHarness are
# defined at the top of this file.
Register-EngineEvent PowerShell.Exiting -Action { Stop-Harness } | Out-Null

# Shown once after a successful install. The first session settles the harness
# profile; closing the app and starting it once more connects cleanly.
function Show-RestartRequired {
    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(560, 200)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.ControlBox      = $false
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $f.Controls.Add((New-Label 'Restart required' 24 20 500 13 0xFFF4F4F5))

    $body  = "dsh $installed was installed.`r`n"
    $body += "`r`nThe first session finishes the setup. Close the app now and start"
    $body += "`r`nit again from the Start Menu - the second start connects cleanly."
    $txt = New-Label $body 24 56 500 9 0xFFB4B4BB
    $txt.Size = New-Object Drawing.Size(500, 90)
    $f.Controls.Add($txt)

    $b = New-Object Windows.Forms.Button
    $b.Text      = 'Close'
    $b.Size      = New-Object Drawing.Size(150, 32)
    $b.Location  = New-Object Drawing.Point(386, 150)
    $b.FlatStyle = 'Flat'
    $b.BackColor = [Drawing.Color]::FromArgb(55, 55, 62)
    $b.ForeColor = [Drawing.Color]::White
    $b.Font      = New-Object Drawing.Font('Segoe UI', 9)
    $b.Add_Click({ $f.Close() }.GetNewClosure())

    $f.Controls.Add($b)
    $f.AcceptButton = $b
    $f.Add_Shown({ $b.Focus() }.GetNewClosure())
    $f.ShowDialog() | Out-Null
    $f.Dispose()
}

# Called once the window is up, on a launch that just installed something.
# The user closes the app here and starts it again themselves.
function Invoke-CloseAfterInstall($windowProc) {
    Show-RestartRequired

    # The user has committed to closing, so free the single-instance lock NOW.
    # Cleanup below takes a second or two; releasing first means a quick
    # relaunch never hits a phantom "already running" message.
    Get-EventSubscriber -ErrorAction SilentlyContinue |
        Where-Object { $_.SourceIdentifier -eq 'PowerShell.Exiting' } |
        Unregister-Event -ErrorAction SilentlyContinue
    try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch { }

    # Stop everything from this run; the next launch starts fresh.
    if ($windowProc -and -not $windowProc.HasExited) {
        Invoke-KillTree $windowProc.Id
    }
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" } |
        ForEach-Object { Invoke-KillTree $_.ProcessId }
    Stop-Harness
    exit 0
}

# Called once the window is up, only on a launch that installed something.
if (-not $url) {
    Close-Splash

    # An empty profile tree is the single most common cause and produces a
    # hundred near-identical "Cannot find package" lines, so name it up front.
    $pkgCount = Get-ProfilePluginCount

    $hint = ''
    if ($pkgCount -eq 0) {
        $hint = @"

The dsh profile at $webProfile has no plugins installed. dsh builds it with
pnpm on first boot; that step did not finish. Launch the app again - it
usually completes on a second run.
"@
    }

    $so   = if (Test-Path $outLog) { Get-Content $outLog -Raw } else { '' }
    $se   = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { '' }
    $code = 'still running (timed out)'
    if ($harness.HasExited) {
        $code = 'unavailable'
        try { if ($harness.ExitCode -ne $null) { $code = [string]$harness.ExitCode } } catch { }
    }

    $report = @"
The harness did not report a URL.

Version : $installed
Entry   : $dshBin
Command : node "$dshBin" web --host 127.0.0.1 --port $usePort --no-open
Exit    : $code
Profile : $webProfile  ($pkgCount plugins)
$hint

To reproduce in a visible console, paste the Command line above into PowerShell.
If this started right after installing a build, close the app and launch it
once more - the profile usually settles on the second start.

------------------------------ stderr ------------------------------
$se
------------------------------ stdout ------------------------------
$so
"@

    Show-Log 'DeepSeek Harness - startup failed' $report
    Stop-Harness
    exit 1
}

# --- keep the throwaway Edge profile quiet ----------------------------------
function Initialize-EdgeProfile {
    New-Item -ItemType File -Force -Path (Join-Path $profileDir 'First Run') | Out-Null

    $defaultDir = Join-Path $profileDir 'Default'
    New-Item -ItemType Directory -Force -Path $defaultDir | Out-Null

    $prefs = Join-Path $defaultDir 'Preferences'
    if (-not (Test-Path $prefs)) {
        '{"session":{"restore_on_startup":5},"browser":{"has_seen_welcome_page":true},"distribution":{"skip_first_run_ui":true,"import_search_engine":false,"import_history":false}}' |
            Set-Content $prefs -Encoding utf8
    }

    Remove-Item (Join-Path $defaultDir 'Sessions') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $defaultDir 'Last Session'),
                (Join-Path $defaultDir 'Last Tabs') -Force -ErrorAction SilentlyContinue
}

# The harness is up: remember its URL so the tray "Open" action can re-attach
# to this same instance instead of booting a second one.
$script:lastUrl = $url

# --- open the window --------------------------------------------------------
Status 'Opening...'

switch ($Mode) {

    'pwa' {
        $lnk = Get-ChildItem -Recurse -Filter "$PwaName.lnk" -ErrorAction SilentlyContinue -Path @(
            "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
            "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
        ) | Select-Object -First 1

        if (-not $lnk) { Close-Splash; Say "No installed Edge app named '$PwaName' was found." 16; Stop-Harness; exit 1 }

        $target = $shell.CreateShortcut($lnk.FullName)
        $appId  = ([regex]::Match($target.Arguments, '--app-id=([A-Za-z]+)')).Groups[1].Value
        Start-Process $target.TargetPath -ArgumentList $target.Arguments

        Pump 3000; Close-Splash
        if ($restartAfterOpen) { Invoke-CloseAfterInstall $null }
        Start-Sleep -Seconds 2
        $gone = 0
        while ($gone -lt 3) {
            Start-Sleep -Seconds 2
            $live = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
                      Where-Object { $_.CommandLine -like "*$appId*" })
            if ($live.Count -eq 0) { $gone++ } else { $gone = 0 }
        }
    }

    'edge-app' {
        $edge = @(
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1

        if (-not $edge) {
            Start-Process $url; Pump 2500; Close-Splash
            if ($restartAfterOpen) { Invoke-CloseAfterInstall $null }
            $harness.WaitForExit()
        }
        else {
            Initialize-EdgeProfile
            $e = Start-Process $edge -PassThru -ArgumentList @(
                "--app=$url"
                "--user-data-dir=`"$profileDir`""
                '--no-first-run'
                '--no-default-browser-check'
                '--disable-fre'
                '--no-service-autorun'
                '--disable-sync'
                '--disable-background-mode'
                '--disable-features=msEdgeWelcomePage,msImplicitSignin,msEdgeSplitScreen'
            )
            Pump 2500
            Close-Splash
            if ($restartAfterOpen) { Invoke-CloseAfterInstall $e }
            # Background mode: closing the window keeps the harness running.
            # The tray icon reopens it or exits; this returns only on Exit.
            Enter-TrayLifecycle $e
        }
    }

    default {
        Start-Process $url; Pump 2500; Close-Splash
        if ($restartAfterOpen) { Invoke-CloseAfterInstall $null }
        $harness.WaitForExit()
    }
}

Close-Splash
Stop-Harness
$mutex.ReleaseMutex()