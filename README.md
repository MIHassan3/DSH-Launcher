# DSH-Dock

**Your launchpad for the DeepSeek Harness.**

DSH-Dock is a desktop launcher for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`). It runs the harness in the background and shows its UI in a native window, so you don't have to open a terminal every time.

DSH-Dock is a **wrapper, not a fork**. It manages the harness's lifecycle; it never modifies the harness itself.

---

## Status: Technical Preview (v0.5.0)

This is a **Phase 1 milestone**. The launcher is functional and works end-to-end for its core use case, but the surrounding features are not yet built.

### What works

- One-click launch of the DeepSeek Harness in a native Tauri window
- The harness runs detached in the background
- The harness **survives the launcher closing** — reopening the launcher adopts the running harness instantly
- Installs the latest RC of `@deepseek-ai/dsh` automatically on first run
- Native dashboard with start / stop / open controls

### What is not in this preview

- No version picker — always uses the latest RC channel
- No settings UI
- No system tray icon
- No auto-update for the launcher itself
- **Windows only** — macOS and Linux come in Phase 4
- **Unsigned binaries** — expect SmartScreen warnings on first launch
- Node.js v22.19+ must be installed manually (bundled runtime is Phase 4)

The full version-management library, channel picker, and settings surface arrive in later phases. See [`docs/PROJECT_DSH-DOCK.md`](docs/PROJECT_DSH-DOCK.md) for the roadmap.

---

## Prerequisites

- **Windows 10 or 11** (x64)
- **Node.js v22.19 or newer** — [download LTS](https://nodejs.org/)
- **WebView2 Runtime** — preinstalled on Windows 10/11; if missing, [get it here](https://developer.microsoft.com/microsoft-edge/webview2/)

---

## Install

1. Download `DSH-Dock_0.5.0_x64-setup.exe` from the [latest release](https://github.com/MIHassan3/DSH-Launcher/releases/latest).
2. Run it. Windows SmartScreen will warn because the binary is unsigned — click **More info** → **Run anyway**.
3. Launch **DSH-Dock** from the Start menu.

The first launch downloads and installs the DeepSeek Harness (~370 MB). This takes a few minutes. Subsequent launches are instant.

---

## Where your data lives

DSH-Dock keeps its own state in:

```
%LOCALAPPDATA%\DSH-Dock\
├── runtime-state.json     # which harness is running, on what port
├── versions\              # installed harness versions
├── logs\                  # launcher and harness logs
└── .npm-cache\            # npm download cache
```

**Your DeepSeek Harness data is never touched.** Sessions, configuration, credentials, and plugins live in `%USERPROFILE%\.dsh\` (or wherever `$DSH_HOME` points), and DSH-Dock never reads, writes, or caches inside that directory.

---

## Uninstall

Uninstall via **Settings → Apps → DSH-Dock**, or use the uninstaller in the Start menu. To remove your harness data too, delete `%USERPROFILE%\.dsh\` manually.

---

## Building from source

See [`docs/PROJECT_DSH-DOCK.md`](docs/PROJECT_DSH-DOCK.md) §7 for the toolchain. The short version:

```powershell
git clone https://github.com/MIHassan3/DSH-Launcher.git
cd DSH-Launcher
npm install
cargo tauri build
```

Requires Rust 1.84+, Node 22.19+, the Tauri CLI (`cargo install tauri-cli --version "^2"`), and the MSVC C++ build tools.

---

## Legacy

This repository previously shipped a Windows-only PowerShell launcher (`v0.1.1` and earlier). It has been superseded by DSH-Dock and is preserved, unmaintained, in [`legacy/`](legacy/).

---

## License

MIT — see [`LICENSE`](LICENSE).