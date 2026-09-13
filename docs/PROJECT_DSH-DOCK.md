# DSH-Dock: A Unified Framework for a Professional DeepSeek Harness Launcher

**Document Version:** 2.2.0
**Last Updated:** 2026-09-13
**Status:** Phase 1 complete — Phase 2 ready to begin

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
The harness accepts `--host`, `--port`, and `--no-open` flags (verified against the official package's `startup.js`). The Node sidecar binds to port `0`, the OS hands back a free port, and the sidecar passes that port to the Rust shell via a stdout handshake. This eliminates port conflicts entirely — including against a user's own `dsh web` instance.

The harness prints its listening URL (`dsh web: http://127.0.0.1:<port>/?token=...`) to stdout once the plugin tree settles; the sidecar parses it, and the URL is stored verbatim (token intact) in `runtime-state.json`.

**Detached Background Process.**
The harness is started with `detached: true` + `unref()` so it survives the launcher UI closing. **Verified end-to-end**: closing the launcher leaves the harness serving; the next launch adopts it in milliseconds.

**System Tray Integration.**
Deferred to Phase 4. Quick access, live status, graceful shutdown.

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
2. If PID alive **and** the stored URL responds → **adopt** it (the webview opens at that URL).
3. If PID alive **but** the URL is dead → kill it (identity-checked), then start fresh.
4. If PID dead → clear the state file, start fresh.

**Identity safety:** before killing anything, the core verifies via Windows CIM that the process command line names our install directory. A mismatched process is left alone; only state is cleared. A reap that fails does **not** authorize a fresh start — starting a second harness against a port the old one may hold is the worst available outcome.

This is what makes the "fast path" actually fast.

### 2.4. State Directory (Per-OS)

| OS | Launcher data directory |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\DSH-Dock\` |
| macOS   | `~/Library/Application Support/DSH-Dock/` |
| Linux   | `$XDG_DATA_HOME/dsh-dock/` (default `~/.local/share/dsh-dock/`) |

Contents: `settings.json`, `runtime-state.json`, `versions/`, `logs/`, `cache/`.

**`DSH_DOCK_DATA_DIR` override:** if set, this path is used instead of the OS default. It is a **product feature** (isolated data for power users and multi-instance testing), not a test-only hack. Production code never sets it; only test scripts and users do.

**`$DSH_HOME` handling:** if the user has set it, we pass it through to the harness environment unchanged. We never read, write, or cache anything inside it. If unset, we pass nothing and the harness uses its own default.

**Log files:**
- `<data-dir>/logs/launcher.log` — launcher's own lifecycle log (append-only; used in release builds where stderr is not visible).
- `<data-dir>/logs/harness-<instanceId>.log` — the harness's own stdout file. **The harness truncates this file itself during boot.** The launcher must never write to it.
- `<data-dir>/logs/harness-<instanceId>.launcher.log` — the launcher's own diagnostics about the harness (append-only). Kept separate because the harness rewrites its own log during boot.

### 2.5. Frontend Stack

**Svelte 5 + Vite + TypeScript.** Smallest bundle for a Tauri webview, no virtual-DOM overhead, excellent TS support, small enough to read end-to-end during debugging.

### 2.6. Embedded Webview (Not Browser Hand-off)

The harness UI loads inside the Tauri webview at the token-bearing URL the harness reports. Handing off to the system browser would defeat the purpose of a native-feeling launcher.

**Critical:** the URL is used **verbatim**, with the token intact. Rebuilding it from a port would drop the token and the harness would refuse the page.

The harness window:
- Is labeled `harness` (distinct from the main window `main`).
- Accepts only `http://127.0.0.1:<port>/...` URLs. `localhost` and IPv6 loopback are rejected (see §2.7).
- Grants **no** Tauri commands — a hostile page in that window can call nothing.

### 2.7. Development Environment Constraints (Discoveries from Phases 0 and 1)

These are non-obvious behaviors discovered during development. They must be respected throughout the project.

**IPv4 pinning is mandatory.** `vite.config.ts` sets `server.host: "127.0.0.1"` and `tauri.conf.json` sets `devUrl: "http://127.0.0.1:1420"`. Both must use the literal IPv4 address, never `"localhost"`. On Windows, Vite resolves `localhost` as IPv6 `[::1]` while WebView2 resolves it as IPv4 `127.0.0.1`, producing a blank window with no error.

**strictPort is a footgun.** `vite.config.ts` sets `strictPort: true`. If port 1420 is occupied, `beforeDevCommand` exits non-zero — but Tauri v2 still launches the binary, which then loads from a stale dev server left by a prior run. See `src-tauri/NOTES.md`. Resolution is a Phase 3/4 item.

**Port discovery on Windows.** `Get-NetTCPConnection -LocalPort` does not detect IPv6-only listeners. Use `netstat -ano` or an actual TCP connect.

**Orphaned dev processes.** Cancelling a `cargo tauri dev` job does not kill grandchild processes. Both `node.exe` (sidecars and harnesses) and `msedgewebview2.exe` processes survive job termination. Phase 2 will address via Windows Job Objects (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).

**`custom-protocol` feature is mandatory for release builds.** `src-tauri/Cargo.toml` must declare:

```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
default = ["custom-protocol"]
```

Without it, release binaries load from `devUrl` at runtime and fail with `ERR_CONNECTION_REFUSED` when nothing is on port 1420. **The `default = ["custom-protocol"]` line is load-bearing** — a `[features]` table without a default list leaves the feature off, and even a plain `cargo build --release` produces a dev-mode binary.

**Console window prevention.** A GUI-subsystem binary on Windows spawns console-subsystem children with a fresh console window unless `CREATE_NO_WINDOW` (`0x08000000`) is passed via `CommandExt::creation_flags`. This applies to **both** the Rust-side spawn of the sidecar and the sidecar's own spawn of the harness. Verified by `src-tauri/test/console-check.ps1` with a control case.

**WebView2 user-data folder sharing.** Two WebView2 environments sharing the same user-data folder cannot each pass their own `additional_browser_args` — the second environment fails silently. The workaround for diagnostics is the environment variable:

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
```

Set it before launching the exe. `http://127.0.0.1:9222/json/list` then lists **both** windows as debuggable page targets.

**Harness log truncation during boot.** The harness rewrites `harness-<id>.log` itself during startup. The launcher's own writes to that file are silently erased. Launcher diagnostics go in `harness-<id>.launcher.log`.

---

## 3. Core Feature Specification

### 3.1. Version Management Library — the heart of the product

**Real npm dist-tags (verified 2026-09-10):**

| Channel | npm dist-tag | Current value | Notes |
| :--- | :--- | :--- | :--- |
| **Stable** | `latest` | `0.1.5-rc.1` | Default. Until the harness reaches 1.0, `latest` itself points at an RC. |
| **RC** | `next` | `0.1.5-rc.2` | Release candidate. Genuinely newest pre-release. |
| **Alpha** | `alpha` | `0.1.5-alpha.2` | Bleeding edge. Changes often. |

**Note on spec drift:** earlier versions of this document referenced a `latest-rc` dist-tag that does not exist. The Phase 1 implementation resolves "latest RC" via `next` → `latest` → **hard failure** (never a silent alpha fallback). The MD retains the historical reference for continuity; the code is authoritative.

**First run:** downloads the latest **Stable** and the latest **Alpha** (two versions, not three). RC is opt-in from the Version Manager — most users will never need it on day one.

**On-demand:** the user can download any specific version from the Version Manager, in the background, with progress indicators.

**Background caching:** periodic NPM registry polling (see §3.2 for cadence). New releases are pre-downloaded automatically, bounded by a user-configurable limit (default 10 versions).

**Populating the library:** `npm install --prefix <version-dir> --cache <data-dir>/.npm-cache --no-audit --no-fund @deepseek-ai/dsh@<exact>`, producing a self-contained, resolvable dependency tree per version.

- **Not** `npm pack` — the harness's dependency tree is not guaranteed flat.
- Path layout: `<data-dir>\versions\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js`.
- Switching repoints to that `bin.js`. No reinstall, no copy.
- **`--ignore-scripts` is deliberately NOT passed** — the harness needs its dependency postinstalls. This is a Phase 4 hardening decision to revisit if the threat model changes.

**npm spawn pattern (CVE-2024-27980):** since the fix, Node refuses to spawn `.cmd`/`.bat` without `shell: true`. We locate npm's CLI script and invoke it with our own Node: `node <npm-cli.js> install ...`. This avoids the shell entirely and removes PATH dependence. Resolution order: `$npm_execpath` → `npm-cli.js` next to the node binary → standard global locations.

**Storage management:** when the cache limit is exceeded, the launcher **prompts** the user — it never silently evicts. The user decides what to delete.

### 3.2. Update Mechanism

Two orthogonal axes of user control:

**Channel:** `Stable (latest)` / `RC (next)` / `Alpha (alpha)`.

**Behavior:**
- **Automatic** — silent background download and install.
- **Notify** — check on launch, tell the user, let them choose.
- **Manual** — only when the user clicks "Check for Updates."

**Plus:** version pinning to lock the launcher to a specific version.

**Background polling cadence:** at most once per **12 hours**, recorded as `lastUpdateCheck` in state. Always send `If-None-Match` with the stored ETag; on `304 Not Modified`, do nothing. Never poll on every launch.

**Minimum supported harness version:** a constant `MIN_SUPPORTED_DSH` in the sidecar. Still `"0.0.0"` after Phase 1 — the real value is derived in Phase 2 from install + first-boot + version switch verification. If a user pins or selects a version below it, allow it but warn once. Do not block. The user is sovereign.

### 3.3. Fast-Path Startup Sequence

The performance centerpiece:

1. Read preferred version from `settings.json`.
2. Check whether it is in the local library.
3. **Yes** → start the harness immediately (near-instant).
4. **No** → fall back to the latest downloaded version, or prompt to download the preferred one.
5. Only **after** the harness is up does the core silently check for and fetch new versions in the background (subject to §3.2 cadence).

**Critical property:** the network is never on the critical path of a startup. Cold first run (install + first boot) is the only exception — it is genuinely slow (~5 min install + ~45s cold boot), and that is the correct trade.

**Measured timings (Phase 1, from logs):**
- Cold install: ~5 min (372 MB / 518 packages)
- Warm boot (already installed): ~37s from spawn to URL
- Adopt (next launcher start): <1s

### 3.4. Version Manager UI

A table with columns **Version | Channel | Status | Action**.

| Version | Channel | Status | Action |
| :--- | :--- | :--- | :--- |
| 1.1.0-rc.2 | RC | **Active** | [Switch] |
| 1.1.0-rc.1 | RC | Downloaded | [Switch] [Delete] |
| 1.0.0 | Stable | Downloaded | [Switch] [Delete] |
| 1.0.0-alpha.5 | Alpha | Not Downloaded | [Download] |

- **Active** — currently running.
- **Downloaded** — in the library, instant switch.
- **Not Downloaded** — available on npm, offers `[Download]`.

(Phase 2/3 work; Phase 1 delivers a single hardcoded RC version.)

### 3.5. Launcher Self-Update

Distinct from harness updates. The **Tauri v2 Updater Plugin** updates *DSH-Dock itself* via GitHub Releases and a `latest.json` manifest. Silent, applies on next restart.

**Code signing:** out of scope for v1.0.0. Ship unsigned; document the SmartScreen and Gatekeeper prompts clearly in the README. Add a `SECURITY.md` note that releases are built by GitHub Actions from tagged commits, and publish checksums. Code signing is a post-1.0 item.

### 3.6. Control Surface (HTTP on the Sidecar)

The sidecar exposes three (plus one bonus) HTTP routes on its own loopback port. These are the frontend's only interface to the launcher's core logic. The frontend never talks HTTP to the sidecar directly — it goes through Tauri commands (`harness_status`, `harness_start`, `harness_stop`), which proxy to these routes. This avoids CORS and keeps the sidecar's port private to the Rust shell.

| Route | Method | Returns | Notes |
| :--- | :--- | :--- | :--- |
| `/harness/status` | GET | `{status, version, url, pid, startedAt, message, lastError, instanceId, logFile, launcherLog}` | Reads `runtime-state.json`, probes the URL to confirm liveness. |
| `/harness/start` | POST | `202 Accepted` with `{status: "starting"}` | **Never blocks.** Runs adopt → reap → resolve → install → spawn asynchronously. Progress via `/harness/status`. |
| `/harness/stop` | POST | `{status: "stopped"}` | Identity-checked. Never kills a foreign process. |
| `/harness/restart` | POST | `202 Accepted` | Stop + start. Convenience route. |

**Status states:** `stopped` | `starting` | `running` | `error`.

**Errors are first-class.** When start fails, `lastError` names the failing step (adopt / reap / resolve / install / spawn) and includes the tail of the relevant log file. No swallowed errors.

**`DSH_DOCK_START_ON_BOOT=1`** (env var) starts a harness as soon as the sidecar boots. Off by default. **Not wired to anything in Phase 1.** The env var exists as a hook for Phase 3, when the launcher's settings page can enable it.

### 3.7. Explicit Non-Goals for v1.0

- Modifying, patching, or forking the official harness.
- Touching anything inside `$DSH_HOME`.
- Telemetry of any kind.
- Cloud sync of settings or sessions.
- Non-official harness builds.

---

## 4. Development Plan — Phases and Milestones

| Phase | Duration | Target | Key Milestones |
| :--- | :--- | :--- | :--- |
| **Phase 0: Foundation** | ✅ Complete 2026-09-10 | Project scaffold and IPC proof. | 1. Tauri v2 + Svelte 5 + Vite + TS project builds. ✅ <br> 2. Node sidecar finds a free port and prints `SIDECAR_READY:<port>`. ✅ <br> 3. Tauri shell spawns sidecar, parses stdout, emits event. ✅ <br> 4. Frontend renders the real port. ✅ <br> 5. "Hello World" IPC round-trip proven (port 53245 rendered). ✅ |
| **Phase 1: MVP Core** | ✅ Complete 2026-09-13 | Install and run one hardcoded version; adopt/reap; embedded webview. | 1. Sidecar installs the latest RC (`next`) via `npm install --prefix`. ✅ <br> 2. Sidecar spawns the harness detached. ✅ <br> 3. Tauri window loads the harness URL. ✅ <br> 4. Basic shutdown + `runtime-state.json`. ✅ <br> 5. Adopt/reap logic for orphaned harnesses. ✅ <br> 6. Control surface (`/harness/status|start|stop`). ✅ <br> 7. Release build embeds frontend (`custom-protocol`). ✅ |
| **Phase 2: Version Library & Dynamic Port** | 3 weeks | Multi-version management. | 1. Library directory structure and install flow generalized. <br> 2. Multi-version download (on-demand + background). <br> 3. Version switching in the UI. <br> 4. Storage management prompts. <br> 5. `MIN_SUPPORTED_DSH` derived from evidence. <br> 6. Job Object for orphan prevention. |
| **Phase 3: Settings & Update UI** | 3 weeks | Full settings surface. | 1. Version Manager table UI. <br> 2. Update Preferences UI. <br> 3. Background check + notification system (12h cadence, ETag). <br> 4. Tauri v2 Updater integration. <br> 5. Channel selection and pinning. |
| **Phase 4: Polish & Release** | 2 weeks | v1.0.0. | 1. System tray integration. <br> 2. GitHub Actions cross-platform builds (`.exe`, `.dmg`, `.AppImage`). <br> 3. Bundled Node runtime packaging. <br> 4. User documentation + SECURITY.md. <br> 5. `--remap-path-prefix` to strip source paths from release binaries. <br> 6. v1.0.0 release. |

**Total estimated timeline: 11 weeks.**

### 4.1. Phase 0 Deliverables

Files created during Phase 0, all verified building:

**Root:** `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `.gitignore`

**`src/`** — Svelte 5 + Vite frontend: `index.html`, `main.ts`, `App.svelte`, `svelte.config.js`, `styles/global.css`

**`sidecar/`** — Node.js core (plain JS, system Node in dev): `index.js`, `package.json`, `lib/protocol.js`, `lib/service.js`, `lib/version-manager.js`, `lib/state.js`, `lib/registry.js`, `test/handshake.ps1`, `test/smoke.js`

**`src-tauri/`** — Tauri v2 Rust shell: `Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `NOTES.md`, `src/main.rs`, `src/lib.rs`, `capabilities/default.json`, `test/window-check.ps1`, `icons/` (17 desktop files)

### 4.2. Phase 1 Deliverables

**Root:** `.gitignore` (extended)

**`sidecar/lib/`** — new modules: `control.js` (HTTP control surface), `harness-install.js` (npm-based install), `harness-start.js` (detached spawn + readiness), `harness.js` (adopt/reap decision engine), `platform.js` (cross-platform process seam). Rewritten: `registry.js` (retries + ETag), `service.js` (router), `state.js` (data dir + token URL validation + log paths), `version-manager.js` (comment fix)

**`sidecar/test/`** — new: `control.js`, `control-live.js`, `harness.js`, `harness-install.js`, `harness-start.js`, `platform.js`, `registry.js`, `state.js`, `lib/check.js`, `lib/fake-npm.js`, `lib/noop-child.js`

**`src-tauri/`** — modified: `Cargo.toml` (features, ureq, tokio), `Cargo.lock`, `build.rs` (AppManifest), `capabilities/default.json` (6 commands), `src/lib.rs` (spawn, resolver, control proxy, harness window, logging, ~20 unit tests). New: `capabilities/harness.json`, `permissions/autogenerated/*.toml` (6 files, must be committed), `test/acceptance.ps1`, `test/console-check.ps1`, `test/console-probe.rs`, `test/manual-ui-check.ps1`

**`src/`** — modified: `App.svelte` (full dashboard). New: `lib/sidecar-connection.js` (retry policy), `test/sidecar-connection.test.js`

**Phase 1 verification:** sidecar suites 65 / 42 / 53 / 86 / 66 / 57 / 69, Rust 20/20, svelte-check 0/0, release build renders both windows with port 1420 free, adopt/reap verified end-to-end (harness survives launcher close, next launch adopts).

---

## 5. Repository Layout

**Important:** the repo root **is** the project root. There is no subfolder.

```
DSH-Launcher/                    <- repo root == project root
├── .github/
│   └── workflows/
│       └── release.yml          # Phase 4
├── .gitignore
├── LICENSE
├── README.md                    # Phase 4 (currently absent; old version retired)
├── SECURITY.md                  # Phase 4
│
├── docs/
│   ├── PROJECT_DSH-DOCK.md      # this file
│   └── assets/
│       └── icon.ico             # source for `cargo tauri icon`
│
├── src/                         # Tauri frontend — Svelte 5 + Vite + TS
│   ├── index.html
│   ├── main.ts
│   ├── App.svelte
│   ├── svelte.config.js         # MUST live in src/, not root
│   ├── lib/
│   │   └── sidecar-connection.js
│   ├── styles/
│   │   └── global.css
│   └── test/
│       └── sidecar-connection.test.js
│
├── src-tauri/                   # Tauri v2 Rust shell
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── capabilities/
│   │   ├── default.json         # main window: 6 commands
│   │   └── harness.json         # harness window: 0 commands, remote URL scope
│   ├── permissions/
│   │   └── autogenerated/       # Tauri-generated permission IDs (committed)
│   ├── test/
│   │   ├── acceptance.ps1
│   │   ├── console-check.ps1
│   │   ├── console-probe.rs
│   │   ├── manual-ui-check.ps1
│   │   └── window-check.ps1
│   ├── icons/                   # desktop set only (mobile deleted)
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── build.rs
│   ├── tauri.conf.json
│   └── NOTES.md                 # Phase 0 gotchas; see §2.7
│
├── sidecar/                     # Node.js core logic — plain JS
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
│       ├── state.js
│       ├── platform.js
│       ├── registry.js
│       ├── harness-install.js
│       ├── harness.js
│       ├── harness-start.js
│       ├── control.js
│       ├── control-live.js
│       └── lib/
│           ├── check.js
│           ├── fake-npm.js
│           └── noop-child.js
│
├── legacy/                      # old Windows-only PowerShell launcher
│   └── (preserved files, never referenced by the new project)
│
├── vite.config.ts
├── tsconfig.json
└── package.json                 # root workspace: frontend + sidecar
```

### 5.1. Workspace Layout Notes

- **npm workspaces.** The root `package.json` declares `"workspaces": ["sidecar"]` and `"private": true`. A single `npm install` at root installs both the frontend and sidecar dependencies.
- **`src/svelte.config.js`, not root.** `vite-plugin-svelte` resolves its config relative to Vite's `root`, which is `src/`.
- **`src-tauri/gen/` is gitignored.** Tauri regenerates it on every build.
- **`src-tauri/permissions/autogenerated/` is committed.** Tauri generates these from `build.rs`'s AppManifest; they must be in the repo.

### 5.2. About the `legacy/` Folder

The `legacy/` folder contains the **previous generation** of this project: a Windows-only launcher written in PowerShell. **It is historical reference only.** Do not read, import from, modify, or delete it.

---

## 6. Git and Repository Conventions

- Repo: `https://github.com/MIHassan3/DSH-Launcher`.
- Repo root **is** the project root. All git operations happen from here.
- `.gitignore` at repo root must exclude:
  - `node_modules/` (all levels)
  - `src-tauri/target/`
  - `src-tauri/gen/`
  - `src-tauri/binaries/*.exe` and `src-tauri/binaries/*.bin`
  - `dist/`
  - `*.log`
  - `.DS_Store`, `Thumbs.db`, `desktop.ini`
  - `.npm-cache/`, `.test-tmp/`

- **Path hazard:** the parent folder name contains a space (`GitHub online`). All build scripts, CI configs, and shell invocations must use proper quoting. Do not rename parent folders.

---

## 7. Recommendations for Development (Dev Guidance — Not Product Spec)

This section is for **us building DSH-Dock**. It is not a runtime dependency of the product. The product has zero dependency on any DSH plugin.

### 7.1. Model Settings

- **Model:** DeepSeek V4.1 Flash — Pro-level at lower cost, ideal for iterative development.
- **Modes:** Expert for architecture; Vision for UI mockups.

### 7.2. Useful Harness Plugins for Development

1. **`dsh-mcp-manage`** — GUI for enabling/disabling MCP servers without editing YAML.
2. **`dsh-claude-compat`** — folds existing `.claude/` rules and skills into sessions.
3. **`prompt-skill-armory`** — management panel for prompts, skills, and presets.

### 7.3. Development Tools

- **Node.js v22.19+ LTS** — required by the harness. Same version gets bundled in the shipped app.
- **Tauri v2 CLI** — `cargo install tauri-cli --version "^2"`.
- **Rust 1.84.0+** — verified with 1.98.1.
- **GitHub Actions** — for cross-platform CI in Phase 4.

### 7.4. Testing Discipline (Lessons from Phase 1)

**Acceptance testing must use the release binary.** Debug builds load from `devUrl` and mask bugs that only appear when the frontend is embedded. Phase 1 spent a full round debugging `ERR_CONNECTION_REFUSED` before realizing the release binary itself was broken by a missing `custom-protocol` feature.

**Verify on a clean VM.** The dev machine accumulates state (Vite servers, orphaned processes, WebView2 profiles) that hides bugs. A clean Windows VM with only Node and WebView2 installed is the ground truth.

**Three tiers of test, in order of value:**
1. **Live tests against the real harness** — they catch what stubs never will (e.g. the `npm.cmd EINVAL` bug, the harness log truncation).
2. **Integration tests against real processes and fixtures** — the adopt/reap identity checks, the control surface.
3. **Unit tests** — fast, but they can pass while the artifact on disk is broken.

---

## 8. Architectural Decisions Log

| # | Question | Decision |
| :--- | :--- | :--- |
| Q1 | Bundle Node or require it? | **Bundle** a portable Node v22.19+ LTS. Sidecar is plain JS. `pkg` and SEA are not used. |
| Q2 | Does `dsh web` accept a port? | **Yes** — `--host`, `--port`, `--no-open`. Verified against the shipped `startup.js`. |
| Q3 | What is "Stable (RC)"? | Real tags: `latest` (= RC today), `next` (newest RC), `alpha`. First run downloads Stable + Alpha. |
| Q4 | Frontend stack? | **Svelte 5 + Vite + TypeScript.** |
| Q5 | How to populate version library? | **`npm install --prefix`** into a per-version folder. Not `npm pack`. |
| Q6 | How to detect Active version? | **State file + liveness probe** on the recorded URL. |
| Q7 | Orphan / port hygiene? | **Adopt or reap at startup** (§2.3). |
| Q8 | Where does launcher state live? | **Per-OS conventions** (§2.4). `$DSH_HOME` passed through unchanged. |
| Q9 | Background polling cadence? | **Once per 12h**, ETag-aware. |
| Q10 | Code signing? | **Out of scope** for v1.0.0. |
| Q11 | Tauri version? | **v2.** |
| Q12 | Embedded webview or browser? | **Embedded Tauri webview.** |
| Q13 | Is §7 product spec? | **No** — dev guidance only. |
| Q14 | Minimum supported harness version? | **Define a constant**, warn below it, do not block. Still `"0.0.0"` pending Phase 2. |
| Q15 | Git strategy? | **Repo root = project root** (Option A). Legacy files in `legacy/`. |
| Q16 | IPC transport for the port? | **stdout one-line handshake** (`SIDECAR_READY:<port>`). Tauri commands for all later traffic. |
| Q17 | package.json ownership? | **npm workspaces.** Root owns frontend, `sidecar` is a workspace member. |
| Q18 | Sidecar source path? | Repo-root `sidecar/` always. Copied to `src-tauri/resources/` at package time (Phase 4). |
| Q19 | Dev Node vs bundled Node? | Dev uses system Node. Shipped bundle pins Node 22.x LTS in Phase 4. |
| Q20 | Icon source? | `docs/assets/icon.ico`, generated into `src-tauri/icons/`. Mobile icon sets deleted. |
| Q21 | IPv4 pinning? | **Mandatory.** Both `vite.config.ts` and `tauri.conf.json` use `127.0.0.1`. |
| Q22 | strictPort? | **Keep `true`.** Stale-dev-server footgun documented in §2.7. |
| Q23 | MIN_SUPPORTED_DSH? | Placeholder `"0.0.0"` in Phase 1. Real value derived in Phase 2. |
| Q24 | `custom-protocol` feature? | **Default-on.** `[features]` table must include `default = ["custom-protocol"]`. Without it, release builds load from `devUrl` and fail. |
| Q25 | Token-bearing URL? | **Stored verbatim** in `runtime-state.json`. A URL without `?token=` is invalid state. `port` is diagnostic-only. |
| Q26 | Harness log layout? | **Two files per instance:** `harness-<id>.log` (harness-owned, truncates itself) and `harness-<id>.launcher.log` (launcher-owned). Never merged. |
| Q27 | Control surface shape? | `GET/POST /harness/status|start|stop` (+ `restart`). `202` for accepted-async. `runtime-state.json` is the single source of truth. |
| Q28 | AppManifest for commands? | **Required in `build.rs`.** Tauri v2 does not auto-discover app commands; without an explicit manifest, capability grants fail to build. |
| Q29 | HTTP client for control proxy? | **`ureq` with `default-features = false`.** No TLS stack in a loopback-only launcher. |
| Q30 | Harness window capability? | Scopes `http://127.0.0.1:*` and grants **no commands**. Hostile page can call nothing. |
| Q31 | `DSH_DOCK_START_ON_BOOT`? | Env var exists, **not wired to anything in Phase 1**. Deferred to Phase 3. |
| Q32 | `restart` endpoint? | **Added in Phase 1** as a convenience route (stop + start). No new design. |
| Q33 | Console window prevention? | **`CREATE_NO_WINDOW` (`0x08000000`)** on both the sidecar spawn (Rust) and the harness spawn (sidecar JS). Verified with a control case in `console-check.ps1`. |
| Q34 | CDP diagnostic method? | **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`** env var. The Rust-side `additional_browser_args` API fails silently when two WebView2 environments share a user-data folder. |
| Q35 | Frontend startup retry? | Retry for up to 2s showing a neutral "Connecting..." state. Surface an error only after the budget is spent. Real failures (shell startup error, thrown invoke) are final. |

### 8.1. Deferred to Phase 2

- **Windows Job Object** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) for orphan prevention across both `node.exe` (sidecar + harness) and `msedgewebview2.exe` (launcher WebView2) process families.
- **`MIN_SUPPORTED_DSH` value** derived from real install + boot + switch testing.

### 8.2. Deferred to Phase 4

- **`--remap-path-prefix`** in release builds to strip source paths (privacy: the current binaries embed `C:\Users\<name>\...`).
- **Bundled Node runtime** as a Tauri resource.
- **Code signing / notarization** (post-1.0).
- **`--ignore-scripts`** revisit for install hardening.

---

## 9. Visual Identity (Forward-Looking)

- **Icon concept:** minimalist dock, pier, or anchor. A stylized "D" formed by a dock shape is acceptable.
- **Palette:**
  - Primary: Deep Blue `#1E3A5F`
  - Accent: Cyan `#00B4D8`
  - Background: Dark Charcoal `#1A1A1A`
  - Text: Off-White `#F0F0F0`
- **Typography:** Segoe UI (Windows), SF Pro (macOS), Inter (cross-platform web UI).

---

*End of document.*