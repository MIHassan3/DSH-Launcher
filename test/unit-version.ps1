# unit-version.ps1
# Exercises Compare-DshVersion from ..\Windows\dsh-app.ps1 in isolation so the
# semver logic can be tested without launching the app.
# Run:  pwsh -File .\test\unit-version.ps1   (or powershell -File ...)

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot '..\Windows\dsh-app.ps1'
if (-not (Test-Path $src)) { throw "Cannot find $src" }

$text = Get-Content $src -Raw
$m = [regex]::Match($text, '(?s)# ==== version helpers =+.*?# ==== end version helpers =+')
if (-not $m.Success) { throw 'Version helper block not found in dsh-app.ps1' }
Invoke-Expression $m.Value

$script:fails = 0
$script:count = 0

function Check($a, $b, $want) {
    $script:count++
    $got = Compare-DshVersion $a $b
    if ($got -eq $want) {
        Write-Host ("ok:   {0,-18} vs {1,-18} = {2}" -f $a, $b, $got)
    } else {
        Write-Host ("FAIL: {0,-18} vs {1,-18} = {2}  (want {3})" -f $a, $b, $got, $want) -ForegroundColor Red
        $script:fails++
    }
}

# --- same / simple numeric ordering ----------------------------------------
Check '0.1.2-rc.1' '0.1.2-rc.1'  0
Check '0.1.2'      '0.1.2'       0
Check '0.1.2'      '0.1.3'      -1
Check '0.1.3'      '0.1.2'       1
Check '1.0.0'      '0.9.9'       1

# --- prerelease sorts below its release ------------------------------------
Check '0.1.2'       '0.1.2-rc.1'  1
Check '0.1.2-rc.1'  '0.1.2'      -1
Check '1.0.0-alpha' '1.0.0'      -1
Check '1.0.0-alpha' '1.0.0-beta' -1
Check '1.0.0-beta'  '1.0.0-alpha' 1

# --- the real-world case: alpha line is AHEAD of the rc/release line -------
Check '0.1.5-alpha.1' '0.1.2-rc.1'  1
Check '0.1.2-rc.1'    '0.1.5-alpha.1' -1
Check '0.1.3-alpha.2' '0.1.2-rc.1'  1

# --- prerelease numeric identifiers compare numerically --------------------
Check '0.1.2-rc.2'  '0.1.2-rc.1'   1
Check '0.1.2-rc.1'  '0.1.2-rc.2'  -1
Check '0.1.2-rc.1'  '0.1.2-rc.10' -1
Check '0.1.2-rc.10' '0.1.2-rc.2'   1
Check '0.1.2-alpha.2' '0.1.2-alpha.1' 1

# --- build metadata does not affect ordering -------------------------------
Check '0.1.2-rc.2+build5' '0.1.2-rc.2' 0

Write-Host ''
if ($script:fails -gt 0) {
    Write-Host ("FAILED: {0} of {1} checks" -f $script:fails, $script:count) -ForegroundColor Red
    exit 1
}
Write-Host ("ALL PASS ({0} checks)" -f $script:count) -ForegroundColor Green
exit 0
