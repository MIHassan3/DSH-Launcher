#Requires -Version 5.1
<#
  DSH-Dock packaging regression gate.

  Run this AFTER `cargo tauri build` and BEFORE publishing a release. It is not
  part of `cargo tauri build`; it is a manual gate over the artifact that build
  just produced. Exit code 0 means the artifact is shippable, 1 means at least
  one assertion failed.

  Usage:
    powershell -NoProfile -File src-tauri/test/packaging-check.ps1
    powershell -NoProfile -File src-tauri/test/packaging-check.ps1 -TargetDir <dir>
    powershell -NoProfile -File src-tauri/test/packaging-check.ps1 -UseProbeInstaller

  Assertions:
    1. package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json and the
       built installer filename all agree on one version string.
    2. src-tauri/target/release/bundle/nsis/DSH-Dock_<version>_x64-setup.exe
       exists and is not empty.
    3. The installer payload contains the sidecar (sidecar\index.js and
       sidecar\lib\control.js) plus dsh-dock.exe and uninstall.exe at the root.
    4. The payload has no resources\sidecar\ - the sidecar must be exe-adjacent.
    5. The payload has no sidecar\test\.
    6. The default install path is $LOCALAPPDATA\Programs\DSH-Dock, and no
       executable `Call RestorePreviousInstallLocation` remains.
    7. Everything this script created has been removed again.

  SAFETY
    * Nothing is ever installed to a real location. Every install uses
      /S /NS /D=<throwaway TEMP directory>.
    * The live data directory %LOCALAPPDATA%\DSH-Dock is never read, written
      or listed. Remove-SafeDir refuses any path outside %TEMP%.
    * The stock NSIS installer terminates a running dsh-dock.exe in silent mode
      (nsis_tauri_utils::CheckIfAppIsRunning matches the image base name via
      Toolhelp32). This script therefore REFUSES to run any installer while
      dsh-dock.exe is running, unless -UseProbeInstaller is passed, in which
      case it compiles its own probe from the build's preprocessed
      installer.nsi with only that macro neutralized. The payload is identical
      because it comes from the same preprocessed script.
    * Registry keys that the test install writes are snapshotted first and
      restored afterwards, so a packaging run leaves no trace.

  REUSING THE HELPERS
    Dot-source this file to get the helper functions without running the checks:

      . .\src-tauri\test\packaging-check.ps1

    Helpers: Test-Assertion, Remove-SafeDir, Invoke-SilentInstall,
    New-ProbeInstaller, Get-RegSnapshot, Restore-RegSnapshot, Get-JsonVersion,
    Get-CargoPackageVersion, Get-VersionFromInstallerName.
#>

[CmdletBinding()]
param(
  [string]$TargetDir,
  [switch]$UseProbeInstaller
)

# ===========================================================================
# Helpers
# ===========================================================================

function Get-JsonVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  return $json.version
}

function Get-CargoPackageVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $inPackageSection = $false
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[(.+)\]$') {
      $inPackageSection = ($Matches[1] -eq 'package')
      continue
    }
    if ($inPackageSection -and ($trimmed -match '^version\s*=\s*"([^"]+)"')) {
      return $Matches[1]
    }
  }
  return $null
}

function Get-VersionFromInstallerName {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ($Name -match '^DSH-Dock_(.+)_x64-setup\.exe$') { return $Matches[1] }
  return $null
}

function Remove-SafeDir {
  # Recursive delete that structurally cannot escape %TEMP%.
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path)
  $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
  if (-not $full.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Remove-SafeDir refused a path outside TEMP: $full"
  }
  if (Test-Path -LiteralPath $full) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-SilentInstall {
  # Returns the installer's exit code. /D= must be last and must not be quoted,
  # so a path containing spaces cannot be used.
  param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$InstallDir
  )
  if ($InstallDir -match '\s') {
    throw "NSIS /D= cannot be used with a path containing spaces: $InstallDir"
  }
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S', '/NS', ("/D=" + $InstallDir) -Wait -PassThru
  return $proc.ExitCode
}

function New-ProbeInstaller {
  # Compiles a throwaway installer from the build's preprocessed installer.nsi
  # with the "close the running app" macro neutralized. Payload is unchanged.
  param(
    [Parameter(Mandatory = $true)][string]$RenderDir,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string]$OutExe
  )
  $renderScript = Join-Path $RenderDir 'installer.nsi'
  if (-not (Test-Path -LiteralPath $renderScript)) {
    throw "cannot build a probe: preprocessed script not found at $renderScript"
  }
  $makensis = Join-Path (Join-Path $env:LOCALAPPDATA 'tauri') 'NSIS\makensis.exe'
  if (-not (Test-Path -LiteralPath $makensis)) {
    throw "cannot build a probe: makensis not found at $makensis"
  }

  $probeDir = Join-Path $WorkDir 'probe'
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
  Copy-Item -Path (Join-Path $RenderDir '*') -Destination $probeDir -Recurse -Force

  $nsiPath = Join-Path $probeDir 'installer.nsi'
  $text = [System.IO.File]::ReadAllText($nsiPath)

  $macro = '  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"'
  if (([regex]::Matches($text, [regex]::Escape($macro))).Count -lt 1) {
    throw "cannot build a probe: process-check macro not found in $nsiPath"
  }
  $text = $text.Replace($macro, '  ; packaging-check probe: process check neutralized')

  # Redirect the output so the real bundle directory is not touched.
  $text = [regex]::Replace($text, '(?m)^\s*!define OUTFILE\s+".*"\s*$', ('!define OUTFILE "' + $OutExe + '"'))

  [System.IO.File]::WriteAllText($nsiPath, $text, (New-Object System.Text.UTF8Encoding($false)))

  $savedNsisDir = $env:NSISDIR
  $savedConfDir = $env:NSISCONFDIR
  $code = -1
  try {
    Remove-Item Env:\NSISDIR -ErrorAction SilentlyContinue
    Remove-Item Env:\NSISCONFDIR -ErrorAction SilentlyContinue
    Push-Location $probeDir
    try {
      & $makensis -INPUTCHARSET UTF8 -OUTPUTCHARSET UTF8 -V2 $nsiPath | Out-Null
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } finally {
    if ($null -ne $savedNsisDir) { $env:NSISDIR = $savedNsisDir }
    if ($null -ne $savedConfDir) { $env:NSISCONFDIR = $savedConfDir }
  }
  if ($code -ne 0) { throw "probe makensis compile failed with exit code $code" }
  if (-not (Test-Path -LiteralPath $OutExe)) { throw "probe installer was not produced: $OutExe" }
  return $OutExe
}

function Get-RegSnapshot {
  # Captures a registry key's values so a test install can be undone exactly.
  param([Parameter(Mandatory = $true)][string]$SubKey)
  $snap = @{ Exists = $false; Values = @{}; Kinds = @{} }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
  if ($null -ne $key) {
    $snap.Exists = $true
    foreach ($name in $key.GetValueNames()) {
      $snap.Values[$name] = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $snap.Kinds[$name] = $key.GetValueKind($name)
    }
    $key.Close()
  }
  return $snap
}

function Restore-RegSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$SubKey,
    [Parameter(Mandatory = $true)]$Snapshot
  )
  if (-not $Snapshot.Exists) {
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKey, $false) } catch { }
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  if ($null -eq $key) { return }
  foreach ($name in @($key.GetValueNames())) {
    if (-not $Snapshot.Values.ContainsKey($name)) { $key.DeleteValue($name, $false) }
  }
  foreach ($name in @($Snapshot.Values.Keys)) {
    $key.SetValue($name, $Snapshot.Values[$name], $Snapshot.Kinds[$name])
  }
  $key.Close()
}

$script:CheckNumber = 0
$script:Failures = 0

function Test-Assertion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual
  )
  $script:CheckNumber = $script:CheckNumber + 1
  if ($Condition) {
    Write-Host ("[PASS] {0}. {1}" -f $script:CheckNumber, $Name) -ForegroundColor Green
  } else {
    $script:Failures = $script:Failures + 1
    Write-Host ("[FAIL] {0}. {1}" -f $script:CheckNumber, $Name) -ForegroundColor Red
    Write-Host ("         expected: {0}" -f $Expected) -ForegroundColor Red
    Write-Host ("         actual  : {0}" -f $Actual) -ForegroundColor Red
  }
}

# ===========================================================================
# Main. Skipped when the file is dot-sourced so the helpers stay reusable.
# ===========================================================================

if ($MyInvocation.InvocationName -eq '.') { return }

$tauriDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $tauriDir

if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $TargetDir = $env:CARGO_TARGET_DIR
  } else {
    $TargetDir = Join-Path $tauriDir 'target'
  }
}
$TargetDir = [System.IO.Path]::GetFullPath($TargetDir)

$packageJson  = Join-Path $repoRoot 'package.json'
$cargoToml    = Join-Path $tauriDir 'Cargo.toml'
$tauriConf    = Join-Path $tauriDir 'tauri.conf.json'
$bundleDir    = Join-Path $TargetDir 'release\bundle\nsis'
$renderDir    = Join-Path $TargetDir 'release\nsis\x64'
$renderScript = Join-Path $renderDir 'installer.nsi'
$workDir      = Join-Path $env:TEMP 'dsh-dock-packaging-check'
$extractDir   = Join-Path $workDir 'extract'
$probeExe     = Join-Path $workDir 'probe-setup.exe'

$manuParentSubKey = 'Software\dshdock'
$manuSubKey   = 'Software\dshdock\DSH-Dock'
$uninstSubKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH-Dock'

Write-Host ''
Write-Host 'DSH-Dock packaging check'
Write-Host ("  repo root   : {0}" -f $repoRoot)
Write-Host ("  target dir  : {0}" -f $TargetDir)
Write-Host ("  work dir    : {0}" -f $workDir)
Write-Host ''

$snapManufacturer = $null
$snapUninstall = $null
$snapParentExisted = $null
$artifact = $null
$artifactOk = $false

try {
  # --- 1. version consistency -------------------------------------------
  $vPackage = Get-JsonVersion -Path $packageJson
  $vCargo = Get-CargoPackageVersion -Path $cargoToml
  $vConf = Get-JsonVersion -Path $tauriConf

  $newest = $null
  if (Test-Path -LiteralPath $bundleDir) {
    $newest = Get-ChildItem -LiteralPath $bundleDir -Filter 'DSH-Dock_*_x64-setup.exe' -File -ErrorAction SilentlyContinue |
      Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1
  }
  $vInstaller = $null
  if ($null -ne $newest) { $vInstaller = Get-VersionFromInstallerName -Name $newest.Name }

  $distinct = @(@($vPackage, $vCargo, $vConf, $vInstaller) | Sort-Object -Unique)
  $versionsAgree = ($distinct.Count -eq 1) -and (-not [string]::IsNullOrWhiteSpace([string]$distinct[0]))
  Test-Assertion -Name 'version consistency (package.json, Cargo.toml, tauri.conf.json, installer filename)' `
    -Condition $versionsAgree `
    -Expected 'one non-empty version string shared by all four sources' `
    -Actual ("package.json={0}; Cargo.toml={1}; tauri.conf.json={2}; installer={3}" -f $vPackage, $vCargo, $vConf, $vInstaller)

  $version = [string]$vConf

  # --- 2. installer exists and is non-empty -----------------------------
  if (-not [string]::IsNullOrWhiteSpace($version)) {
    $artifact = Join-Path $bundleDir ("DSH-Dock_{0}_x64-setup.exe" -f $version)
  }
  $artifactSize = 0
  if (($null -ne $artifact) -and (Test-Path -LiteralPath $artifact)) {
    $artifactSize = (Get-Item -LiteralPath $artifact).Length
  }
  $artifactOk = (($null -ne $artifact) -and ($artifactSize -gt 0))
  Test-Assertion -Name 'installer exists and is not empty' `
    -Condition $artifactOk `
    -Expected ("existing non-empty file: {0}" -f $artifact) `
    -Actual ("exists={0}; size={1}" -f (($null -ne $artifact) -and (Test-Path -LiteralPath $artifact)), $artifactSize)

  if (-not $artifactOk) {
    Write-Host '  cannot continue without the installer artifact; skipping payload checks.' -ForegroundColor Yellow
  } else {
    Write-Host ("  artifact    : {0}" -f $artifact)
    Write-Host ("  size        : {0} bytes" -f $artifactSize)
    Write-Host ("  sha256      : {0}" -f (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash)

    # --- pick the extraction route --------------------------------------
    $runningApp = @(Get-Process -Name 'dsh-dock' -ErrorAction SilentlyContinue)
    $installerToRun = $artifact
    if ($runningApp.Count -gt 0) {
      if (-not $UseProbeInstaller) {
        $pids = ($runningApp | ForEach-Object { $_.Id }) -join ', '
        throw ("dsh-dock.exe is running (PID {0}). The NSIS installer terminates any running dsh-dock.exe in silent mode, so this script will not run one. Close DSH-Dock and re-run, or re-run with -UseProbeInstaller to extract through a process-check-neutralized probe compile (payload identical)." -f $pids)
      }
      Write-Host '  dsh-dock.exe is running: extracting via a neutralized probe compile.' -ForegroundColor Yellow
      $installerToRun = New-ProbeInstaller -RenderDir $renderDir -WorkDir $workDir -OutExe $probeExe
    }
    Write-Host ("  extracting  : {0}" -f $installerToRun)

    $snapManufacturer = Get-RegSnapshot -SubKey $manuSubKey
    $snapUninstall = Get-RegSnapshot -SubKey $uninstSubKey
    $snapParentExisted = ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($manuParentSubKey, $false))
    $installExit = Invoke-SilentInstall -InstallerPath $installerToRun -InstallDir $extractDir
    Write-Host ("  installer exit code: {0}" -f $installExit)

    # --- 3. payload contains the sidecar ---------------------------------
    $required = @('dsh-dock.exe', 'uninstall.exe', 'sidecar\index.js', 'sidecar\lib\control.js')
    $missing = @()
    foreach ($relative in $required) {
      if (-not (Test-Path -LiteralPath (Join-Path $extractDir $relative))) { $missing = $missing + $relative }
    }
    $payloadOk = ($installExit -eq 0) -and ($missing.Count -eq 0)
    Test-Assertion -Name 'payload contains dsh-dock.exe, uninstall.exe and the sidecar' `
      -Condition $payloadOk `
      -Expected ("installer exit code 0 and all of: {0}" -f ($required -join ', ')) `
      -Actual ("exit code {0}; missing: {1}" -f $installExit, (($missing -join ', ') -replace '^$', '(none)'))

    # --- 4. no resources\sidecar\ ----------------------------------------
    $nestedSidecar = Test-Path -LiteralPath (Join-Path $extractDir 'resources\sidecar')
    Test-Assertion -Name 'payload has no resources\sidecar\ (sidecar must be exe-adjacent)' `
      -Condition (-not $nestedSidecar) `
      -Expected 'absent: resources\sidecar\' `
      -Actual ("present={0}" -f $nestedSidecar)

    # --- 5. no test files in the payload ---------------------------------
    $sidecarTests = Test-Path -LiteralPath (Join-Path $extractDir 'sidecar\test')
    Test-Assertion -Name 'payload has no sidecar\test\' `
      -Condition (-not $sidecarTests) `
      -Expected 'absent: sidecar\test\' `
      -Actual ("present={0}" -f $sidecarTests)
  }

  # --- 6. default install path and the disabled restore call ------------
  $renderExists = Test-Path -LiteralPath $renderScript
  $renderText = ''
  if ($renderExists) { $renderText = [System.IO.File]::ReadAllText($renderScript) }
  $hasProgramsPath = $renderText.Contains('StrCpy $INSTDIR "$LOCALAPPDATA\Programs\')
  $hasCustomHeader = $renderText.Contains('DSH-Dock custom NSIS installer template')
  $execRestoreCalls = @(Select-String -LiteralPath $renderScript -Pattern '^\s*Call\s+RestorePreviousInstallLocation' -ErrorAction SilentlyContinue)
  $noExecRestoreCall = ($execRestoreCalls.Count -eq 0)
  $defaultPathOk = $renderExists -and $hasProgramsPath -and $noExecRestoreCall

  $detail = "render exists={0}; Programs\ default={1}; executable restore calls={2}" -f $renderExists, $hasProgramsPath, $execRestoreCalls.Count
  if ($renderExists -and (-not $hasCustomHeader)) {
    $detail = $detail + '; NOTE: this preprocessed script does not come from the custom template - it is stale output (rebuild, or pass -TargetDir for the tree you built into)'
  }
  Test-Assertion -Name 'default install path is $LOCALAPPDATA\Programs\DSH-Dock and the restore call is disabled' `
    -Condition $defaultPathOk `
    -Expected ("in {0}: the Programs\ default and zero executable restore calls" -f $renderScript) `
    -Actual $detail
} catch {
  $script:Failures = $script:Failures + 1
  Write-Host ("[FAIL] fatal: {0}" -f $_.Exception.Message) -ForegroundColor Red
} finally {
  if ($null -ne $snapManufacturer) { Restore-RegSnapshot -SubKey $manuSubKey -Snapshot $snapManufacturer }
  if ($null -ne $snapUninstall) { Restore-RegSnapshot -SubKey $uninstSubKey -Snapshot $snapUninstall }
  if (($null -ne $snapParentExisted) -and (-not $snapParentExisted)) {
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($manuParentSubKey, $false) } catch { }
  }
  Remove-SafeDir -Path $workDir
}

# --- 7. cleanup ---------------------------------------------------------
$workDirGone = -not (Test-Path -LiteralPath $workDir)
$manuBackToStart = $true
$uninstBackToStart = $true
$parentBackToStart = $true
if ($null -ne $snapManufacturer) {
  $nowManu = Get-RegSnapshot -SubKey $manuSubKey
  $manuBackToStart = ($nowManu.Exists -eq $snapManufacturer.Exists)
}
if ($null -ne $snapUninstall) {
  $nowUninst = Get-RegSnapshot -SubKey $uninstSubKey
  $uninstBackToStart = ($nowUninst.Exists -eq $snapUninstall.Exists)
}
if ($null -ne $snapParentExisted) {
  $parentNow = ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($manuParentSubKey, $false))
  $parentBackToStart = ($parentNow -eq $snapParentExisted)
}
Test-Assertion -Name 'cleanup (throwaway TEMP directory removed, registry back to its starting state)' `
  -Condition ($workDirGone -and $manuBackToStart -and $uninstBackToStart -and $parentBackToStart) `
  -Expected ("absent: {0}; registry keys as they were before the run" -f $workDir) `
  -Actual ("work dir gone={0}; manufacturer key restored={1}; uninstall key restored={2}; manufacturer parent restored={3}" -f $workDirGone, $manuBackToStart, $uninstBackToStart, $parentBackToStart)

Write-Host ''
if ($script:Failures -gt 0) {
  Write-Host ("PACKAGING CHECK FAILED: {0} of {1} checks failed." -f $script:Failures, $script:CheckNumber) -ForegroundColor Red
  exit 1
}
Write-Host ("PACKAGING CHECK PASSED: {0} of {0} checks passed." -f $script:CheckNumber) -ForegroundColor Green
exit 0
