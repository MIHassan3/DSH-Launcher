<#
  Phase 0 window verification.

  Confirms that `cargo tauri dev` actually opened a NATIVE, VISIBLE top-level
  window titled "DSH-Dock" - not merely that a process exists. Enumerates
  top-level windows via the Win32 API and reports titles plus visibility.

  This exists because "the process is running" is not evidence that the window
  rendered; a crashed webview or a misconfigured frontendDist can leave a
  process alive with no usable window.

  Usage:  powershell -NoProfile -File src-tauri/test/window-check.ps1
  Exits 0 if a visible DSH-Dock window is found, 1 otherwise.
#>

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinEnum {
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

$windows = [WinEnum]::List()
$match = $windows | Where-Object { $_.Title -like '*DSH-Dock*' }

Write-Host 'DSH-Dock window check'
Write-Host "  top-level titled windows found: $($windows.Count)"

if (-not $match) {
    Write-Host '  [FAIL] no window titled DSH-Dock'
    Write-Host '  (other visible windows, first 10):'
    $windows | Where-Object { $_.Visible } | Select-Object -First 10 | ForEach-Object {
        Write-Host "    - $($_.Title)"
    }
    exit 1
}

foreach ($w in $match) {
    $procName = 'unknown'
    try {
        $procName = (Get-Process -Id $w.Pid -ErrorAction Stop).ProcessName
    } catch { }

    Write-Host "  [INFO] title='$($w.Title)' visible=$($w.Visible) pid=$($w.Pid) process=$procName"
}

$visible = $match | Where-Object { $_.Visible }
if ($visible) {
    Write-Host "  [PASS] visible DSH-Dock window is open ($($visible.Count) match(es))"
    exit 0
} else {
    Write-Host '  [FAIL] DSH-Dock window exists but is not visible'
    exit 1
}
