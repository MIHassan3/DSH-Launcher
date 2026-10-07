# DSH-Dock: A Unified Framework for a Professional DeepSeek Harness Launcher

**Document Version:** 2.7.0
**Last Updated:** 2026-10-07
**Status:** Phase 2A complete (version library foundation, backend). Phase 2B next.

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

During Phase 1 (development), the sidecar runs on **system Node** — the bundled runtime is a Phase 4 packaging step.

### 2.2. Three Load-Bearing Architectural Decisions

**Dynamic Port Allocation.**
The harness accepts `--host`, `--port`, and `--no-open` flags (verified against the official package's `startup.js`). The Node sidecar binds to port `0`, the OS hands back a free port, and the sidecar passes that port to the Rust shell via a stdout handshake. This eliminates port conflicts entirely.

The harness prints its listening URL (`dsh web: http://127.0.0.1:<port>/?token=...`) to stdout once the plugin tree settles; the sidecar parses it, and the URL is stored verbatim (token intact) in `runtime-state.json`.

**Detached Background Process.**
The harness is started with `detached: true` + `unref()` so it survives the launcher UI closing. **Verified end-to-end**: closing the launcher leaves the harness serving; the next launch adopts it in milliseconds.

**System Tray Integration.**
Deferred until **after Phase 2/3**. The tray is an enhancement, not a primary surface — Linux support is fragmented (GNOME 40+ has no tray by default). The native menu bar (§2.8) is the primary in-app surface.

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

### 2.7. Development Environment Constraints (Discoveries from Phases 0, 1, and the Menu Bar Build)

These are non-obvious behaviors discovered during development. They must be respected throughout the project.

**IPv4 pinning is mandatory.** `vite.config.ts` sets `server.host: "127.0.0.1"` and `tauri.conf.json` sets `devUrl: "http://127.0.0.1:1420"`. Both must use the literal IPv4 address, never `"localhost"`. On Windows, Vite resolves `localhost` as IPv6 `[::1]` while WebView2 resolves it as IPv4 `127.0.0.1`, producing a blank window with no error.

**strictPort is a footgun.** `vite.config.ts` sets `strictPort: true`. If port 1420 is occupied, `beforeDevCommand` exits non-zero — but Tauri v2 still launches the binary, which then loads from a stale dev server left by a prior run.

**Port discovery on Windows.** `Get-NetTCPConnection -LocalPort` does not detect IPv6-only listeners. Use `netstat -ano` or an actual TCP connect.

**Orphaned dev processes.** Cancelling a `cargo tauri dev` job does not kill grandchild processes. Both `node.exe` (sidecars and harnesses) and `msedgewebview2.exe` processes survive job termination. **Phase 2A research (Step 3):** libuv creates a Windows Job Object per Node process with `KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`. Non-detached children join that job (the sidecar); detached children (the harness, spawned with `detached: true`) escape by design. **Consequence:** the sidecar already dies with the launcher, and the harness already survives — the orphans observed in testing were non-detached test children that the test kill didn't follow. **2D is now a "decide and document" step, not a "build native code" step.** See §8.1.

**`custom-protocol` feature is mandatory for release builds.** `src-tauri/Cargo.toml` must declare:

```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
default = ["custom-protocol"]
```

Without it, release binaries load from `devUrl` at runtime and fail with `ERR_CONNECTION_REFUSED`.

**Console window prevention.** A GUI-subsystem binary on Windows spawns console-subsystem children with a fresh console window unless `CREATE_NO_WINDOW` (`0x08000000`) is passed via `CommandExt::creation_flags`. This applies to **both** the Rust-side spawn of the sidecar and the sidecar's own spawn of the harness.

**WebView2 user-data folder sharing.** Two WebView2 environments sharing the same user-data folder cannot each pass their own `additional_browser_args` — the second environment fails silently. Workaround for diagnostics: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var.

**Harness log truncation during boot.** The harness rewrites `harness-<id>.log` itself during startup. Launcher diagnostics go in `harness-<id>.launcher.log`.

**NSIS custom templates are Handlebars-processed.** A custom `installer.nsi` referenced by `bundle.windows.nsis.template` is processed by Handlebars *before* NSIS sees it. Any literal double-brace sequence (`{{`) anywhere in the file — **including inside a comment** — will fail the bundler with a handlebars-syntax panic.

**NSIS install location and data location must differ.** The NSIS `currentUser` default is `$LOCALAPPDATA\${PRODUCTNAME}`, which collides with our data directory `%LOCALAPPDATA%\DSH-Dock\` if unmodified.

**Registry key `HKCU\Software\dshdock\DSH-Dock`.** The stock NSIS template reads this on install to restore a previous install location. We disable the restore call in our custom template.

**Hash reproducibility caveat.** Consecutive builds of identical source do **not** produce identical bytes on Windows. The release process hashes the *artifact that ships*.

**Silent NSIS installs skip the Start menu shortcut.** Expected behavior; interactive installs create the shortcut normally.

**Native menus cannot be partially modified via the builder API.** Tauri's `MenuBuilder` produces an immutable menu. Any structural state change requires rebuilding the entire menu and calling `set_menu()` again. However, **individual `MenuItem` handles support in-place `set_text` / `set_enabled` / `set_checked`** via muda — see §2.8.4.

**`Menu::get` searches direct children only.** `Menu::get(id)` in tauri 2.11.5 (`menu/menu.rs:363`) does `self.items()...find(|i| i.id() == &id)` — **direct children only**. An item nested inside a submenu (like `harness.status` inside the Harness submenu) cannot be found from the root menu. `Submenu::get` has identical semantics. A recursive walk is required to find deeply nested items by id.

**Low integrity labels block WebView2.** A `Low Mandatory Level` integrity label on the repo tree — inherited from a parent or applied by a sandbox tool — makes WebView2 refuse to initialize. Symptom: the window is created, painted briefly, then destroyed with no error; `window probe` reports no handle. Fix: `icacls <path> /setintegritylevel "(OI)(CI)M" /T /C`. A Low-integrity launching shell has the same effect on child processes. Check `icacls <path> | Select-String "Mandatory Label"` and `whoami /groups | Select-String "Mandatory Label"` before suspecting code.

### 2.8. Menu Bar Architecture

The primary in-app surface for quick actions and status is a **native menu bar** built with Tauri's built-in menu API. This is the only surface that works identically across Windows, macOS, and Linux without custom code.

#### 2.8.1. Cross-Platform Behavior

| Platform | Where the menu appears |
| :--- | :--- |
| Windows | Window frame menu bar (top of the harness window) |
| macOS | Global menu bar at the top of the screen |
| Linux | Window frame menu bar |

Tauri handles the platform-specific placement automatically when the menu is attached to a window. The **menu tree shape differs per platform** (§2.8.2), but the actions and their handlers are identical.

#### 2.8.2. Platform Shape

**Windows / Linux:**
```
Harness ▸
Dock ▸
  About DSH-Dock
Settings ▸
```

**macOS:** the first submenu becomes the application menu. Our shape:
```
DSH-Dock (app menu) ▸
  About DSH-Dock
  ─────
  Settings…
  ─────
  Hide DSH-Dock / Hide Others / Show All
  ─────
  Quit DSH-Dock
Harness ▸
Dock ▸
  (no About here — it lives in the app menu)
```

**Rule:** About appears exactly once per platform. Settings appears as a top-level menu on Windows/Linux, and inside the app menu on macOS. The Harness submenu is byte-identical across all three platforms.

#### 2.8.3. Attach and Rebuild

- `AppHandle::set_menu()` is app-wide. It assigns the menu to every existing window that has none, and windows created later inherit it at creation.
- Replacing the menu cleans the previous entry out of the menu stash — no unbounded growth.
- The menu is **immutable** at the Tauri builder level. Any structural change requires rebuilding and calling `set_menu` again.
- **Handlers must not block.** `on_menu_event` runs on the main thread; any I/O must move to a worker thread, and any UI work must marshal back via `run_on_main_thread`.
- **Rebuild vs update:** see §2.8.4.

#### 2.8.4. Rebuild vs Update — The Fast Path

Two menu-change mechanisms exist:

- **Full rebuild** — construct a fresh `Menu` from the current plan and call `set_menu`. Cost: ~37 ms on Windows (measured, release build). Used for **any structural change**: a checkbox toggles, the recent-versions list changes, the platform shape differs.
- **Status-label fast path** — an in-place `MenuItem::set_text` on the status label only. Cost: **0 ms measured**. Used when the *only* difference between the current plan and the last-installed plan is the status label's text.

The fast path's guard is a full plan comparison (`status_only_change`). It declines automatically on **any difference other than the status text**, including fields that don't exist yet — so when Phase 2 adds `recent_versions` updates, the fast path will route them to a full rebuild without any code change.

The status item is located by **recursive id walk** (`installed_item`), not by `Menu::get`, because the latter searches direct children only (§2.7). If the walk fails, the log names the id it wanted and every id present, and falls through to a full rebuild — never silently no-ops.

**Performance targets:**
- Steady-state status-label updates: **< 5 ms** (currently 0 ms).
- Structural rebuilds: informational; ~37 ms on Windows release is acceptable because they are rare and user-initiated.

#### 2.8.5. What the Menu Does Not Do

Native menus don't support text inputs, sliders, or dropdown selectors. Complex settings live in the control panel window.

### 2.9. Cross-Platform Surface Strategy

| Surface | Windows | macOS | Linux (KDE/XFCE) | Linux (stock GNOME 40+) |
| :--- | :--- | :--- | :--- | :--- |
| **Native menu bar** | ✅ | ✅ | ✅ | ✅ |
| Application menu entry | ✅ | ✅ | ✅ | ✅ |
| System tray icon | ✅ | ✅ | ✅ | ❌ (needs extension) |
| Tray left-click events | ✅ | ✅ | ❌ | ❌ |
| System notifications | ✅ | ✅ | ✅ | ✅ (daemon-dependent) |

**The durable anchors:** the native menu bar and the application menu entry.

**Design consequence:** the first-run experience and the settings window must be reachable without the tray.

---

## 3. Core Feature Specification

### 3.1. Version Management Library — the heart of the product

**Real npm dist-tags (verified 2026-10-02):**

| Channel | npm dist-tag | Current value | Notes |
| :--- | :--- | :--- | :--- |
| **Stable** | `latest` | `0.2.0-rc.2` | Default. Until the harness reaches 1.0, `latest` itself points at an RC. |
| **RC** | `next` | `0.2.0-rc.2` | Release candidate. Genuinely newest pre-release. |
| **Alpha** | `alpha` | `0.2.0-alpha.*` | Bleeding edge. Changes often. |

**Note on spec drift:** earlier versions of this document referenced a `latest-rc` dist-tag that does not exist. The implementation resolves "latest RC" via `next` → `latest` → **hard failure** (never a silent alpha fallback). The MD retains the historical reference for continuity; the code is authoritative.

**First run:** downloads exactly one version — the channel the user selected in the first-run wizard (`rc`, `alpha`, or `all`). No second version is pre-downloaded. Additional channels are opt-in from the Version Manager (Phase 2B).

**On-demand:** the user can download any specific version from the Version Manager, in the background, with progress indicators.

**Background caching:** periodic NPM registry polling (see §3.2). New releases are pre-downloaded automatically, bounded by a user-configurable limit (default 10 versions).

**Populating the library:** `npm install --prefix <version-dir> --cache <data-dir>/.npm-cache --no-audit --no-fund @deepseek-ai/dsh@<exact>`.

**Install staging (settled in Phase 2A):** the npm prefix is a sibling staging directory `<versions>/.staging-<version>-<nonce>`, not the final version directory. Validation runs against the staging tree; on success, an atomic rename lands it at `<versions>/<version>`. **Confirmed working with real npm on Windows.** The final path therefore only ever exists in a validated state. An in-place install with a `.incomplete` marker exists as an environmental fallback and is not the production path.

- Path layout: `<data-dir>\versions\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js`.
- Switching repoints to that `bin.js`. No reinstall, no copy.
- **`--ignore-scripts` is deliberately NOT passed** — the harness needs its dependency postinstalls.

**npm spawn pattern (CVE-2024-27980):** since the fix, Node refuses to spawn `.cmd`/`.bat` without `shell: true`. We locate npm's CLI script and invoke it with our own Node: `node <npm-cli.js> install ...`.

**Storage management:** when the cache limit is exceeded, the launcher **prompts** the user — it never silently evicts.

**Known failure mode:** a broken or partially-completed npm install produces a harness that crashes at boot with an opaque `ERR_MODULE_NOT_FOUND`. Phase 2 will add automatic validation.

### 3.2. Update Mechanism

**Auto-update policy — four options:**

| Option | Value in `settings.json` |
| :--- | :--- |
| **Stable only** | `"stable"` |
| **RC only** | `"rc"` |
| **Alpha only** | `"alpha"` |
| **All channels** | `"all"` |

Only one option is active at a time. When a channel has no release, the option is disabled in the menu.

**Plus:** version pinning (overrides auto-update for a specific version).

**Background polling cadence:** at most once per **12 hours**, recorded as `last_update_check`. `If-None-Match` with a stored ETag.

**Minimum supported harness version:** a constant `MIN_SUPPORTED_DSH` in the sidecar. Still `"0.0.0"` — the real value is derived in Phase 2.

### 3.3. Fast-Path Startup Sequence

1. Read preferred version from `settings.json`.
2. Check whether it is in the local library.
3. **Yes** → start the harness immediately (near-instant).
4. **No** → fall back to the latest downloaded version, or prompt to download the preferred one.
5. Only **after** the harness is up does the core silently check for new versions.

**Critical property:** the network is never on the critical path of a startup.

**Measured timings (v0.5.1):**
- Cold install: ~5 min (372 MB / 518 packages)
- Warm boot: ~37–70s from spawn to URL
- Adopt (next launcher start): <1s

### 3.4. Version Manager UI

A table with columns **Version | Channel | Status | Action**.

(Phase 2/3 work.)

### 3.5. Launcher Self-Update

Distinct from harness updates. The **Tauri v2 Updater Plugin** updates *DSH-Dock itself* via GitHub Releases and a `latest.json` manifest.

**Code signing:** out of scope for v1.0.0.

### 3.6. Control Surface (HTTP on the Sidecar)

| Route | Method | Returns |
| :--- | :--- | :--- |
| `/harness/status` | GET | `{status, version, url, pid, startedAt, message, lastError, instanceId, logFile, launcherLog}` |
| `/harness/start` | POST | `202 Accepted` — never blocks |
| `/harness/stop` | POST | `{status: "stopped"}` — identity-checked |
| `/harness/restart` | POST | `202 Accepted` — stop + start |

**Status states:** `stopped` | `starting` | `running` | `error`.

### 3.7. Installer Behavior (Windows)

NSIS, per-user (`installMode: "currentUser"`), custom template at `src-tauri/nsis/installer.nsi`. Two body changes: default install path and disabled restore-registry-location call.

### 3.8. Menu Content — Implemented Shape

The native menu bar has three top-level items on Windows/Linux (`Harness | Dock | Settings`) and a leading application menu on macOS (`DSH-Dock | Harness | Dock`).

#### Harness section

```
Harness ▸
├── ● {status} · v{version}                [disabled label, id: harness.status]
├── ─────────────
├── Restart Harness                        [action]
├── Stop Harness                           [action]
├── Open Logs Folder                       [action]
├── ─────────────
├── Auto-update ▸
│   ├── ○ Stable only                      [CheckMenuItem — disabled if no stable]
│   ├── ○ RC only                          [CheckMenuItem]
│   ├── ○ Alpha only                       [CheckMenuItem]
│   └── ○ All channels (newest)            [CheckMenuItem]
├── Recent Versions ▸                      [submenu]
│   ├── v0.1.5-rc.2 (installed)            [disabled label]
│   ├── … up to 5 recent versions
│   └── Show all versions…                 [disabled until Phase 2]
├── ─────────────
└── Harness Update                         [action]
```

**Status label** values: `● Running · v0.1.5-rc.2`, `● Stopped`, `● Starting…`, `● Error`.

#### Dock section

```
Dock ▸
├── Current version: 0.5.1                [disabled label]
├── ─────────────
├── Dock Update                            [action — placeholder until Phase 3]
├── Show Control Panel                     [action]
└── About DSH-Dock                         [os predefined: about — Windows/Linux only]
```

#### Settings

A top-level `Settings` submenu on Windows/Linux. On macOS, moved under the app menu.

#### Action Routing — Menu to Dashboard

All actionable menu items emit a `menu:action` event to the `main` window with a payload of `{ action: "start" | "stop" | "restart" | "refresh" | "open-logs" }`. The dashboard's `App.svelte` subscribes and dispatches to the same handlers its buttons call.

**Rule:** one implementation per action, reachable from two entry points. Menu handlers do **not** call the sidecar's HTTP routes directly; they route intent through the dashboard.

**Exception:** `open-logs` — the event is forwarded for consistency, but the shell reveals the folder itself because there is no dashboard state to keep in step.

**Undeliverable case:** if the dashboard window is closed when a menu action fires, the shell logs `menu: could not deliver '<action>' - the control panel is not open`. Phase 3.5.x will add a pending-action slot the dashboard drains on mount.

### 3.9. First-Run Experience — Implemented

On first launch — `settings.first_run_completed == false` — a small centered window titled "Welcome to DSH-Dock" appears, and the main window is hidden (not closed) behind it.

**Window:** `welcome` (label), inner size 500×300 logical, built at runtime by `welcome.rs`, not declared in `tauri.conf.json`. The app-wide menu bar is explicitly cleared on this window only and re-cleared after every structural rebuild, so it never carries `Harness | Dock | Settings`.

**Content:**
```
Welcome to DSH-Dock

Which harness channel would you like to track?

  ○ RC — release candidates (recommended)
  ○ Alpha — bleeding edge, changes often
  ○ All channels — always newest
  ○ Stable — not available yet              [disabled]

[ Install and Open Harness ]
```

**Behavior:**

- Choosing a channel and clicking **Install and Open Harness** writes `auto_update_channel` and `first_run_completed = true` in a single atomic call (`complete_first_run` in `settings.rs`).
- The hand-off closes the wizard with `window.destroy()`, **not** `window.close()`. In Tauri v2, `close()` emits `CloseRequested` — indistinguishable from a user X press — which our handler vetoes to run the dismissal path; using `close()` therefore caused a re-entrant loop. `destroy()` emits no events and cannot re-enter the handler. Pinned by a unit test (`the_wizard_is_destroyed_and_never_closed`).
- The dashboard is then shown / unminimized / focused, and an `install-and-open` event is emitted to `main`. The dashboard's listener routes it through its existing start flow: `stopped` → start; `starting` → wait for `running` then open the harness window; `running` → open immediately. No second implementation of "start."
- **Race tolerance:** if the dashboard's page has not finished loading when the event is emitted, the shell holds the intent and delivers on the next `page load finished`. The intent is cleared after successful emission. The `DSH_DOCK_AUTO_OPEN_HARNESS` diagnostic checks `harness_window_open` first, so it cannot conflict with the wizard path.
- Closing the wizard with the X button (or the "Skip for now" control) submits the default channel (`rc`) with `dismissed = true` and completes the first run. A first run cannot leave the user stuck with a wizard that reappears forever.
- If `complete_first_run` fails (unresolvable data dir), the wizard stays open with an inline error message — consistent with the "a failed write must not advance memory" invariant in `settings.rs`.

**Scope note:** the channel written by the wizard is recorded for Phase 2 to consume. In Pause 4 the sidecar does not yet read `auto_update_channel`, so "Install and Open Harness" installs the same version regardless of the choice. Recorded in `NOTES.md`.

**Diagnostic env var:** `DSH_DOCK_WELCOME_ACTION=rc|alpha|all|dismiss`, read in `setup`, fires the same `submit_and_hand_off` the button and the X use after a short delay. Used only for automated acceptance testing; unset by default. An unrecognised value is logged (`not recognised; ignoring`) and the wizard stays open — never a wrong-channel submit.

### 3.10. Update Notification

**Background flow:**

1. Launcher polls the npm registry (12h cadence, ETag-aware).
2. New version → download silently.
3. Show a system notification.
4. Click "Run now" → stop, start new version, reopen harness window.
5. Ignore → applies on next launcher start.

### 3.11. Settings Model — Single Source of Truth

Every launcher setting lives in exactly one file:

```
<data-dir>/settings.json
```

Current fields:
```json
{
  "auto_update_channel": "rc",
  "preferred_version": null,
  "cache_limit": 10,
  "last_update_check": null,
  "etag": null,
  "first_run_completed": false
}
```

Both the native menu bar and the web settings window read from and write to this file. Neither caches state across sessions. Whoever changes a setting last wins, and both surfaces reflect the current state on open.

**Two writers, with a Phase 2A convention.** Both the Rust shell and the Node sidecar write this file. Safeguards:
- Atomic replace (temp file + rename).
- Unknown-key preservation (fields the writer doesn't know about survive a rewrite).
- Single shared `data_dir()` resolver used by both the settings writer and `launcher_log_path()`.
- **Writer-ownership convention (finalized in Phase 2A):** the sidecar owns *its own* settings writes (update-check timestamps, ETag, cache-management state). The shell owns writes that originate from a UI action (channel selection, `first_run_completed`). Both writers use the same atomic-replace + unknown-key-preservation contract, so interleaved writes cannot corrupt the file. There is no single-owner lock — the write pattern is safe by construction.

### 3.12. Explicit Non-Goals for v1.0

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
| **Phase 1: MVP Core** | ✅ Complete 2026-09-13 | Install + run one hardcoded version; adopt/reap; embedded webview. | All milestones ✅. |
| **v0.5.0 release** | ✅ Complete 2026-09-13 | Public pre-release. | Published with known installer issues. |
| **v0.5.1 fix** | ✅ Complete 2026-09-14 | Installer packaging fix. | Sidecar bundled, install/data dirs separated, restore call disabled. |
| **Pause 3: Menu Bar + First-Run Wiring** | ✅ Complete 2026-10-02 | Native menu bar + settings plumbing + fast-path update. | 1. `menu.rs` with Harness/Dock/Settings. ✅ <br> 2. Menu items route to dashboard handlers. ✅ <br> 3. `settings.rs` with atomic writes + unknown-key preservation. ✅ <br> 4. Status-label fast path (0 ms vs 37 ms rebuild). ✅ <br> 5. Cross-platform verification (Windows only; macOS/Linux deferred). ✅ |
| **Pause 4: First-Run Wizard** | ✅ Complete 2026-10-03 | Welcome window + channel selection + install-and-open. | 1. `welcome.rs` + `Welcome.svelte`. ✅ <br> 2. `welcome_submit` command + capability. ✅ <br> 3. `install-and-open` event with pending-intent delivery. ✅ <br> 4. First-run gate in `setup`. ✅ <br> 5. Menu cleared on wizard window. ✅ <br> 6. Wizard destroyed via `destroy()` (not `close()`). ✅ <br> 7. Acceptance script `welcome-check.ps1` — 29/29. ✅ |
| **Phase 2: Version Library & Dynamic Port** | 3 weeks | Multi-version management. **Split into four sub-phases (2A–2D).** | **2A (Version Library Foundation, backend) — ✅ Complete 2026-10-07.** <br> **2B (Version Switch + Registry Routes + Minimal UI)** — next. <br> **2C (Background Updates + Storage Management)** — deferred. <br> **2D (Job Object + Hardening)** — reframed to "decide and document" per the libuv finding; see §8.1. |
| **Phase 3: Settings & Update UI** | 3 weeks | Full settings surface. | 1. Version Manager table UI. <br> 2. Update Preferences UI. <br> 3. Background check + notification system. <br> 4. Tauri v2 Updater integration. <br> 5. Channel selection and pinning UI. |
| **Phase 4: Polish & Release** | 2 weeks | v1.0.0. | 1. System tray. <br> 2. Cross-platform builds. <br> 3. Bundled Node runtime. <br> 4. Docs + SECURITY.md. <br> 5. `--remap-path-prefix`. <br> 6. v1.0.0 release. |

**Total estimated timeline: ~12 weeks.**

### 4.1. Pause 3 Deliverables

**New:**
- `src-tauri/src/menu.rs` — plan/adapter split, `MenuState`, `MenuPlan`, `MenuAction`, recursive `installed_item`, fast-path `set_text` update, action dispatch to dashboard.
- `src-tauri/src/settings.rs` — `Settings` struct, atomic I/O, unknown-key preservation, `first_run_completed`, `complete_first_run`, `validate_channel`, shared `data_dir()` resolver.

**Modified:**
- `src-tauri/src/lib.rs` — `mod menu`, `mod settings`, `manage(MenuRuntime)`, `manage(SettingsState)`, initial rebuild, status watcher, `on_menu_event` wiring, `menu:action` emission.
- `src/App.svelte` — `menu:action` listener, `restartHarness`, `runMenuAction` routing to existing handlers.
- `src-tauri/NOTES.md` — menu architecture, the fast path, the low-integrity WebView2 failure signature, all diagnostics.

**Verified:** 130 Rust tests, clippy clean, `svelte-check` 0/0. Fast-path status updates 0 ms (was 23 ms median). Menu label visibly retitles on screen.

### 4.2. Pause 4 Deliverables

**New:**
- `src-tauri/src/welcome.rs` — wizard window construction, first-run gate decision (`gate_decision`), the atomic hand-off (`submit_and_hand_off`), the X-dismiss handler, `WizardOption` data, `parse_welcome_action` env var parser.
- `src/lib/Welcome.svelte` — the wizard UI (radio group, Install and Open button, Skip for now, inline error area, busy state).
- `src-tauri/capabilities/welcome.json` — grants exactly `core:default` + `allow-welcome-submit` to the `welcome` window.
- `src-tauri/permissions/autogenerated/welcome_submit.toml` — build-generated; declared in `build.rs`'s AppManifest command list.
- `src-tauri/test/welcome-check.ps1` — the four-case acceptance script (unset / rc-like / dismiss / invalid-env).

**Modified:**
- `src-tauri/build.rs` — `welcome_submit` added to the explicit `AppManifest::commands([…])` list (Tauri v2 does not auto-discover).
- `src-tauri/src/lib.rs` — `pub mod welcome;`, `welcome_submit` in `invoke_handler`, first-run gate in `setup`, close-request handler for the `welcome` window, `install-and-open` delivery hook.
- `src-tauri/src/menu.rs` — clear the app-wide menu on the `welcome` window after every rebuild while the window exists.
- `src/App.svelte` — `{#if windowLabel !== "main"}<Welcome />{:else}…{/if}` branch; `onMount` returns immediately when the window is not `main`; `install-and-open` listener routing through the existing start flow.
- `src-tauri/NOTES.md` — wizard section: the gate, the destroy-vs-close rationale, the pending-intent delivery, the capability surface, the `DSH_DOCK_WELCOME_ACTION` diagnostic.

**Verified:** `cargo test` 161/161, clippy clean, `svelte-check` 0/0. Acceptance script 29/29. X-button dismissal verified by hand.

### 4.3. Phase 2A Deliverables — Version Library Foundation (Backend)

**New:**
- `sidecar/lib/library.js` — version library abstraction: enumeration, containment (`isPathInsideVersions`), `isVersionDirName`, `resolvesToSamePath`, `planDelete`, `deleteVersion`, `deletePartialVersion`, `selectVersionsToDelete`.
- `sidecar/lib/catalogue.js` — launcher-owned advisory catalogue (`<versions>/catalogue.json`). Wrapper-object schema (`{schemaVersion, updatedAt, versions}`), `readCatalogue`, `writeCatalogue` (temp + rename), `recordInstall`, `removeEntry`, `catalogueHealth`, `checksumFor`. Corrupt catalogues are quarantined to `.corrupt-<timestamp>`, never deleted.
- `sidecar/lib/validation.js` — `validateInstallTree(installDir, {checkMarker})`, structured `{ok, problems: [{code, path, detail}]}` with distinct codes: `bin-missing`, `dsh-package-missing`, `web-app-missing`, `package-json-unreadable`.
- `sidecar/lib/library-lock.js` — `<versions>/.lock` via `fs.openSync(..., "wx")`. Stale after 10 min. Released in `finally`. Serializes library mutations (install, delete).
- Test suites: `sidecar/test/library.js`, `catalogue.js`, `install-flow.js`, `library-delete.js`, `library-select.js`, `library-live.js`, plus `library-probe.js` (a probe script, not a counted suite).

**Modified:**
- `sidecar/lib/harness-install.js` — parameterized `installVersion(version, opts)`; staged-rename install with in-place fallback; force-reinstall moves the old tree aside and restores on failure; `runNpm`'s `env` option now merged over `process.env` (was silently dropped); `isSafeVersionName` tightened to reject dist-tags and ranges.
- `sidecar/test/harness-install.js` — updated for the new install flags.
- `sidecar/test/lib/fake-npm.js` — extended for the staged-rename flow.
- `src-tauri/NOTES.md` — Phase 2A section (12 subsections, 587→706 lines).

**Verified:**
- 1100/1100 offline checks across 11 suites.
- 42/42 live checks against real npm — `0.2.0-rc.1` (161.9 s) and `0.2.0-rc.2` (63.9 s, warm cache) installed into a `%TEMP%` data dir.
- **`approach: "staged"` for both live installs.** The `--prefix` staging question is settled: real npm on Windows populates the sibling staging prefix, validation passes there, and the atomic rename lands. The in-place fallback stays an environmental safety net and does not become the production path.
- Force-install of the running version refuses with a specific error; the target tree byte-identical before and after.
- Cross-process lock acquisition verified for both install and delete.

---

## 5. Repository Layout

```
DSH-Launcher/
├── docs/
│   ├── PROJECT_DSH-DOCK.md
│   └── assets/
├── scripts/stage-sidecar.mjs
├── src/
│   ├── index.html
│   ├── main.ts
│   ├── App.svelte              # menu:action + install-and-open listeners, dashboard
│   ├── svelte.config.js
│   ├── lib/
│   │   ├── sidecar-connection.js
│   │   └── Welcome.svelte      # first-run wizard UI
│   └── test/sidecar-connection.test.js
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs               # wiring, watcher, commands
│   │   ├── menu.rs              # menu plan/adapter/fast path
│   │   ├── settings.rs          # settings model
│   │   └── welcome.rs           # first-run wizard + gate + hand-off
│   ├── nsis/installer.nsi
│   ├── capabilities/default.json + harness.json + welcome.json
│   ├── permissions/autogenerated/
│   ├── test/                    # acceptance.ps1, packaging-check.ps1, etc.
│   ├── icons/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── NOTES.md
├── sidecar/
│   ├── lib/
│   │   ├── catalogue.js         # launcher-owned advisory catalogue
│   │   ├── harness-install.js   # parameterized install + staged rename
│   │   ├── library-lock.js      # <versions>/.lock
│   │   ├── library.js           # version library abstraction
│   │   └── validation.js        # install-tree validation
│   └── test/                    # 11 offline suites + library-live.js + library-probe.js
├── legacy/
└── package.json
```

---

## 6. Git and Repository Conventions

- Repo: `https://github.com/MIHassan3/DSH-Launcher`.
- `.gitignore` at repo root excludes: `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `dist/`, `*.log`, `desktop.ini`, `.npm-cache/`, `.test-tmp/`.
- **Path hazard:** parent folder name contains a space. Quote everything.
- **Hash reproducibility:** Windows builds are not byte-reproducible. Hash the shipped artifact.

---

## 7. Recommendations for Development

### 7.1. Model Settings

- **Model:** DeepSeek V4.1 Flash.

### 7.2. Useful Harness Plugins

- `dsh-mcp-manage`, `dsh-claude-compat`, `prompt-skill-armory`.

### 7.3. Development Tools

- **Node.js v22.19+ LTS**, **Tauri v2 CLI**, **Rust 1.84.0+**, **GitHub Actions** (Phase 4).

### 7.4. Testing Discipline

**Acceptance testing must use the release binary with no dev server running.** Debug builds load from `devUrl` and mask bugs.

**Every release must be tested from the actual installed artifact.**

**Verify on a clean VM.**

**Three tiers of test:** live tests against the real harness → integration tests against real processes → unit tests.

**Packaging regression gate.** `src-tauri/test/packaging-check.ps1` runs after `cargo tauri build` and before publishing.

**Performance targets — two distinct cases:**
- **Steady-state status-label updates:** < 5 ms. Currently **0 ms** (in-place `MenuItem::set_text`).
- **Structural rebuilds:** informational only (~37 ms on Windows release). These are rare and user-initiated (channel checkbox, recent-versions list changes). Not a target.

**Session hygiene for DSH.** Very large sessions cause stream idle timeouts. Start fresh sessions per major phase or per focused fix.

**Do not run destructive tests inside a session that depends on the target.**

**If a fresh build renders no window AND `window probe` reports no handle, suspect integrity before code.** Check `icacls <path>` for a `Low Mandatory Level` label. Fix: `icacls <path> /setintegritylevel "(OI)(CI)M" /T /C`.

**Menu builder API is immutable; individual items are not.** Structural change requires full rebuild + `set_menu`. Pure text/enable/check change can use in-place `MenuItem::set_text` / `set_enabled` / `set_checked`.

**Tauri's `window.close()` emits `CloseRequested`.** It is indistinguishable from a user X press. If a `CloseRequested` handler vetoes with `prevent_close()`, a programmatic `close()` will be vetoed too, and any code path that then re-issues the close will loop inside the event loop with no visible failure. Programmatic window dismissal from inside our own code must use `window.destroy()`, which emits no events. The `welcome.rs` hand-off and X handler are the reference implementation: `destroy()` for the hand-off, `close()`-vetoed for the X. Pinned by `the_wizard_is_destroyed_and_never_closed`.

---

## 8. Architectural Decisions Log

| # | Question | Decision |
| :--- | :--- | :--- |
| Q1–Q55 | (See v2.4.0 history) | — |
| Q56 | Menu-change mechanism? | **Two paths.** Full rebuild for structural change; in-place `set_text` fast path for status-label-only changes. The fast path's guard is a full plan comparison, so it declines automatically on any future difference. |
| Q57 | Menu item lookup by id? | **Recursive walk** (`installed_item`), not `Menu::get` — the latter searches direct children only (tauri 2.11.5 `menu/menu.rs:363`). |
| Q58 | Menu action routing? | Menu items emit `menu:action` to `main`; the dashboard dispatches to its own handlers. One implementation per action, two entry points. `open-logs` is the sole exception (shell reveals the folder). |
| Q59 | `installed_ids` diagnostic? | **Kept permanently.** Runs only on the fast-path failure branch. Names the id wanted and every id present. |
| Q60 | Low-integrity WebView2 failure? | Environmental, not code. Fixed by `icacls /setintegritylevel "(OI)(CI)M" /T /C`. Documented in §2.7 and NOTES.md. |
| Q61 | `first_run_completed`? | Added to `settings.json` schema. Written together with channel in one `complete_first_run` call. |
| Q62 | Wizard close mechanism? | **`window.destroy()`**, not `window.close()`. Tauri's `close()` emits `CloseRequested` (indistinguishable from user X), which our handler vetoes; using `close()` caused a re-entrant loop. `destroy()` emits no events. Pinned by test. |
| Q63 | Wizard submit endpoint? | One function, `submit_and_hand_off`, used by the button, the X-dismiss handler, and the diagnostic env var. Never two implementations. |
| Q64 | `DSH_DOCK_WELCOME_ACTION` env var? | Diagnostic-only, in the same family as `DSH_DOCK_AUTO_OPEN_HARNESS` and `DSH_DOCK_MENU_POLL_MS`. Fires the same submit path with a delay; unset by default; unrecognised values are ignored with a log line — never a wrong-channel submit. |
| Q65 | `install-and-open` race? | **Pending-intent delivery.** Shell marks the intent before showing main; if main's page already loaded, emits immediately; else delivers on next `page load finished`. Intent cleared after emission. No new command, no new capability. |
| Q66 | Menu on the wizard window? | **Cleared at creation** and **re-cleared after every structural rebuild** while the window exists. Guarded in `menu.rs::rebuild_menu`. |
| Q67 | Catalogue authority? | **Advisory only.** Filesystem enumeration is ground truth; the catalogue accelerates ordering and accounting. Missing or unparseable catalogue degrades to filesystem-only enumeration. `installDir` stored relative to library root; the authoritative path is derived from the validated version name. |
| Q68 | Staged install vs. in-place? | **Staged.** npm prefix into `<versions>/.staging-<version>-<nonce>`; validate; atomic rename to `<versions>/<version>`. Confirmed working with real npm on Windows (Phase 2A Step 5). In-place with `.incomplete` marker remains a fallback and is not the production path. |
| Q69 | `.incomplete` marker semantics? | **Fallback-only.** Written before npm runs, deleted after validation succeeds. `listInstalledVersions` treats any directory containing `.incomplete` as `partial` regardless of `bin.js`. `validateInstallTree` has a `checkMarker` mode flag: `true` for enumeration (complete *and* finished?), `false` for the installer (complete?). |
| Q70 | Running-version force-install guard? | **Refuse before any write.** Shared path-identity check (`resolvesToSamePath`) between install-with-force and delete. Fail-fast message: `Refusing to overwrite the running version <V>; stop the harness or choose another version.` Target tree byte-identical before and after a refused operation. |
| Q71 | Cross-module rule pinning? | **Any rule stated in two modules must be pinned by a test that compares them, not by tests that check each in isolation.** Established after `isSafeVersionName` (Step 3) and `isVersionDirName` (Step 4) drifted. Applies beyond the version-name case. |
| Q72 | libuv Job Object finding? | **Recorded.** libuv creates a Windows Job Object per Node process with `KILL_ON_JOB_CLOSE \| SILENT_BREAKAWAY_OK`. Non-detached children join (sidecar); detached children escape (harness). The harness's survival across launcher death is by design. 2D is reframed from "build a Job Object" to "decide and document what happens to a force-killed launcher's detached harness." |

### 8.1. Phase 2 Deferred Items — Status After 2A

**Completed in 2A:**
- **Install tree validation** after `npm install` — `validation.js` plus the staged-rename install path.
- **Settings-file writer ownership** — finalized: sidecar owns its own writes, shell owns UI-originated writes; atomic-replace + unknown-key-preservation make interleaving safe (see §3.11).

**Still open — moved to 2B:**
- **`MIN_SUPPORTED_DSH`** — value to be set from real install + boot + **switch** testing. 2A's live install produced the evidence base (two versions coexist, both validated); 2B's switch operation produces the final evidence.
- **`isInstalled` → `isInstalledAndValid` rewire** — deferred from 2A. One caller today (`control.js`'s start path). The rewire belongs where the switch flow can test it end-to-end.
- **Recent Versions submenu population** — up to 5 recent versions by date, plus "Show all versions…" (`SHOW_ALL_VERSIONS_ENABLED`).

**Still open — moved to 2C:**
- **Sidecar "no port" flash** — retry budget extension.
- **Background version check** (12h cadence, ETag-aware).
- **Storage management prompts** and `cache_limit` enforcement.
- **Menu rebuilt after wizard dismissal** — inherits the §2.8.4 fast-path work automatically.

**Still open — moved to 2D:**
- **Windows Job Object** — reframed from "build native code" to "decide and document" after the Phase 2A Step 3 libuv finding. The sidecar already dies with the launcher's libuv job; the harness already escapes via `SILENT_BREAKAWAY_OK` and survives by design. **The 2D question is:** what should happen to a detached harness when the launcher is force-killed? The current behavior (adopt/reap on next launch, §2.3) is arguably correct. 2D's deliverable is to **decide**, **document**, and **add a test** proving the launcher's force-kill does not orphan the sidecar.

### 8.2. Deferred to Phase 3.5.x

- **Undeliverable-action slot** — dashboard closed, menu action fired. Pending-action queue the dashboard drains on mount. Requires a new command + capability entry.
- **Fast-path `set_text` for other menu items** if Phase 3 introduces more text-only updates.

### 8.3. Deferred to Phase 4

- **`--remap-path-prefix`**, **bundled Node runtime**, **MSI installer**, **code signing**.

### 8.4. Deferred to Phase 5 / Post-1.0 — Harness-First Launch

**Current behavior:** launching DSH-Dock opens the dashboard window; the user clicks Start, then Open Harness, then closes the dashboard. Friction for the common case.

**Target behavior:**
1. User launches DSH-Dock.
2. First run → wizard appears → harness starts.
3. Subsequent runs → the harness window opens directly (starting the harness if not already running). The dashboard is **not shown** on the common path.
4. The dashboard becomes an "advanced" surface — reachable via a menu item ("Show Control Panel"), tray icon (Phase 4), or keyboard shortcut.

**What this requires before it can ship:**
- The menu bar needs the dashboard's remaining buttons: **Start**, **Open Harness**, **Close Harness Window**, **Refresh**. The current menu has Restart, Stop, Open Logs — but not these four.
- A new setting `launch_behavior: "harness" | "dashboard"` (default `"harness"`).
- The tray icon (Phase 4) becomes the "always-present" access point for the dashboard.
- The dashboard may eventually become a modal or side panel opened on demand, rather than a first-class window.

**Rationale:** recorded here so Phase 3 and Phase 4 design decisions respect it. Not a Phase 2 concern — it does not affect 2A's backend work or 2B's version-switching scope.

---

## 9. Visual Identity

- **Icon:** `docs/assets/icon.ico`.
- **Palette:** Deep Blue `#1E3A5F`, Cyan `#00B4D8`, Dark Charcoal `#1A1A1A`, Off-White `#F0F0F0`.
- **Typography:** Segoe UI (Windows), SF Pro (macOS), Inter (cross-platform web UI).

---

*End of document.*
