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
$DefaultChannel = 'latest'   # 'latest' (stable line) or 'alpha'
$Port     = 8765             # pinned: keeps the Edge PWA identity stable
$Mode     = 'edge-app'       # 'edge-app' | 'pwa' | 'browser'
$PwaName  = 'DeepSeek Harness'
$Package  = '@deepseek-ai/dsh'
$DialogTimeout = 3           # seconds before a dialog dismisses itself; 0 = never
# dsh builds its plugin tree during the first served session after an install,
# and that reload drops the open page ("connecting... disconnected"). It only
# happens when the profile in $DSH_HOME has to be built - which is every new
# machine. Prompting for one restart after an install is the reliable remedy.
$PromptRestartAfterInstall = $true
# $env:DSH_HOME = 'C:\Users\me\.dsh'   # uncomment to isolate this app's profile
# ===========================================================================

$appDir       = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness'
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
function Get-Settings {
    $d = @{ channel = $DefaultChannel; skipVersion = '' }
    if (Test-Path $settingsPath) {
        try {
            $j = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($j.channel)     { $d.channel     = [string]$j.channel }
            if ($j.skipVersion) { $d.skipVersion = [string]$j.skipVersion }
            elseif ($j.skipAlpha) { $d.skipVersion = [string]$j.skipAlpha }   # older key
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
$splash.Size            = New-Object Drawing.Size(470, 172)
$splash.BackColor       = [Drawing.Color]::FromArgb(24, 24, 27)
$splash.TopMost         = $true
$splash.Text            = 'DeepSeek Harness'

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

$lblTitle  = New-Label 'DeepSeek Harness' 28 26  400 15 0xFFF4F4F5
$lblStatus = New-Label 'Starting...'      28 68  400 10 0xFF9CA3AF
$lblVer    = New-Label ''                 28 132 400  8 0xFF6B7280

$bar = New-Object Windows.Forms.ProgressBar
$bar.Style    = 'Marquee'
$bar.Location = New-Object Drawing.Point(28, 104)
$bar.Size     = New-Object Drawing.Size(414, 8)
$bar.MarqueeAnimationSpeed = 25

$splash.Controls.AddRange(@($lblTitle, $lblStatus, $lblVer, $bar))
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

# --- single instance --------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'DeepSeekHarnessApp')
if (-not $mutex.WaitOne(0)) { Close-Splash; Say 'DeepSeek Harness is already running.'; exit 0 }

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

# --- update dialog ----------------------------------------------------------
# Returns one of: pick | ignore | none
function Show-ChannelDialog($installed, $channel, $offered, $isAlpha) {
    $state = @{ choice = 'none'; left = $DialogTimeout }

    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(600, 232)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $head = if ($isAlpha) { 'Alpha build available' } else { 'Update available' }
    $f.Controls.Add((New-Label $head 24 20 550 13 0xFFF4F4F5))

    $body  = "Installed:  $installed  ($channel)`r`nAvailable:  $offered"
    if ($isAlpha) {
        $body += "`r`n`r`nAlpha builds change often, are not the version DeepSeek marks"
        $body += "`r`nas ready, and can be replaced or withdrawn."
    }
    $txt = New-Label $body 24 56 550 9 0xFFB4B4BB
    $txt.Size = New-Object Drawing.Size(550, 110)
    $f.Controls.Add($txt)

    function New-ChoiceButton($text, $x) {
        $b = New-Object Windows.Forms.Button
        $b.Text      = $text
        $b.Size      = New-Object Drawing.Size(150, 30)
        $b.Location  = New-Object Drawing.Point($x, 180)
        $b.FlatStyle = 'Flat'
        $b.BackColor = [Drawing.Color]::FromArgb(55, 55, 62)
        $b.ForeColor = [Drawing.Color]::White
        $b.Font      = New-Object Drawing.Font('Segoe UI', 9)
        $b
    }

    $bNone   = New-ChoiceButton "Not now ($($state.left))" 434
    $bIgnore = New-ChoiceButton 'Ignore this version'      276
    $bPick   = New-ChoiceButton 'Pick version...'          118

    $bNone.Add_Click({   $state.choice = 'none';   $f.Close() }.GetNewClosure())
    $bIgnore.Add_Click({ $state.choice = 'ignore'; $f.Close() }.GetNewClosure())
    $bPick.Add_Click({   $state.choice = 'pick';   $f.Close() }.GetNewClosure())

    $f.Controls.AddRange(@($bPick, $bIgnore, $bNone))

    # Default to "Not now" so an unattended launch carries on by itself.
    $f.AcceptButton = $bNone
    $f.CancelButton = $bNone
    $f.Add_Shown({ $bNone.Focus() }.GetNewClosure())

    $timer = $null
    if ($DialogTimeout -gt 0) {
        $timer = New-Object Windows.Forms.Timer
        $timer.Interval = 1000
        $timer.Add_Tick({
            $state.left--
            if ($state.left -le 0) { $timer.Stop(); $f.Close() }
            else { $bNone.Text = "Not now ($($state.left))" }
        }.GetNewClosure())
        $timer.Start()
    }

    $f.ShowDialog() | Out-Null
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    $f.Dispose()
    $state.choice
}

# Shown every boot while on alpha. Auto-closes to "stay" after $DialogTimeout
# seconds. Returns: pick | no
function Show-AlphaReminder($installed, $stableVer) {
    $state = @{ choice = 'no'; left = $DialogTimeout }

    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(600, 210)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $f.Controls.Add((New-Label 'You are on the alpha channel' 24 20 550 13 0xFFF4F4F5))

    $body  = "Installed:    $installed`r`nStable (RC):  $stableVer`r`n`r`n"
    $body += 'Alpha builds are unstable and change often.'
    $txt = New-Label $body 24 54 550 9 0xFFB4B4BB
    $txt.Size = New-Object Drawing.Size(550, 90)
    $f.Controls.Add($txt)

    function New-DlgButton($text, $x) {
        $b = New-Object Windows.Forms.Button
        $b.Text      = $text
        $b.Size      = New-Object Drawing.Size(150, 30)
        $b.Location  = New-Object Drawing.Point($x, 160)
        $b.FlatStyle = 'Flat'
        $b.BackColor = [Drawing.Color]::FromArgb(55, 55, 62)
        $b.ForeColor = [Drawing.Color]::White
        $b.Font      = New-Object Drawing.Font('Segoe UI', 9)
        $b
    }

    $bNo   = New-DlgButton "Stay on alpha ($($state.left))" 434
    $bPick = New-DlgButton 'Pick version...' 276

    $bNo.Add_Click({   $state.choice = 'no';   $f.Close() }.GetNewClosure())
    $bPick.Add_Click({ $state.choice = 'pick'; $f.Close() }.GetNewClosure())

    $f.Controls.AddRange(@($bPick, $bNo))
    $f.AcceptButton = $bNo          # Enter keeps you on alpha
    $f.CancelButton = $bNo          # Esc does the same

    $timer = $null
    if ($DialogTimeout -gt 0) {
        $timer = New-Object Windows.Forms.Timer
        $timer.Interval = 1000
        $timer.Add_Tick({
            $state.left--
            if ($state.left -le 0) { $timer.Stop(); $f.Close() }
            else { $bNo.Text = "Stay on alpha ($($state.left))" }
        }.GetNewClosure())
        $timer.Start()
    }

    $f.Add_Shown({ $bNo.Focus() }.GetNewClosure())
    $f.ShowDialog() | Out-Null
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    $f.Dispose()
    $state.choice
}

# Shown on first run. Two columns of published versions - stable/rc on the
# left, alpha on the right. Returns a version string, or $null if cancelled.
function Show-VersionPicker($tags, $current) {
    $doc = Get-Packument
    if (-not $doc) { return $null }

    $all = @($doc.versions.PSObject.Properties.Name)
    [array]::Reverse($all)                       # registry lists oldest first
    $stable = @($all | Where-Object { $_ -notmatch '-alpha' })
    $alpha  = @($all | Where-Object { $_ -match  '-alpha' })

    $state = @{ choice = $null }

    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(640, 430)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $f.Controls.Add((New-Label 'Choose a version to install' 24 20 590 14 0xFFF4F4F5))
    $f.Controls.Add((New-Label 'Stable / release candidate'  24 62 270  9 0xFFB4B4BB))
    $f.Controls.Add((New-Label 'Alpha - unstable'           336 62 270  9 0xFFB4B4BB))

    $mark = '   <- installed'

    function New-VersionList($x, $items) {
        $lb = New-Object Windows.Forms.ListBox
        $lb.Location      = New-Object Drawing.Point($x, 88)
        $lb.Size          = New-Object Drawing.Size(280, 200)
        $lb.BackColor     = [Drawing.Color]::FromArgb(24, 24, 27)
        $lb.ForeColor     = [Drawing.Color]::FromArgb(0xFF, 0xF4, 0xF4, 0xF5)
        $lb.BorderStyle   = 'FixedSingle'
        $lb.Font          = New-Object Drawing.Font('Consolas', 10)
        $lb.IntegralHeight = $false
        foreach ($v in $items) {
            if ($current -and $v -eq $current) { [void]$lb.Items.Add("$v$mark") }
            else                               { [void]$lb.Items.Add($v) }
        }
        $lb
    }

    $lstStable = New-VersionList 24  $stable
    $lstAlpha  = New-VersionList 336 $alpha
    $f.Controls.AddRange(@($lstStable, $lstAlpha))

    # Only one side can hold a selection at a time.
    $lstStable.Add_SelectedIndexChanged({ if ($lstStable.SelectedIndex -ge 0) { $lstAlpha.ClearSelected() } }.GetNewClosure())
    $lstAlpha.Add_SelectedIndexChanged({ if ($lstAlpha.SelectedIndex -ge 0) { $lstStable.ClearSelected() } }.GetNewClosure())

    # Preselect the installed version, else whatever the registry calls "latest".
    if ($current) {
        $i = $lstStable.Items.IndexOf("$current$mark")
        if ($i -ge 0) { $lstStable.SelectedIndex = $i }
        else {
            $i = $lstAlpha.Items.IndexOf("$current$mark")
            if ($i -ge 0) { $lstAlpha.SelectedIndex = $i }
        }
    }
    if ($lstStable.SelectedIndex -lt 0 -and $lstAlpha.SelectedIndex -lt 0 -and $tags -and $tags.latest) {
        $i = $lstStable.Items.IndexOf([string]$tags.latest)
        if ($i -ge 0) { $lstStable.SelectedIndex = $i }
    }
    if ($lstStable.SelectedIndex -lt 0 -and $lstStable.Items.Count) { $lstStable.SelectedIndex = 0 }

    $note = New-Label ("Alpha builds change often, are not the version DeepSeek marks as ready,`r`n" +
                       "and can be replaced or withdrawn. Pick the stable column unless you`r`n" +
                       "specifically need something in alpha.") 24 298 590 9 0xFF9CA3AF
    $note.Size = New-Object Drawing.Size(590, 60)
    $f.Controls.Add($note)

    $btnInstall = New-Object Windows.Forms.Button
    $btnInstall.Text      = 'Install'
    $btnInstall.Size      = New-Object Drawing.Size(130, 30)
    $btnInstall.Location  = New-Object Drawing.Point(474, 378)
    $btnInstall.FlatStyle = 'Flat'
    $btnInstall.BackColor = [Drawing.Color]::FromArgb(55, 55, 62)
    $btnInstall.ForeColor = [Drawing.Color]::White
    $btnInstall.Font      = New-Object Drawing.Font('Segoe UI', 9)

    $btnCancel = New-Object Windows.Forms.Button
    $btnCancel.Text      = 'Cancel'
    $btnCancel.Size      = New-Object Drawing.Size(130, 30)
    $btnCancel.Location  = New-Object Drawing.Point(336, 378)
    $btnCancel.FlatStyle = 'Flat'
    $btnCancel.BackColor = [Drawing.Color]::FromArgb(55, 55, 62)
    $btnCancel.ForeColor = [Drawing.Color]::White
    $btnCancel.Font      = New-Object Drawing.Font('Segoe UI', 9)

    $btnInstall.Add_Click({
        $pick = $null
        if ($lstStable.SelectedItem)     { $pick = [string]$lstStable.SelectedItem }
        elseif ($lstAlpha.SelectedItem)  { $pick = [string]$lstAlpha.SelectedItem }
        if ($pick) { $state.choice = ($pick -replace '\s+<- installed$', '') }
        $f.Close()
    }.GetNewClosure())
    $btnCancel.Add_Click({ $state.choice = $null; $f.Close() }.GetNewClosure())

    $f.Controls.AddRange(@($btnCancel, $btnInstall))
    $f.AcceptButton = $btnInstall
    $f.CancelButton = $btnCancel

    $f.ShowDialog() | Out-Null
    $f.Dispose()
    $state.choice
}

# Opens the version table and applies the choice. Picking the version that is
# already installed reinstalls it, which doubles as a repair.
function Invoke-VersionPicker {
    $splash.TopMost = $false
    $picked = Show-VersionPicker $tags $installed
    $splash.TopMost = $true
    if (-not $picked) { return }

    $script:install     = $picked
    $script:settings.channel   = if ($picked -match '-alpha') { 'alpha' } else { 'latest' }
    $script:settings.skipVersion = ''
    Save-Settings $script:settings
    $script:channel = $script:settings.channel
}

# --- decide what to install -------------------------------------------------
Status 'Checking for updates...'

$settings  = Get-Settings
$channel   = $settings.channel
$installed = Get-InstalledVersion
if ($installed) { $lblVer.Text = "dsh $installed  ($channel)" }

$tags      = Get-DistTags
$tagVer    = if ($tags) { $tags.$channel } else { $null }
$alphaVer  = if ($tags) { $tags.alpha }    else { $null }
$stableVer = if ($tags) { $tags.latest }   else { $null }

$install = $null

# On the alpha channel, offer a way back every boot. Auto-dismisses to "No"
# after 3 seconds, so an unattended launch just carries on.
if ($installed -and $channel -eq 'alpha' -and $stableVer) {
    $splash.TopMost = $false
    $back = Show-AlphaReminder $installed $stableVer
    $splash.TopMost = $true

    if ($back -eq 'pick') { Invoke-VersionPicker }
}

$firstRun = -not $installed

if ($firstRun) {
    Status 'Fetching available versions...'
    $splash.TopMost = $false
    $install = Show-VersionPicker $tags $null
    $splash.TopMost = $true

    if (-not $install) { Close-Splash; Stop-Harness; exit 0 }     # user cancelled

    $settings.channel = if ($install -match '-alpha') { 'alpha' } else { 'latest' }
    Save-Settings $settings
    $channel = $settings.channel
}
elseif (-not $install) {
    # One offer at a time: a newer build on the current channel, or - when on
    # the stable channel - an alpha the user has not already ignored.
    $offered = $null
    $isAlpha = $false

    if ($tagVer -and $tagVer -ne $installed) {
        $offered = $tagVer
        $isAlpha = ($channel -eq 'alpha')
    }
    elseif ($channel -eq 'latest' -and $alphaVer -and $alphaVer -ne $installed) {
        $offered = $alphaVer
        $isAlpha = $true
    }

    if ($offered -and $offered -ne $settings.skipVersion) {
        Status 'Update available.'
        $splash.TopMost = $false
        $answer = Show-ChannelDialog $installed $channel $offered $isAlpha
        $splash.TopMost = $true

        switch ($answer) {
            'pick'   { Invoke-VersionPicker }
            'ignore' { $settings.skipVersion = $offered; Save-Settings $settings }
        }
    }
}

function Stop-OrphanHarness {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*DeepSeekHarness*" } |
        ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
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


# --- install / update -------------------------------------------------------
if ($install) {
    Status "Installing dsh $install - this takes a minute..."

    # Release file locks left by a previous session before deleting anything.
    # Native .node / .dll files stay locked while any harness is alive, which is
    # what turns a half-deleted node_modules into an install failure.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*DeepSeekHarness*" } |
        ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }

    $nm = Join-Path $runtimeDir 'node_modules'
    for ($try = 0; $try -lt 4 -and (Test-Path $nm); $try++) {
        Remove-Item $nm -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $nm) { Pump 700 }
    }
    Remove-Item (Join-Path $runtimeDir 'package-lock.json') -Force -ErrorAction SilentlyContinue

    if (Test-Path $nm) {
        Close-Splash
        Say ("Could not clear the old runtime - files are still locked:`n$nm`n`n" +
             'Close the app, sign out and back in, then relaunch.') 16
        Stop-Harness
        exit 1
    }

    if (-not (Test-Path (Join-Path $runtimeDir 'package.json'))) {
        '{ "name": "dsh-app-runtime", "private": true }' |
            Set-Content (Join-Path $runtimeDir 'package.json') -Encoding utf8
    }

    $npm = Start-Process cmd.exe -PassThru -WindowStyle Hidden `
        -ArgumentList '/c', "npm install $Package@$install --prefix `"$runtimeDir`" --no-audit --no-fund" `
        -RedirectStandardOutput (Join-Path $appDir 'npm.out.log') `
        -RedirectStandardError  (Join-Path $appDir 'npm.err.log')

    # Touching .Handle keeps the process handle open, which is what makes
    # ExitCode readable later. Without it, ExitCode is always $null.
    try { $null = $npm.Handle } catch { }

    while (-not $npm.HasExited) { Pump 250 }

    $exitCode = 'unavailable'
    try { if ($npm.ExitCode -ne $null) { $exitCode = [string]$npm.ExitCode } } catch { }

    # The manifest on disk is the real test of success; the exit code is only
    # reported for diagnosis.
    $nowVersion = Get-InstalledVersion
    $ok = [bool]$nowVersion
    if ($ok -and $install -match '^\d') { $ok = ($nowVersion -eq $install) }

    if (-not $ok) {
        Close-Splash

        $ne = if (Test-Path (Join-Path $appDir 'npm.err.log')) { Get-Content (Join-Path $appDir 'npm.err.log') -Raw } else { '' }
        $no = if (Test-Path (Join-Path $appDir 'npm.out.log')) { Get-Content (Join-Path $appDir 'npm.out.log') -Raw } else { '' }

        # npm sends warnings to stderr too, so surface the real errors separately.
        $real = ($ne -split "`r?`n" | Where-Object { $_ -match 'npm (error|ERR!)' }) -join "`r`n"
        if (-not $real) { $real = '(no npm error lines found - see full output below)' }

        $report = @"
Install of $Package@$install failed.

Exit code : $exitCode
Target    : $runtimeDir
Installed : $nowVersion

Lines beginning "npm warn deprecated" are harmless notices, not the failure.
The errors below are the real cause.

If this mentions EPERM, EBUSY or a locked .node / .dll file, a previous harness
is still running. Close the app, then run:

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { `$_.CommandLine -like '*DeepSeekHarness*' } |
    ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }
  Remove-Item "$runtimeDir" -Recurse -Force

Then relaunch.

--------------------------- npm errors ---------------------------
$real
--------------------------- full stderr --------------------------
$ne
--------------------------- full stdout --------------------------
$no
"@

        Show-Log 'DeepSeek Harness - install failed' $report
        Stop-Harness
        exit 1
    }
    $installed = Get-InstalledVersion
}
$lblVer.Text = "dsh $installed  ($channel)"

# --- restart after an install -----------------------------------------------
# dsh finishes building its plugin tree during the first served session, and
# that reload drops the open page ("connecting... disconnected"). Killing the
# process early does not help - the work simply resumes on the next boot. What
# does work is letting the first session run to completion, then starting over.
function Restart-Launcher {
    $exe = ''
    try { $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }

    if ($exe -match '(powershell|pwsh)(_ise)?\.exe$') {
        if ($PSCommandPath) {
            Start-Process powershell.exe -ArgumentList `
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', `
                '-File', "`"$PSCommandPath`""
        }
    }
    elseif ($exe) { Start-Process $exe }
}

function Show-RestartDialog($version) {
    $f = New-Object Windows.Forms.Form
    $f.Text            = 'DeepSeek Harness'
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object Drawing.Size(560, 210)
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.ControlBox      = $false        # the restart is not optional
    $f.BackColor       = [Drawing.Color]::FromArgb(32, 32, 36)
    $f.TopMost         = $true

    $f.Controls.Add((New-Label "dsh $version installed" 24 20 500 13 0xFFF4F4F5))

    $body  = "dsh finishes setting itself up during this first session, so the"
    $body += "`r`nwindow may show 'disconnected' until the app is restarted."
    $txt = New-Label $body 24 56 500 9 0xFFB4B4BB
    $txt.Size = New-Object Drawing.Size(500, 80)
    $f.Controls.Add($txt)

    $b = New-Object Windows.Forms.Button
    $b.Text      = 'Restart now'
    $b.Size      = New-Object Drawing.Size(150, 32)
    $b.Location  = New-Object Drawing.Point(386, 158)
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
# every later launch fail with EADDRINUSE. Clear ours out before binding.
Stop-OrphanHarness

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

    # Give Windows a moment to release the socket, then fall back to an
    # OS-assigned port if something outside our control still owns the pinned one.
    $usePort = $Port
    for ($i = 0; $i -lt 12 -and -not (Test-PortFree $Port); $i++) { Pump 250 }
    if (-not (Test-PortFree $Port)) { $usePort = 0 }   # 0 = let the OS pick

    # --no-open stops dsh opening the default browser; we supply the window.
    $harness = Start-Process -FilePath 'node.exe' -PassThru -WindowStyle Hidden `
        -WorkingDirectory $env:USERPROFILE `
        -ArgumentList "`"$dshBin`"", 'web', '--host', '127.0.0.1', '--port', $usePort, '--no-open' `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog

    try { $null = $harness.Handle } catch { }

    # dsh prints its URL once the plugin tree has settled.
    $deadline = (Get-Date).AddSeconds($bootSeconds)
    while (-not $url -and (Get-Date) -lt $deadline) {
        Pump 400
        $text = ''
        foreach ($f in @($outLog, $errLog)) {
            if (Test-Path $f) { $text += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
        }
        $m = [regex]::Match($text, 'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"''\)\]]*')
        if ($m.Success) { $url = $m.Value.TrimEnd('.', ',') }
        if ($harness.HasExited -and -not $url) { break }
    }

    if (-not $url -and $harness -and -not $harness.HasExited) {
        taskkill /PID $harness.Id /T /F 2>$null | Out-Null
    }
}

function Stop-Harness {
    if ($harness -and -not $harness.HasExited) {
        taskkill /PID $harness.Id /T /F 2>$null | Out-Null
    }
    Stop-OrphanHarness   # catch any child that outlived its parent
}

# Runs even if the console is closed or the script is interrupted, so a harness
# is never left holding the port.
# (Replaced with try/finally below; this is kept as fallback but should not be needed)
Register-EngineEvent PowerShell.Exiting -Action { Stop-Harness } | Out-Null

# Called once the window is up, only on a launch that installed something.
function Invoke-PostInstallRestart($browserProc) {
    Show-RestartDialog $installed

    # Our exit handler kills every harness matching this app, which would take
    # out the harness the replacement process is about to start. Drop it, and
    # stop only the process we own.
    Get-EventSubscriber -ErrorAction SilentlyContinue |
        Where-Object { $_.SourceIdentifier -eq 'PowerShell.Exiting' } |
        Unregister-Event -ErrorAction SilentlyContinue

    if ($browserProc -and -not $browserProc.HasExited) {
        taskkill /PID $browserProc.Id /T /F 2>$null | Out-Null
    }

    # Edge can hand the window to a sibling process, so close anything running
    # against our dedicated profile rather than trusting the PID we started.
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" } |
        ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
    Pump 800

    if ($harness -and -not $harness.HasExited) {
        taskkill /PID $harness.Id /T /F 2>$null | Out-Null
    }
    try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch { }
    Restart-Launcher
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

Version : $installed  ($channel)
Entry   : $dshBin
Command : node "$dshBin" web --host 127.0.0.1 --port $usePort --no-open
Exit    : $code
Profile : $webProfile  ($pkgCount plugins)
$hint

To reproduce in a visible console, paste the Command line above into PowerShell.
If this started after switching channels, edit settings.json in this folder and
set "channel" back to "latest", then relaunch and accept the update.

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
        if ($restartAfterOpen) { Invoke-PostInstallRestart $null }
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
            if ($restartAfterOpen) { Invoke-PostInstallRestart $null }
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
            if ($restartAfterOpen) { Invoke-PostInstallRestart $e }
            $e.WaitForExit()
        }
    }

    default {
        Start-Process $url; Pump 2500; Close-Splash
        if ($restartAfterOpen) { Invoke-PostInstallRestart $null }
        $harness.WaitForExit()
    }
}

Close-Splash
Stop-Harness
$mutex.ReleaseMutex()