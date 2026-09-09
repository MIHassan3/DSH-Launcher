# DSH Launcher

**A simple launcher for the DeepSeek Harness that keeps it always updated and opens it as a desktop app.**

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## What is this?

The [DeepSeek Harness](https://deepseek.com/harness/en/) is a powerful command‑line tool for interacting with DeepSeek models. However, running it typically requires opening a terminal, remembering npm commands, and using a browser tab. This launcher simplifies everything:

- **One‑click start** – launches the harness and opens it in a clean, app‑like Edge window (no browser chrome).
- **Automatic updates** – checks for new versions on startup and can install them with a single click (or automatically if you prefer).
- **Version picker** – choose between stable and alpha builds.
- **Runs in the background** – no console window stays open; the harness runs silently.
- **Simple installer** – a single `.exe` that installs the launcher and optionally Node.js if missing.

## Requirements

- **Windows 10 or Windows 11** (64‑bit)
- **Node.js** (v18 or later recommended) – the installer can install it for you if missing
- **Microsoft Edge** – already present on all modern Windows systems
- Internet connection (for first‑time installation and updates)

## Installation

1. Download the latest `DSH-Launcher-Setup.exe` from the [Releases](https://github.com/MIHassan3/DSH-Launcher/releases) page.
2. Run the installer. It will:
   - Install the launcher to your user folder (no admin rights needed).
   - Check for Node.js and offer to install it if missing.
3. After installation, launch **DSH Launcher** from the Start Menu or desktop shortcut.
4. On first run, you will be prompted to choose a version (stable or alpha). The harness will then be installed and opened in an Edge app window.

## Usage

- **Starting the app**: Simply run “DSH Launcher” from the Start Menu or desktop.
- **Updating**: If a new version is available, a dialog will appear. You can:
  - **Update now** – automatically installs the latest version.
  - **Ignore this version** – skips this specific version (you can change later in settings).
  - **Not now** – continues with the currently installed version.
- **Switching channels**: On the alpha channel, a reminder appears on every start, allowing you to pick a stable version again.
- **Settings**: The launcher stores its settings in `%LOCALAPPDATA%\DeepSeekHarness\settings.json`. You can edit it manually if needed (e.g., set `"channel": "latest"` or `"skipVersion": "1.2.3"`).

## Troubleshooting
- **“Node.js / npm was not found on PATH”**
Install Node.js from nodejs.org or re‑run the installer and choose to install it.

- **“The harness did not report a URL”**
This usually means the first‑run profile build failed. Close the app and relaunch – it often succeeds on the second attempt. If it persists, check the logs in %LOCALAPPDATA%\DeepSeekHarness\.

- **“Could not clear the old runtime – files are still locked”**
A previous harness process is still running. Open Task Manager, end all node.exe processes, then relaunch.

## Building from Source

If you want to build the installer yourself:

1. Clone this repository.
2. Install the required tools:
   ```powershell
   Install-Module ps2exe -Scope CurrentUser
   winget install JRSoftware.InnoSetup
3. Run build.ps1. The resulting installer will be in the dist folder.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\build.ps1
   
## License
This project is licensed under the MIT License – see the LICENSE file for details.

## Disclaimer
This launcher is an independent project and is not affiliated with or endorsed by DeepSeek. The DeepSeek Harness is a separate open‑source tool.
