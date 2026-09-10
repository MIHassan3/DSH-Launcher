# DSH Launcher

**A simple launcher for the DeepSeek Harness that keeps it always updated and opens it as a desktop app.**

![Version](https://img.shields.io/badge/version-0.1.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## What is this?

The [DeepSeek Harness](https://deepseek.com/harness/en/) is a powerful command-line tool for interacting with DeepSeek models. However, running it typically requires opening a terminal, remembering npm commands, and using a browser tab. This launcher simplifies everything:

- **One-click start** - launches the harness and opens it in a clean, app-like Edge window (no browser chrome).
- **Automatic updates** - checks for new versions on startup and installs newer builds of your channel silently, keeping you current without any clicks.
- **Always in control** - the startup window shows one button to switch between the alpha and release channels whenever you want.
- **Runs in the background** - no console window stays open; the harness runs silently.
- **Tray + background mode** - closing the window keeps your harness and sessions running; a tray icon reopens it, stops it, checks for updates, or exits.
- **Simple installer** - a single `.exe` that installs the launcher and optionally Node.js if missing.
- **Safe updates** - a new build is installed into a staging folder and swapped in only when it verifies, so a failed or interrupted update never breaks the installed version.

## Requirements

- **Windows 10 or Windows 11** (64-bit)
- **Node.js** (v18 or later) - installed automatically by the launcher on first run if it is missing
- **Microsoft Edge** - already present on all modern Windows systems
- Internet connection (for first-time installation and updates)

## Installation

1. Download the latest `DSH-Launcher-Setup.exe` from the [Releases](https://github.com/MIHassan3/DSH-Launcher/releases) page.
2. Run the installer. It will:
   - Install the launcher to your user folder (no admin rights needed).
   - Tell you if Node.js is missing - the launcher installs it for you on first start.
3. After installation, launch **DSH Launcher** from the Start Menu or desktop shortcut.
4. On first run, you choose a channel - the latest release or the latest alpha. The harness is then installed and opened in an Edge app window.

## Usage

- **Starting the app**: Simply run "DSH Launcher" from the Start Menu or desktop. It checks versions, keeps your installed channel up to date automatically, and opens the harness in its own Edge app window.
- **First run**: choose **Install release (...)** or **Install alpha (...)** - only the two current builds are offered, because the launcher keeps your installed build on the latest of its channel automatically.
- **Keeping current**: whichever channel you are on (release or alpha), a newer build of that same channel installs itself silently in the background - the splash announces "updating automatically". No dialogs interrupt a normal start.
- **Checking for updates**: the startup window does everything in one place - while it checks versions it shows both channels and, when relevant, a single button. It needs no clicks when everything is fine (it carries on after a few seconds; Enter or Esc do the same). The button is the contextual one:
  - **Try alpha (...)** when you are on the release channel - switches you to alpha and installs its latest build (a confirmation warns about the download time).
  - **Go stable (...)** when you are on the alpha channel - same, back to the release line.
- **Channels**: "release" follows the `latest` tag (today these are release candidates such as `0.1.2-rc.1`); "alpha" follows the faster-moving `alpha` tag (e.g. `0.1.5-alpha.1`, often ahead of the release line). Which line you are on is decided by the installed build; switching is one click on the startup window.
- **After an install** the app shows a **"Restart required"** message once the window is up. Click **Close**, then start DSH Launcher again from the Start Menu - the second start connects cleanly.
- **Staying in the background**: closing the DeepSeek Harness window keeps it (and your sessions) running - the tray icon stays. Right-click it for *Open DeepSeek Harness*, *Stop the harness*, *Check for updates now*, or *Exit DSH Launcher*. Double-click reopens the window.
- **Launcher updates**: while running, the launcher quietly checks for a newer launcher (once a day) and downloads + verifies it in the background. A gentle message offers it: **OK** applies it on your next start (no reinstall), **Cancel** keeps the current version and reminds you again later. Nothing interrupts what you are doing.
- **Settings**: stored in `%LOCALAPPDATA%\DeepSeekHarness\settings.json`:
  - `"autoUpdate": true|false` - install newer builds of your own channel silently (default `true`). Turn it off to be asked before every update.
  - `"launcherUpdatePending"`, `"launcherLastCheck"`, `"launcherRemindAfter"`, `"dshNotifiedTag"` - bookkeeping for the launcher update flow (safe to leave alone).

## Troubleshooting
- **"Node.js was not found ..."** (or a failed install saying npm is not recognized)
  The launcher finds Node.js by file path (`C:\Program Files\nodejs`, per-user `nodejs` folders, and the PATH stored in the registry), so a freshly installed Node works immediately - no sign-out or PATH refresh is needed. If the automatic install fails, install the LTS build from nodejs.org and relaunch.
- **"The harness did not report a URL"**
  This usually means the first-run profile build failed. Close the app and relaunch - it often succeeds on the second attempt. If it persists, check the logs in `%LOCALAPPDATA%\DeepSeekHarness\`.
- **"Port 8765 is already in use by ..."**
  The launcher never touches processes it does not own. If its own leftover from a crashed session holds the port, just relaunch (leftovers are cleaned up automatically). If another program holds it, close that program and relaunch.
- **An update failed**
  The previous version is left intact and the app continues with it. Read the error window for the real cause (lines starting "npm warn deprecated" are harmless notices).
- **After an install the window closed (you clicked Close)**
  That is expected: the "Restart required" message means the first session finished the harness setup. Just start DSH Launcher again and it connects cleanly. Any unexpected error is recorded in `crash.log` inside `%LOCALAPPDATA%\DeepSeekHarness\`.

## Testing without touching a real install

The launcher supports an isolated test mode through environment variables, so you can exercise install/update/launch flows with a completely separate copy of everything:

```powershell
$env:DSH_DATA_DIR = "$env:TEMP\DSHLauncher-Test\data"     # runtime, edge profile, settings, logs
$env:DSH_HOME     = "$env:TEMP\DSHLauncher-Test\dsh-home" # dsh profile/sessions for the test
$env:DSH_PORT     = '8877'                                # avoid the default port 8765
.\Windows\build\DSHLauncher.exe                           # or: powershell -File .\Windows\dsh-app.ps1
```

Or use the bundled runner:

```powershell
.\test\run-isolated.ps1        # start an isolated instance (GUI click-through)
.\test\run-isolated.ps1 -Clean # wipe the sandbox afterwards
```

The single-instance lock and orphan-process cleanup follow the data dir, so a test copy can never kill or overwrite a real install. Tests: `.\test\unit-version.ps1` (version comparison, including defensive handling of malformed tags), `.\test\unit-node-path.ps1` (reproduces the npm build-script "node is not recognized" failure and proves the PATH fix), `.\test\unit-closures.ps1` (guards against `$script:` assignments inside `GetNewClosure()` handlers, which silently never propagate), `.\test\unit-events.ps1` (exercises the real WinForms event wiring used by the tray and the startup window, in PowerShell 5.1), `.\test\unit-resident-checks.ps1` (daily launcher-check throttle, the reminder window after Cancel, and the once-per-version resident dsh notice), `.\test\unit-selfupdate-stage.ps1` (download verification/staging: rejects wrong, undersized or missing checksums and never leaves partial files), `.\test\unit-selfupdate-apply.ps1` (drives the staged-update file swap against temp files, including its safe no-op paths), `.\test\unit-release-notes.ps1` (self-update checksum parsing - fails closed and never accepts the Setup hash), `.\test\unit-release-consistency.ps1` (all four version sources agree), and a headless wiring check with `powershell -File .\Windows\dsh-app.ps1 -selftest`.

## Building from Source

If you want to build the installer yourself:

1. Clone this repository.
2. Install the required tools:
   ```powershell
   Install-Module ps2exe -Scope CurrentUser
   winget install JRSoftware.InnoSetup
   ```
3. Run build.ps1. The resulting installer will be in the dist folder.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\build.ps1
   ```

## License
This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer
This launcher is an independent project and is not affiliated with or endorsed by DeepSeek. The DeepSeek Harness is a separate open-source tool.
