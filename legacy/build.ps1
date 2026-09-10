# build.ps1 - turns dsh-app.ps1 into DSH-Launcher-Setup.exe
#
# Needs, one time:
#   Install-Module ps2exe -Scope CurrentUser
#   winget install JRSoftware.InnoSetup
#
# Folder layout expected:
#   build.ps1
#   dsh-app.ps1
#   installer.iss
#   icon.ico

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

foreach ($f in 'dsh-app.ps1', 'installer.iss', 'icon.ico') {
    if (-not (Test-Path $f)) { throw "Missing required file: $f" }
}

New-Item -ItemType Directory -Force -Path build, dist | Out-Null

# --- 1. script -> windowless exe with your icon ----------------------------
Write-Host 'Compiling launcher...' -ForegroundColor Cyan
Import-Module ps2exe
Invoke-PS2EXE -InputFile  .\dsh-app.ps1 `
              -OutputFile .\build\DSHLauncher.exe `
              -iconFile   .\icon.ico `
              -noConsole -noOutput -noError `
              -title   'DSH Launcher' `
              -product 'DSH Launcher' `
              -company 'Mohamed' `
              -version '0.1.2.0'

# --- 2. exe -> installer ---------------------------------------------------
Write-Host 'Building installer...' -ForegroundColor Cyan

function Find-Iscc {
    # On PATH?
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Registry: Inno Setup records its install location under its uninstall key.
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup*_is1'
    )
    foreach ($k in $keys) {
        foreach ($item in (Get-ItemProperty $k -ErrorAction SilentlyContinue)) {
            $loc = $item.InstallLocation
            if ($loc) {
                $p = Join-Path $loc 'ISCC.exe'
                if (Test-Path $p) { return $p }
            }
        }
    }

    # Known install roots, including per-user installs from winget.
    $roots = @(
        "$env:ProgramFiles",
        "${env:ProgramFiles(x86)}",
        "$env:LOCALAPPDATA\Programs"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($r in $roots) {
        $hit = Get-ChildItem $r -Filter ISCC.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    $null
}

$iscc = Find-Iscc
if (-not $iscc) {
    throw @'
ISCC.exe (the Inno Setup compiler) was not found.

Install it with:  winget install JRSoftware.InnoSetup
If it is already installed, locate the compiler with:

  Get-ChildItem "$env:ProgramFiles","${env:ProgramFiles(x86)}","$env:LOCALAPPDATA\Programs" `
    -Filter ISCC.exe -Recurse -ErrorAction SilentlyContinue | Select FullName

then set $iscc in build.ps1 to that full path.
'@
}
Write-Host "Using $iscc" -ForegroundColor DarkGray

& $iscc .\installer.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)" }

# --- 3. raw launcher exe (second release asset) -----------------------------
# Published next to the Setup so the launcher can update itself in place.
Copy-Item .\build\DSHLauncher.exe .\dist\DSHLauncher.exe -Force

Write-Host "`nDone:"
Write-Host "  $(Resolve-Path .\dist\DSH-Launcher-Setup.exe)"
Write-Host "  $(Resolve-Path .\dist\DSHLauncher.exe)"
Write-Host 'Attach both files to the GitHub release - the Setup for installing, the raw exe for self-updates.'
