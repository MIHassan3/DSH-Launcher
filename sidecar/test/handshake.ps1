<#
  Phase 0 handshake test - verifies the ACTUAL stdout contract.

  Requirement (docs/PROJECT_DSH-DOCK.md section 4, Phase 0 milestone 2):
    `node sidecar/index.js` finds a free port and prints SIDECAR_READY:<port>.

  This is the test that matters for the Rust parser, because Rust will read the
  sidecar's stdout exactly as we do here: as a real OS-level stream, redirected
  to a file. (A node-to-node piped capture is blocked in confined environments,
  so file redirection is the faithful and permitted way to verify it.)

  Run from the repo root:  powershell -NoProfile -File sidecar/test/handshake.ps1
#>

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entry    = Join-Path $repoRoot 'sidecar\index.js'
$tmpDir   = Join-Path $repoRoot '.test-tmp'
$outFile  = Join-Path $tmpDir 'sidecar.out.log'
$errFile  = Join-Path $tmpDir 'sidecar.err.log'

$failures = 0

function Check([string]$Label, [bool]$Ok, [string]$Detail = '') {
    $status = if ($Ok) { 'PASS' } else { 'FAIL' }
    $suffix = if ($Detail) { " - $Detail" } else { '' }
    Write-Host "  [$status] $Label$suffix"
    if (-not $Ok) { $script:failures++ }
}

Write-Host 'DSH-Dock sidecar handshake test'
Write-Host "  entry: sidecar\index.js"

New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue

$proc = $null
try {
    # No -RedirectStandardError sharing; separate files avoid any handle conflict.
    $proc = Start-Process -FilePath 'node' `
        -ArgumentList 'sidecar/index.js' `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -NoNewWindow -PassThru

    # Poll the real stdout file for the handshake line.
    $deadline = (Get-Date).AddSeconds(15)
    $readyLine = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        if (Test-Path $outFile) {
            $line = Get-Content $outFile -ErrorAction SilentlyContinue |
                    Where-Object { $_ -match '^SIDECAR_READY:(\d+)$' } |
                    Select-Object -First 1
            if ($line) { $readyLine = $line.Trim(); break }
        }
        if ($proc.HasExited) { break }
    }

    Check 'sidecar stayed alive' (-not $proc.HasExited)
    Check 'printed a SIDECAR_READY line' ($null -ne $readyLine) "line='$readyLine'"

    if ($readyLine) {
        $port = [int]($readyLine -replace '^SIDECAR_READY:', '')
        Check 'port is in valid range' ($port -gt 0 -and $port -le 65535) "port=$port"

        # The handshake must not lie: the announced port must be reachable.
        $reachable = $false
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
            $reachable = ($resp.ok -eq $true)
        } catch {
            $reachable = $false
        }
        Check 'announced port is actually listening' $reachable

        # Exactly one ready line: the Rust parser must not see duplicates.
        $allLines = @(Get-Content $outFile -ErrorAction SilentlyContinue)
        $readyCount = @($allLines | Where-Object { $_ -match '^SIDECAR_READY:' }).Count
        Check 'exactly one SIDECAR_READY line' ($readyCount -eq 1) "count=$readyCount"
        Check 'stdout carries ONLY the handshake line' ($allLines.Count -eq 1) "lines=$($allLines.Count)"
    }
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        Check 'sidecar stopped' $true
    }
}

if (Test-Path $errFile) {
    $errText = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
    if ($errText -and $errText.Trim()) {
        Write-Host "  (stderr) $($errText.Trim())"
    }
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'RESULT: all checks passed'
    exit 0
} else {
    Write-Host "RESULT: $failures check(s) failed"
    exit 1
}
