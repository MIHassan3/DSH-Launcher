# DSH-Dock: A Unified Framework for a Professional DeepSeek Harness Launcher

**Document Version:** 2.3.0
**Last Updated:** 2026-09-14
**Status:** v0.5.1 shipped — Phase 2 ready to begin

---

## 1. Project Overview

**DSH-Dock** is a cross-platform desktop launcher for the official DeepSeek Harness (`dsh`). It is a **wrapper, not a fork or a patch** — it treats the harness as an opaque black box and never modifies it.

**Tagline:** *Your launchpad for the DeepSeek Harness.*

### 1.1. Problems Solved

| Problem today | DSH-Dock's answer |
| :--- | :--- |
| Running `npx @deepseek-ai/dsh web` in a terminal every session | One-click desktop launch, tray icon, always-warm background server |
| Slow startup — every launch re-resolves from npm | A local version library so the binary is already on disk; the "fast path" starts in near-instant time |
| No visibility into or control over the running version | Full Version Manager UI with channel selection, pinning, and instant switching |
| Update-channel lock-in (you get whatever `latest` is) | User sovereignty: Stable / RC / Alpha channels, pinning, three update behaviors |
| Risk of the updater damaging your work | Data integrity guarantee: everything in `$DSH_HOME` is never touched by install or version-switch operations |

### 1.2. Core Principles

1. **Separation of Concerns** — Shell (Tauri) is dumb; logic (Node.js) is smart; harness is opaque.
2. **Performance First** — Local version library, background operations, fast-path startup.
3. **User Sovereignty** — Updates are never forced on startup. The user picks the channel, the version, and the update behavior.
4. **Data Integrity** — `$DSH_HOME` is a black box. The launcher never reads, writes, or caches inside it.

### 1.3. Target Audience

- **Power Users & Developers** — require specific versions, isolation, and reproducibility.
- **General Users** — want a simple, fast, professional way to run the harness without terminal commands.

---

## 2. Technical Architecture

**"Thin Shell, Smart Core" — a four-layer stack.**

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Shell / UI** | **Tauri v2 (Rust + Web)** | Native desktop window, system tray, settings page. Lightweight, secure, fast. Holds no launcher logic. |
| **Core Logic** | **Node.js (plain JS), run by a bundled Node runtime** | The brain: version library, NPM registry interaction, port allocation, harness spawning, settings I/O. |
| **Harness** | **Official `@deepseek-ai/dsh`** | Runs as a detached background process serving the official web UI. Opaque black box. |
| **Version Store** | **Local filesystem** | Multiple installed harness versions side by side, for instantaneous switching. |

### 2.1. Node.js Runtime — Bundled

We **bundle a portable Node.js runtime (v22.19+ LTS)** with the app, one binary per target platform, packaged as a Tauri resource. This gives us three wins:

- The end user needs nothing pre-installed.
- We pin the exact Node version the harness requires.
- We eliminate the entire class of "which node is on PATH" support issues.

**Consequence for the sidecar:** we do not compile our Node.js core into a standalone binary. Since we ship a Node runtime, our sidecar is a **plain `.js` file executed by the bundled Node**. `pkg` and Node SEA are not used.

The sidecar runs as: `bundled-node(.exe) <path>/sidecar/index.js`

During Phase 1 (development), the sidecar runs on **system Node** — the bundled runtime is a Phase 4 packaging step.

### 2.2. Three Load-Bearing Architectural Decisions

**Dynamic Port Allocation.**
The harness accepts `--host`, `--port`, and `--no-open` flags (verified against the official package's `startup.js`). The Node sidecar binds to port `0`, the OS hands back a free port, and the sidecar passes that port to the Rust shell via a stdout handshake. This eliminates port conflicts entirely.

The harness prints its listening URL (`dsh web: http://127.0.0.1:<port>/?token=...`) to stdout once the plugin tree settles; the sidecar parses it, and the URL is stored verbatim (token intact) in `runtime-state.json`.

**Detached Background Process.**
The harness is started with `detached: true` + `unref()` so it survives the launcher UI closing. **Verified end-to-end**: closing the launcher leaves the harness serving; the next launch adopts it in milliseconds.

**System Tray Integration.**
Deferred to Phase 4.

### 2.3. Detecting and Adopting a Running Harness

Launcher state lives in `<data-dir>/runtime-state.json`:

```json
{
  "pid": 12345,
  "port": 54321,
  "url": "http://127.0.0.1:54321/?token=<signed-token>",
  "harnessVersion": "0.1.5-rc.2",
  "installDir": "C:\\...\\versions\\0.1.5-rc.2",
  "instanceId": "20260912T073019-nkbxoj",
  "startedAt": "2026-09-12T07:30:19Z",
  "recordedAt": "2026-09-12T07:30:57Z"
}
```

At every launcher start, before spawning anything, the core:

1. Reads `runtime-state.json`.
2. If PID alive **and** the stored URL responds → **adopt** it.
3. If PID alive **but** the URL is dead → kill it (identity-checked), then start fresh.
4. If PID dead → clear the state file, start fresh.

**Identity safety:** before killing anything, the core verifies via Windows CIM that the process command line names our install directory. A mismatched process is left alone; only state is cleared. A reap that fails does **not** authorize a fresh start.

### 2.4. State Directory (Per-OS)

| OS | Launcher data directory | Install directory |
| :--- | :--- | :--- |
| Windows | `%LOCALAPPDATA%\DSH-Dock\` | `%LOCALAPPDATA%\Programs\DSH-Dock\` |
| macOS   | `~/Library/Application Support/DSH-Dock/` | `/Applications/DSH-Dock.app` |
| Linux   | `$XDG_DATA_HOME/dsh-dock/` | `/opt/dsh-dock/` or `~/.local/bin/` |

**Install and data directories must be different.** This was violated in v0.5.0 and fixed in v0.5.1 — see §2.7.

Data directory contents: `settings.json`, `runtime-state.json`, `versions/`, `logs/`, `cache/`, `.npm-cache/`.

**`DSH_DOCK_DATA_DIR` override:** if set, this path is used instead of the OS default. Product feature, not a test hack.

**`$DSH_HOME` handling:** if the user has set it, we pass it through to the harness environment unchanged. We never read, write, or cache anything inside it.

**Log files:**
- `<data-dir>/logs/launcher.log` — launcher's own lifecycle log.
- `<data-dir>/logs/harness-<instanceId>.log` — the harness's own stdout file. **The harness truncates this file itself during boot.** The launcher must never write to it.
- `<data-dir>/logs/harness-<instanceId>.launcher.log` — launcher-owned diagnostics about the harness.

### 2.5. Frontend Stack

**Svelte 5 + Vite + TypeScript.** Smallest bundle for a Tauri webview, no virtual-DOM overhead, excellent TS support.

### 2.6. Embedded Webview (Not Browser Hand-off)

The harness UI loads inside the Tauri webview at the token-bearing URL the harness reports. Handing off to the system browser would defeat the purpose of a native-feeling launcher.

**Critical:** the URL is used **verbatim**, with the token intact. Rebuilding it from a port would drop the token and the harness would refuse the page.

The harness window:
- Is labeled `harness` (distinct from the main window `main`).
- Accepts only `http://127.0.0.1:<port>/...` URLs. `localhost` and IPv6 loopback are rejected (see §2.7).
- Grants **no** Tauri commands.

### 2.7. Development Environment Constraints (Discoveries from Phases 0, 1, and v0.5.1)

These are non-obvious behaviors discovered during development. They must be respected throughout the project.

**IPv4 pinning is mandatory.** `vite.config.ts` sets `server.host: "127.0.0.1"` and `tauri.conf.json` sets `devUrl: "http://127.0.0.1:1420"`. Both must use the literal IPv4 address, never `"localhost"`. On Windows, Vite resolves `localhost` as IPv6 `[::1]` while WebView2 resolves it as IPv4 `127.0.0.1`, producing a blank window with no error.

**strictPort is a footgun.** `vite.config.ts` sets `strictPort: true`. If port 1420 is occupied, `beforeDevCommand` exits non-zero — but Tauri v2 still launches the binary, which then loads from a stale dev server left by a prior run.

**Port discovery on Windows.** `Get-NetTCPConnection -LocalPort` does not detect IPv6-only listeners. Use `netstat -ano` or an actual TCP connect.

**Orphaned dev processes.** Cancelling a `cargo tauri dev` job does not kill grandchild processes. Both `node.exe` (sidecars and harnesses) and `msedgewebview2.exe` processes survive job termination. Phase 2 will address via Windows Job Objects.

**`custom-protocol` feature is mandatory for release builds.** `src-tauri/Cargo.toml` must declare:

```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
default = ["custom-protocol"]
```

Without it, release binaries load from `devUrl` at runtime and fail with `ERR_CONNECTION_REFUSED`. **The `default = ["custom-protocol"]` line is load-bearing** — a `[features]` table without a default list leaves the feature off.

**Console window prevention.** A GUI-subsystem binary on Windows spawns console-subsystem children with a fresh console window unless `CREATE_NO_WINDOW` (`0x08000000`) is passed via `CommandExt::creation_flags`. This applies to **both** the Rust-side spawn of the sidecar and the sidecar's own spawn of the harness.

**WebView2 user-data folder sharing.** Two WebView2 environments sharing the same user-data folder cannot each pass their own `additional_browser_args` — the second environment fails silently. Workaround for diagnostics: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var.

**Harness log truncation during boot.** The harness rewrites `harness-<id>.log` itself during startup. Launcher diagnostics go in `harness-<id>.launcher.log`.

**NSIS custom templates are Handlebars-processed.** A custom `installer.nsi` referenced by `bundle.windows.nsis.template` is processed by Handlebars *before* NSIS sees it. Any literal double-brace sequence (`{{`) anywhere in the file — **including inside a comment** — will fail the bundler with a handlebars-syntax panic. The `src-tauri/nsis/installer.nsi` header documents this.

**NSIS install location and data location must differ.** The NSIS `currentUser` default is `$LOCALAPPDATA\${PRODUCTNAME}`, which collides with our data directory `%LOCALAPPDATA%\DSH-Dock\` if unmodified. The custom template changes this to `$LOCALAPPDATA\Programs\${PRODUCTNAME}`. See §2.4.

**Registry key `HKCU\Software\dshdock\DSH-Dock`.** The stock NSIS template reads this on install to restore a previous install location. We disable the restore call in our custom template — a stale key from a prior version would otherwise override the new default and reintroduce the collision.

**Hash reproducibility caveat.** Consecutive builds of identical source do **not** produce identical bytes on Windows because the PE `TimeDateStamp` changes per link. The release process hashes the *artifact that ships*, not "the build". Users verifying a release should verify the artifact itself, not rebuild and compare.

**Silent NSIS installs skip the Start menu shortcut.** The `/S` flag runs the installer non-interactively, and the shortcut-creation step is gated behind the wizard flow. Interactive installs create the shortcut normally. This is expected behavior; the acceptance tests account for it.

---

## 3. Core Feature Specification

### 3.1. Version Management Library — the heart of the product

**Real npm dist-tags (verified 2026-09-10):**

| Channel | npm dist-tag | Current value | Notes |
| :--- | :--- | :--- | :--- |
| **Stable** | `latest` | `0.1.5-rc.1` | Default. Until the harness reaches 1.0, `latest` itself points at an RC. |
| **RC** | `next` | `0.1.5-rc.2` | Release candidate. Genuinely newest pre-release. |
| **Alpha** | `alpha` | `0.1.5-alpha.2` | Bleeding edge. Changes often. |

Phase 1 resolves "latest RC" via `next` → `latest` → **hard failure** (never a silent alpha fallback).

**First run:** downloads the latest **Stable** and the latest **Alpha** (two versions, not three). RC is opt-in from the Version Manager.

**On-demand:** the user can download any specific version from the Version Manager, in the background, with progress indicators.

**Background caching:** periodic NPM registry polling (see §3.2 for cadence). New releases are pre-downloaded automatically, bounded by a user-configurable limit (default 10 versions).

**Populating the library:** `npm install --prefix <version-dir> --cache <data-dir>/.npm-cache --no-audit --no-fund @deepseek-ai/dsh@<exact>`, producing a self-contained, resolvable dependency tree per version.

- Path layout: `<data-dir>\versions\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js`.
- Switching repoints to that `bin.js`. No reinstall, no copy.
- **`--ignore-scripts` is deliberately NOT passed** — the harness needs its dependency postinstalls.

**npm spawn pattern (CVE-2024-27980):** since the fix, Node refuses to spawn `.cmd`/`.bat` without `shell: true`. We locate npm's CLI script and invoke it with our own Node: `node <npm-cli.js> install ...`. Resolution order: `$npm_execpath` → `npm-cli.js` next to the node binary → standard global locations.

**Storage management:** when the cache limit is exceeded, the launcher **prompts** the user — it never silently evicts.

**Known failure mode (discovered v0.5.1):** a broken or partially-completed npm install produces a harness that crashes at boot with an opaque `ERR_MODULE_NOT_FOUND`. The install tree can be validated post-install by checking that key files exist. The repair path is: wipe `versions/` and `.npm-cache/`, reinstall. Phase 2 will add automatic validation.

### 3.2. Update Mechanism

Two orthogonal axes of user control:

**Channel:** `Stable (latest)` / `RC (next)` / `Alpha (alpha)`.

**Behavior:**
- **Automatic** — silent background download and install.
- **Notify** — check on launch, tell the user, let them choose.
- **Manual** — only when the user clicks "Check for Updates."

**Plus:** version pinning.

**Background polling cadence:** at most once per **12 hours**, recorded as `lastUpdateCheck` in state. `If-None-Match` with stored ETag.

**Minimum supported harness version:** a constant `MIN_SUPPORTED_DSH` in the sidecar. Still `"0.0.0"` after Phase 1 — the real value is derived in Phase 2.

### 3.3. Fast-Path Startup Sequence

1. Read preferred version from `settings.json`.
2. Check whether it is in the local library.
3. **Yes** → start the harness immediately (near-instant).
4. **No** → fall back to the latest downloaded version, or prompt to download the preferred one.
5. Only **after** the harness is up does the core silently check for new versions.

**Critical property:** the network is never on the critical path of a startup.

**Measured timings (v0.5.1, from logs):**
- Cold install: ~5 min (372 MB / 518 packages)
- Warm boot (already installed): ~37–70s from spawn to URL
- Adopt (next launcher start): <1s

### 3.4. Version Manager UI

A table with columns **Version | Channel | Status | Action**.

| Version | Channel | Status | Action |
| :--- | :--- | :--- | :--- |
| 1.1.0-rc.2 | RC | **Active** | [Switch] |
| 1.1.0-rc.1 | RC | Downloaded | [Switch] [Delete] |
| 1.0.0 | Stable | Downloaded | [Switch] [Delete] |
| 1.0.0-alpha.5 | Alpha | Not Downloaded | [Download] |

(Phase 2/3 work.)

### 3.5. Launcher Self-Update

Distinct from harness updates. The **Tauri v2 Updater Plugin** updates *DSH-Dock itself* via GitHub Releases and a `latest.json` manifest. Silent, applies on next restart.

**Code signing:** out of scope for v1.0.0. Ship unsigned; document the SmartScreen and Gatekeeper prompts clearly in the README.

### 3.6. Control Surface (HTTP on the Sidecar)

The sidecar exposes HTTP routes on its own loopback port. The frontend goes through Tauri commands (`harness_status`, `harness_start`, `harness_stop`), which proxy to these routes.

| Route | Method | Returns |
| :--- | :--- | :--- |
| `/harness/status` | GET | `{status, version, url, pid, startedAt, message, lastError, instanceId, logFile, launcherLog}` |
| `/harness/start` | POST | `202 Accepted` — never blocks |
| `/harness/stop` | POST | `{status: "stopped"}` — identity-checked |
| `/harness/restart` | POST | `202 Accepted` — stop + start |

**Status states:** `stopped` | `starting` | `running` | `error`.

**Errors are first-class.** When start fails, `lastError` names the failing step and includes the tail of the relevant log file.

**`DSH_DOCK_START_ON_BOOT=1`** (env var) — hook for Phase 3.

### 3.7. Installer Behavior (Windows)

The Windows installer is NSIS, per-user (`installMode: "currentUser"`), with a custom template at `src-tauri/nsis/installer.nsi` derived from tauri-bundler 2.9.4. Two body changes: the default install path and the disabled restore-registry-location call.

Payload layout at the installed directory:
```
%LOCALAPPDATA%\Programs\DSH-Dock\
├── dsh-dock.exe
├── uninstall.exe
└── sidecar\
    ├── index.js
    ├── package.json
    └── lib\*.js
```

No `resources\sidecar\` — the sidecar is exe-adjacent. The Rust resolver's exe-adjacent branch finds it.

### 3.8. Explicit Non-Goals for v1.0

- Modifying, patching, or forking the official harness.
- Touching anything inside `$DSH_HOME`.
- Telemetry of any kind.
- Cloud sync of settings or sessions.
- Non-official harness builds.

---

## 4. Development Plan — Phases and Milestones

| Phase | Duration | Target | Key Milestones |
| :--- | :--- | :--- | :--- |
| **Phase 0: Foundation** | ✅ Complete 2026-09-10 | Project scaffold and IPC proof. | All milestones ✅. |
| **Phase 1: MVP Core** | ✅ Complete 2026-09-13 | Install and run one hardcoded version; adopt/reap; embedded webview. | All milestones ✅. |
| **v0.5.0 release** | ✅ Complete 2026-09-13 | Public pre-release. | Published with known installer issues. |
| **v0.5.1 fix** | ✅ Complete 2026-09-14 | Installer packaging fix. | Sidecar bundled, install/data dirs separated, restore call disabled, packaging-check.ps1 added. All acceptance tests passed. |
| **Phase 2: Version Library & Dynamic Port** | 3 weeks | Multi-version management. | 1. Library directory structure generalized. <br> 2. Multi-version download (on-demand + background). <br> 3. Version switching in the UI. <br> 4. Storage management prompts. <br> 5. `MIN_SUPPORTED_DSH` derived from evidence. <br> 6. Job Object for orphan prevention. <br> 7. Install tree validation after npm install. |
| **Phase 3: Settings & Update UI** | 3 weeks | Full settings surface. | 1. Version Manager table UI. <br> 2. Update Preferences UI. <br> 3. Background check + notification system. <br> 4. Tauri v2 Updater integration. <br> 5. Channel selection and pinning. |
| **Phase 4: Polish & Release** | 2 weeks | v1.0.0. | 1. System tray. <br> 2. Cross-platform builds (`.exe`, `.dmg`, `.AppImage`). <br> 3. Bundled Node runtime. <br> 4. Docs + SECURITY.md. <br> 5. `--remap-path-prefix`. <br> 6. v1.0.0 release. |

**Total estimated timeline: 11 weeks.**

### 4.1. Phase 0 Deliverables

**Root:** `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `.gitignore`

**`src/`:** `index.html`, `main.ts`, `App.svelte`, `svelte.config.js`, `styles/global.css`

**`sidecar/`:** `index.js`, `package.json`, `lib/protocol.js`, `lib/service.js`, `lib/version-manager.js`, `lib/state.js`, `lib/registry.js`, `test/handshake.ps1`, `test/smoke.js`

**`src-tauri/`:** `Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `NOTES.md`, `src/main.rs`, `src/lib.rs`, `capabilities/default.json`, `test/window-check.ps1`, `icons/`

### 4.2. Phase 1 Deliverables

**`sidecar/lib/`** — new: `control.js`, `harness-install.js`, `harness-start.js`, `harness.js`, `platform.js`. Rewritten: `registry.js`, `service.js`, `state.js`, `version-manager.js`

**`sidecar/test/`** — new: `control.js`, `control-live.js`, `harness.js`, `harness-install.js`, `harness-start.js`, `platform.js`, `registry.js`, `state.js`, `lib/check.js`, `lib/fake-npm.js`, `lib/noop-child.js`

**`src-tauri/`** — modified: `Cargo.toml`, `Cargo.lock`, `build.rs`, `capabilities/default.json`, `src/lib.rs`. New: `capabilities/harness.json`, `permissions/autogenerated/*.toml`, `test/acceptance.ps1`, `test/console-check.ps1`, `test/console-probe.rs`, `test/manual-ui-check.ps1`

**`src/`** — modified: `App.svelte`. New: `lib/sidecar-connection.js`, `test/sidecar-connection.test.js`

### 4.3. v0.5.1 Fix Deliverables

**New:**
- `scripts/stage-sidecar.mjs` — exclusion-based staging script
- `src-tauri/nsis/installer.nsi` — custom NSIS template (derived from tauri-bundler 2.9.4)
- `src-tauri/test/packaging-check.ps1` — packaging regression gate (7 assertions)

**Modified:**
- `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — version 0.5.1
- `src-tauri/src/lib.rs` — resolver rework (three-branch), absolute sidecar path
- `src-tauri/NOTES.md` — packaging gate documentation

**Verified acceptance (VM):** Tests A (bogus key ignored), C (`/D` custom path), D (upgrade preserves data) all passed. Test B/E confirmed visually (dashboard + harness UI render, warm adoption works).

---

## 5. Repository Layout

**The repo root is the project root.**

```
DSH-Launcher/
├── .github/workflows/           # Phase 4
├── .gitignore
├── LICENSE
├── README.md
├── SECURITY.md
│
├── docs/
│   ├── PROJECT_DSH-DOCK.md
│   └── assets/
│       ├── icon.ico
│       └── screenshots/
│
├── scripts/
│   └── stage-sidecar.mjs        # v0.5.1: stages sidecar into build output
│
├── src/
│   ├── index.html
│   ├── main.ts
│   ├── App.svelte
│   ├── svelte.config.js
│   ├── lib/sidecar-connection.js
│   ├── styles/global.css
│   └── test/sidecar-connection.test.js
│
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── nsis/
│   │   └── installer.nsi        # v0.5.1: custom NSIS template
│   ├── capabilities/
│   │   ├── default.json
│   │   └── harness.json
│   ├── permissions/autogenerated/
│   ├── test/
│   │   ├── acceptance.ps1
│   │   ├── console-check.ps1
│   │   ├── console-probe.rs
│   │   ├── manual-ui-check.ps1
│   │   ├── packaging-check.ps1  # v0.5.1: packaging gate
│   │   └── window-check.ps1
│   ├── icons/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── build.rs
│   ├── tauri.conf.json
│   └── NOTES.md
│
├── sidecar/
│   ├── index.js
│   ├── package.json
│   ├── lib/
│   │   ├── protocol.js
│   │   ├── service.js
│   │   ├── version-manager.js
│   │   ├── state.js
│   │   ├── registry.js
│   │   ├── harness-install.js
│   │   ├── harness.js
│   │   ├── harness-start.js
│   │   ├── control.js
│   │   └── platform.js
│   └── test/
│       ├── handshake.ps1
│       ├── smoke.js
│       ├── state.js, platform.js, registry.js
│       ├── harness.js, harness-install.js, harness-start.js
│       ├── control.js, control-live.js
│       └── lib/
│           ├── check.js
│           ├── fake-npm.js
│           └── noop-child.js
│
├── legacy/
│   └── (preserved; never referenced)
│
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### 5.1. Workspace Layout Notes

- **npm workspaces.** Root `package.json` declares `"workspaces": ["sidecar"]` and `"private": true`.
- **`src/svelte.config.js`, not root.** `vite-plugin-svelte` resolves its config relative to Vite's `root`.
- **`src-tauri/gen/` is gitignored.**
- **`src-tauri/permissions/autogenerated/` is committed.**
- **`src-tauri/nsis/installer.nsi` is committed.** It must be re-synced against upstream tauri-bundler on Tauri upgrades — see its header.

### 5.2. About the `legacy/` Folder

Historical reference only. Do not read, import from, modify, or delete.

---

## 6. Git and Repository Conventions

- Repo: `https://github.com/MIHassan3/DSH-Launcher`.
- `.gitignore` excludes: `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/binaries/*.exe`, `src-tauri/binaries/*.bin`, `dist/`, `*.log`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.npm-cache/`, `.test-tmp/`.
- **Path hazard:** parent folder name contains a space. Quote everything.
- **Hash reproducibility:** Windows builds are not byte-reproducible (PE timestamps). Hash the shipped artifact.

---

## 7. Recommendations for Development (Dev Guidance — Not Product Spec)

This section is for **us building DSH-Dock**. It is not a runtime dependency of the product.

### 7.1. Model Settings

- **Model:** DeepSeek V4.1 Flash.
- **Modes:** Expert for architecture; Vision for UI mockups.

### 7.2. Useful Harness Plugins

1. **`dsh-mcp-manage`** — GUI for MCP servers.
2. **`dsh-claude-compat`** — folds `.claude/` rules into sessions.
3. **`prompt-skill-armory`** — management panel for prompts and presets.

### 7.3. Development Tools

- **Node.js v22.19+ LTS** (dev uses whatever's installed; shipped bundle pins 22.x in Phase 4).
- **Tauri v2 CLI** — `cargo install tauri-cli --version "^2"`.
- **Rust 1.84.0+** — verified with 1.98.1.
- **GitHub Actions** — Phase 4 CI.

### 7.4. Testing Discipline (Lessons from Phases 0, 1, and v0.5.1)

**Acceptance testing must use the release binary with no dev server running.** Debug builds load from `devUrl` and mask bugs that only appear when the frontend is embedded.

**Every release must be tested from the actual installed artifact — not just the repo-built exe.** This is the lesson that cost us the v0.5.0 installer bug. The installer payload, the default install directory, and the uninstaller's behavior all need verification against the shipped artifact.

**Verify on a clean VM.** The dev machine accumulates state that hides bugs.

**Three tiers of test, in order of value:**
1. **Live tests against the real harness** — they catch what stubs never will (npm.cmd EINVAL, harness log truncation).
2. **Integration tests against real processes and fixtures** — adopt/reap identity checks, control surface.
3. **Unit tests** — fast, but they can pass while the artifact on disk is broken.

**Packaging regression gate.** `src-tauri/test/packaging-check.ps1` runs after `cargo tauri build` and before publishing. Seven assertions. Exits non-zero on failure. This is the gate that would have caught the v0.5.0 bugs.

**Session hygiene for DSH.** A single DSH session has a context limit — very large sessions cause stream idle timeouts. Start fresh sessions per major phase or per focused fix. The MD file is the memory that survives across sessions.

**Do not run destructive tests inside a session that depends on the target.** DSH running inside the harness that DSH-Dock launched is self-hosting — its tests can kill its own host. Isolation is mandatory for any test that uninstalls or force-kills the launcher.

---

## 8. Architectural Decisions Log

| # | Question | Decision |
| :--- | :--- | :--- |
| Q1–Q35 | (See v2.2.0 history for full log) | — |
| Q36 | Installer packaging | Sidecar bundled via `scripts/stage-sidecar.mjs` + `bundle.resources`; exclusion-based staging. |
| Q37 | Install/data directory separation | Install to `%LOCALAPPDATA%\Programs\DSH-Dock\`; data at `%LOCALAPPDATA%\DSH-Dock\`. Custom NSIS template. |
| Q38 | Custom NSIS template scope | Exactly two body changes: default install path, disable restore call. Documented in header. Re-sync on Tauri upgrade. |
| Q39 | Handlebars hazard | Custom templates are Handlebars-processed. No literal `{{` anywhere, including comments. |
| Q40 | Registry restore call | Disabled. Custom install paths still work via `/D=<path>`, but are not remembered across upgrades. |
| Q41 | Packaging regression gate | `src-tauri/test/packaging-check.ps1` — 7 assertions, run before publish. Not part of `cargo tauri build`. |
| Q42 | MSI support | Removed from `bundle.targets` for v0.5.1. NSIS only until the WiX install-dir fix is done (Phase 4). |
| Q43 | Silent install behavior | Start menu shortcut is not created by `/S` installs. Interactive installs create it. Expected, documented. |
| Q44 | Sidecar package version | `sidecar/package.json` stays at `0.0.0`. Not user-visible. Do not couple to app version. |

### 8.1. Deferred to Phase 2

- **Windows Job Object** for orphan prevention (sidecar + harness + WebView2).
- **`MIN_SUPPORTED_DSH`** value derived from real install + boot + switch testing.
- **Install tree validation** after `npm install` — verify key files exist before declaring success.
- **Sidecar "no port" flash** — the current 2-second retry budget is tight on cold VM starts; extend or make configurable.

### 8.2. Deferred to Phase 4

- **`--remap-path-prefix`** in release builds (privacy).
- **Bundled Node runtime** as a Tauri resource.
- **MSI installer** with a matching custom template.
- **Code signing / notarization** (post-1.0).
- **`--ignore-scripts`** revisit for install hardening.

---

## 9. Visual Identity

- **Icon:** `docs/assets/icon.ico`.
- **Palette:**
  - Primary: Deep Blue `#1E3A5F`
  - Accent: Cyan `#00B4D8`
  - Background: Dark Charcoal `#1A1A1A`
  - Text: Off-White `#F0F0F0`
- **Typography:** Segoe UI (Windows), SF Pro (macOS), Inter (cross-platform web UI).

---

*End of document.*