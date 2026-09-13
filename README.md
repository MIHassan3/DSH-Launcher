<p align="center">
  <img src="docs/assets/icon.ico" alt="DSH-Dock icon" width="120" height="120">
</p>

<h1 align="center">DSH-Dock</h1>

<p align="center">
  <strong>Your launchpad for the DeepSeek Harness.</strong>
</p>

<p align="center">
  <a href="https://github.com/MIHassan3/DSH-Launcher/releases/latest">
    <img src="https://img.shields.io/github/v/release/MIHassan3/DSH-Launcher?include_prereleases&style=flat-square" alt="Latest release">
  </a>
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform: Windows">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License: MIT">
  <img src="https://img.shields.io/badge/status-technical%20preview-orange?style=flat-square" alt="Status: preview">
</p>

---

DSH-Dock is a desktop launcher for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`). It runs the harness in the background and shows its UI in a native window — no terminal, no copy-pasting commands, no losing your harness when you close the launcher.

DSH-Dock is a **wrapper, not a fork**. It manages the harness's lifecycle without ever modifying the harness itself.

---

## What it looks like

### The dashboard

Control the harness from a clean native window — start it, stop it, see what version is running, and open its UI when you're ready.

<p align="center">
  <img src="docs/assets/screenshots/01-dashboard-idle.png" alt="DSH-Dock dashboard, idle state" width="720">
</p>

### Starting the harness

Click **Start Harness** and the dashboard shows live progress while the harness boots. First boot installs the harness; subsequent boots are much faster.

<p align="center">
  <img src="docs/assets/screenshots/01-dashboard-starting.png" alt="DSH-Dock dashboard, starting state" width="720">
</p>

### Running

Once the harness is up, the dashboard shows its version, process ID, port URL, and start time. The harness runs in the background — closing the launcher doesn't stop it.

<p align="center">
  <img src="docs/assets/screenshots/02-dashboard-running.png" alt="DSH-Dock dashboard, running state" width="720">
</p>

### The DeepSeek Harness UI

The harness opens in its own native window, running inside an embedded webview. It's the official UI — unmodified.

<p align="center">
  <img src="docs/assets/screenshots/03-harness-window.png" alt="DeepSeek Harness running in a native window" width="720">
</p>

### Both windows

The launcher stays as a control panel. The harness gets its own space.

<p align="center">
  <img src="docs/assets/screenshots/04-side-by-side.png" alt="DSH-Dock and the DeepSeek Harness side by side" width="900">
</p>

---

## Status: Technical Preview (v0.5.0)

This is a **Phase 1 milestone**. The launcher works end-to-end for its core use case, but the surrounding features are not yet built.

### ✅ What works

- One-click launch of the DeepSeek Harness in a native window
- The harness runs **detached in the background**
- The harness **survives the launcher closing** — reopening the launcher adopts it instantly
- Installs the latest RC of `@deepseek-ai/dsh` automatically on first run
- Native dashboard with start / stop / open controls

### ❌ What is not in this preview

- No version picker — always uses the latest RC channel
- No settings UI
- No system tray icon
- No auto-update for the launcher itself
- **Windows only** — macOS and Linux come in Phase 4
- **Unsigned binaries** — expect SmartScreen warnings on first launch
- Node.js v22.19+ must be installed manually (bundled runtime is Phase 4)

The full version-management library, channel picker, and settings surface arrive in later phases. See [`docs/PROJECT_DSH-DOCK.md`](docs/PROJECT_DSH-DOCK.md) for the roadmap.

---

## Installation

### Prerequisites

| Requirement | Why | Where to get it |
| :--- | :--- | :--- |
| **Windows 10 or 11 (x64)** | The launcher is Windows-only for now | — |
| **Node.js v22.19+ LTS** | The harness itself runs on Node; DSH-Dock invokes it during Phase 1 | [nodejs.org](https://nodejs.org/) |
| **WebView2 Runtime** | The launcher renders its UI inside WebView2 | Preinstalled on Win 10/11. [Get it here](https://developer.microsoft.com/microsoft-edge/webview2/) if missing |

### Steps

1. **Download the installer.**

   Go to the [latest release](https://github.com/MIHassan3/DSH-Launcher/releases/latest) and download **`DSH-Dock_0.5.0_x64-setup.exe`**.

   > **Note:** The binary is unsigned, so Windows SmartScreen will warn you on first run. Click **More info** → **Run anyway**.

2. **Run the installer.**

   <p align="center">
     <img src="docs/assets/screenshots/05-installer.png" alt="DSH-Dock installer wizard" width="500">
   </p>

   The installer is per-user, so it does **not** require administrator rights. It installs DSH-Dock into `%LOCALAPPDATA%\Programs\DSH-Dock\` and adds a Start-menu shortcut.

3. **Launch DSH-Dock.**

   The first launch downloads and installs the latest DeepSeek Harness release (~370 MB). This takes a few minutes depending on your connection.

   > **First run is slow. This is expected.** Subsequent launches are instant — the harness is already on disk.

4. **Click `Start Harness`.**

   The dashboard will show progress as the harness boots. Once the badge reads `RUNNING`, click **Open Harness** to launch the DeepSeek Harness in its own window.

---

## Common questions

### Where does my data live?

DSH-Dock keeps its own state in:

```
%LOCALAPPDATA%\DSH-Dock\
├── runtime-state.json     # which harness is running, on what port
├── versions\              # installed harness versions
├── logs\                  # launcher and harness logs
└── .npm-cache\            # npm download cache
```

**Your DeepSeek Harness data is never touched.** Sessions, configuration, credentials, and plugins live in `%USERPROFILE%\.dsh\` (or wherever `$DSH_HOME` points), and DSH-Dock never reads, writes, or caches inside that directory.

### Can I run the official DeepSeek Harness and DSH-Dock at the same time?

In theory yes, but both would use the same `%USERPROFILE%\.dsh\` profile and could conflict during the plugin tree build. **Recommended:** close the official harness before launching DSH-Dock.

Phase 2 will add explicit profile isolation.

### What if something goes wrong?

Logs are in `%LOCALAPPDATA%\DSH-Dock\logs\`:

- `launcher.log` — the launcher's own lifecycle events
- `harness-<id>.log` — the harness's stdout
- `harness-<id>.launcher.log` — the launcher's diagnostics about the harness

If the dashboard shows an error, check `launcher.log` first. When reporting a bug, attach both `launcher.log` and the most recent `harness-*.log`.

### How do I uninstall?

Use **Settings → Apps → DSH-Dock** on Windows, or run the uninstaller in the Start menu.

To remove your harness data too, delete `%USERPROFILE%\.dsh\` manually.

### Does DSH-Dock phone home?

No. No telemetry, no analytics, no cloud sync. The only outbound requests are to the npm registry (`registry.npmjs.org`) when installing or checking for harness updates.

---

## Building from source

You'll need:

- **Rust 1.84+** — [rustup.rs](https://rustup.rs)
- **Node.js v22.19+ LTS** — [nodejs.org](https://nodejs.org/)
- **Tauri CLI v2** — `cargo install tauri-cli --version "^2"`
- **MSVC C++ build tools** — [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022), "Desktop development with C++" workload

Then:

```powershell
git clone https://github.com/MIHassan3/DSH-Launcher.git
cd DSH-Launcher
npm install
cargo tauri build
```

The installer ends up in `src-tauri\target\release\bundle\nsis\`.

For architecture details, the phases plan, and development constraints, see [`docs/PROJECT_DSH-DOCK.md`](docs/PROJECT_DSH-DOCK.md).

---

## Roadmap

| Phase | Status | What it delivers |
| :--- | :--- | :--- |
| **Phase 0** — Foundation | ✅ Done | Tauri shell, sidecar IPC, "hello world" |
| **Phase 1** — MVP Core | ✅ Done | Install + spawn + adopt, embedded webview, v0.5.0 preview |
| **Phase 2** — Version Library | 🔄 Next | Multi-version download, switching, cache limits |
| **Phase 3** — Settings & Updates | ⏳ Planned | Version Manager UI, update preferences, self-updater |
| **Phase 4** — Polish & Release | ⏳ Planned | System tray, macOS + Linux builds, v1.0.0 |

---

## Security

DSH-Dock only talks to `127.0.0.1` (and the npm registry). It never modifies the harness, never touches your `$DSH_HOME`, and the harness window has no access to the launcher's internals.

See [`SECURITY.md`](SECURITY.md) for the full security policy.

---

## Legacy

This repository previously shipped a Windows-only PowerShell launcher (`v0.1.1` and earlier). It has been superseded by DSH-Dock and is preserved, unmaintained, in [`legacy/`](legacy/).

If you're still using the old launcher, you can switch to DSH-Dock safely — your harness data in `%USERPROFILE%\.dsh\` is untouched.

---

## License

MIT — see [`LICENSE`](LICENSE).
