# DSH-Dock: A Unified Framework for a Professional DeepSeek Harness Launcher

**Document Version:** 2.1.0
**Last Updated:** 2026-09-10
**Status:** Phase 0 complete — Phase 1 ready to begin

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

### 2.2. Three Load-Bearing Architectural Decisions

**Dynamic Port Allocation.**
The harness accepts `--host`, `--port`, and `--no-open` flags (verified against a working reference implementation). The Node sidecar binds to port `0`, the OS hands back a free port, and the sidecar passes that port to the Rust shell via IPC. This eliminates port conflicts entirely — including against a user's own `dsh web` instance.

The harness prints its listening URL to stdout once the plugin tree settles; the sidecar parses it.

**Detached Background Process.**
The harness is started with `detached: true` + `unref()` so it survives the launcher UI closing. This is what makes subsequent launches instant — the server is often already up.

**System Tray Integration.**
Quick access, live status, graceful shutdown.

### 2.3. Detecting and Adopting a Running Harness

Launcher state lives in `runtime-state.json`:

```json
{ "pid": 12345, "port": 54321, "version": "1.2.0", "startedAt": "...", "url": "http://127.0.0.1:54321" }
```

At every launcher start, before spawning anything, the core:

1. Reads `runtime-state.json`.
2. If PID alive **and** port responsive → **adopt** it (open the window at that URL).
3. If PID alive **but** port dead → kill it, then start fresh.
4. If PID dead → clean state file, start fresh.

This is what makes the "fast path" actually fast.

### 2.4. State Directory (Per-OS)

| OS | Launcher data directory |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\DSH-Dock\` |
| macOS   | `~/Library/Application Support/DSH-Dock/` |
| Linux   | `$XDG_DATA_HOME/dsh-dock/` (default `~/.local/share/dsh-dock/`) |

Contents: `settings.json`, `runtime-state.json`, `versions/`, `logs/`, `cache/`.

**`$DSH_HOME` handling:** if the user has set it, we pass it through to the harness environment unchanged. We never read, write, or cache anything inside it. If unset, we pass nothing and the harness uses its own default.

### 2.5. Frontend Stack

**Svelte 5 + Vite + TypeScript.** Smallest bundle for a Tauri webview, no virtual-DOM overhead, excellent TS support, small enough to read end-to-end during debugging.

### 2.6. Embedded Webview (Not Browser Hand-off)

The harness UI loads inside the Tauri webview at `http://127.0.0.1:<port>`. Handing off to the system browser would defeat the purpose of a native-feeling launcher. If we hit compatibility problems with WebView2 / WKWebView / WebKitGTK, we revisit.

### 2.7. Development Environment Constraints (Discoveries from Phase 0)

These are non-obvious behaviors discovered while building Phase 0. They must be respected throughout the project.

**IPv4 pinning is mandatory.** `vite.config.ts` sets `server.host: "127.0.0.1"` and `tauri.conf.json` sets `devUrl: "http://127.0.0.1:1420"`. Both must use the literal IPv4 address, never `"localhost"`. On Windows, Vite resolves `localhost` as IPv6 `[::1]` while WebView2 resolves it as IPv4 `127.0.0.1`, producing a blank window with no error. This was found and fixed during Phase 0.

**strictPort is a footgun.** `vite.config.ts` sets `strictPort: true`. If port 1420 is occupied, `beforeDevCommand` exits non-zero — but Tauri v2 still launches the binary, which then loads from a stale dev server left by a prior run. See `src-tauri/NOTES.md`. Resolution is a Phase 3/4 item.

**Port discovery on Windows.** `Get-NetTCPConnection -LocalPort` does not detect IPv6-only listeners. Phase 1's port checks must use `netstat -ano` or an actual TCP connect, not that cmdlet.

**Orphaned dev processes.** Cancelling a `cargo tauri dev` job does not kill grandchild processes. `dsh-dock.exe` and Vite both survived job termination during Phase 0 and had to be killed manually. Phase 1's adopt/reap logic (§2.3) is the project's answer to this.

---

## 3. Core Feature Specification

### 3.1. Version Management Library — the heart of the product

**Three npm dist-tags, three channels:**

| Channel | npm dist-tag | Notes |
| :--- | :--- | :--- |
| **Stable** | `latest` | Default. What DeepSeek marks as ready. |
| **RC** | `latest-rc` | Release candidate. Opt-in from Version Manager. |
| **Alpha** | `alpha` | Bleeding edge. Changes often. |

**First run:** downloads the latest **Stable** and the latest **Alpha** (two versions, not three). RC is opt-in from the Version Manager — most users will never need it on day one.

**On-demand:** the user can download any specific version from the Version Manager, in the background, with progress indicators.

**Background caching:** periodic NPM registry polling (see §3.2 for cadence). New releases are pre-downloaded automatically, bounded by a user-configurable limit (default 10 versions).

**Populating the library:** `npm install --prefix <version-dir> @deepseek-ai/dsh@<version>`, producing a self-contained, resolvable dependency tree per version.

- **Not** `npm pack` — the harness's dependency tree is not guaranteed flat, and `npm pack` only gives the tarball, not its deps.
- Path layout: `<launcher-data>\versions\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js`.
- Switching repoints to that `bin.js`. No reinstall, no copy.

**Storage management:** when the cache limit is exceeded, the launcher **prompts** the user — it never silently evicts. The user decides what to delete.

### 3.2. Update Mechanism

Two orthogonal axes of user control:

**Channel:** `Stable (latest)` / `RC (latest-rc)` / `Alpha (alpha)` — the npm dist-tag to track.

**Behavior:**
- **Automatic** — silent background download and install.
- **Notify** — check on launch, tell the user, let them choose.
- **Manual** — only when the user clicks "Check for Updates."

**Plus:** version pinning to lock the launcher to a specific version.

**Background polling cadence:** at most once per **12 hours**, recorded as `lastUpdateCheck` in state. Always send `If-None-Match` with the stored ETag; on `304 Not Modified`, do nothing. Never poll on every launch. Never faster than 12h regardless of user settings.

**Minimum supported harness version:** a constant `MIN_SUPPORTED_DSH` in the sidecar. Placeholder value `"0.0.0"` in Phase 0; real value set in Phase 1 after querying the registry. If a user pins or selects a version below it, allow it but warn once: *"This version predates DSH-Dock's support window; launch may fail."* Do not block. The user is sovereign.

### 3.3. Fast-Path Startup Sequence

The performance centerpiece:

1. Read preferred version from `settings.json`.
2. Check whether it is in the local library.
3. **Yes** → start the harness immediately (near-instant).
4. **No** → fall back to the latest downloaded version, or prompt to download the preferred one.
5. Only **after** the harness is up does the core silently check for and fetch new versions in the background (subject to §3.2 cadence).

**Critical property:** the network is never on the critical path of a startup.

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

### 3.5. Launcher Self-Update

Distinct from harness updates. The **Tauri v2 Updater Plugin** updates *DSH-Dock itself* via GitHub Releases and a `latest.json` manifest. Silent, applies on next restart.

**Code signing:** out of scope for v1.0.0. Ship unsigned; document the SmartScreen and Gatekeeper prompts clearly in the README. Add a `SECURITY.md` note that releases are built by GitHub Actions from tagged commits, and publish checksums. Code signing is a post-1.0 item.

### 3.6. Explicit Non-Goals for v1.0

- Modifying, patching, or forking the official harness.
- Touching anything inside `$DSH_HOME`.
- Telemetry of any kind.
- Cloud sync of settings or sessions.
- Non-official harness builds.

---

## 4. Development Plan — Phases and Milestones

| Phase | Duration | Target | Key Milestones |
| :--- | :--- | :--- | :--- |
| **Phase 0: Foundation** | ✅ Complete 2026-09-10 | Project scaffold and IPC proof. | 1. Tauri v2 + Svelte 5 + Vite + TS project builds. ✅ <br> 2. Node sidecar (plain JS) finds a free port and prints `SIDECAR_READY:<port>`. ✅ <br> 3. Tauri shell spawns sidecar, parses stdout, emits event. ✅ <br> 4. Frontend renders the real port. ✅ <br> 5. "Hello World" IPC round-trip proven (port 53245 rendered in the window). ✅ |
| **Phase 1: MVP Core** | 2 weeks | Install and run one hardcoded version. | 1. Sidecar installs the latest RC via `npm install --prefix`. <br> 2. Sidecar spawns the harness detached. <br> 3. Tauri window loads the harness URL. <br> 4. Basic shutdown + state file. <br> 5. Adopt/reap logic for orphaned harnesses. |
| **Phase 2: Version Library & Dynamic Port** | 3 weeks | Multi-version management. | 1. Library directory structure and install flow finalized. <br> 2. Multi-version download (on-demand + background). <br> 3. Dynamic port allocation verified end-to-end. <br> 4. UI can switch versions. <br> 5. Storage management prompts. |
| **Phase 3: Settings & Update UI** | 3 weeks | Full settings surface. | 1. Version Manager table UI. <br> 2. Update Preferences UI. <br> 3. Background check + notification system (12h cadence, ETag). <br> 4. Tauri v2 Updater integration. <br> 5. Channel selection and pinning. |
| **Phase 4: Polish & Release** | 2 weeks | v1.0.0. | 1. System tray integration. <br> 2. GitHub Actions cross-platform builds (`.exe`, `.dmg`, `.AppImage`). <br> 3. Bundled Node runtime packaging. <br> 4. User documentation + SECURITY.md. <br> 5. v1.0.0 release. |

**Total estimated timeline: 11 weeks.**

### 4.1. Phase 0 Deliverables

Files created during Phase 0, all verified building:

**Root:** `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `.gitignore`

**`src/`** — Svelte 5 + Vite frontend: `index.html`, `main.ts`, `App.svelte`, `svelte.config.js`, `styles/global.css`

**`sidecar/`** — Node.js core (plain JS, system Node in dev): `index.js`, `package.json`, `lib/protocol.js`, `lib/service.js`, `lib/version-manager.js`, `lib/state.js`, `lib/registry.js`, `test/handshake.ps1`, `test/smoke.js`

**`src-tauri/`** — Tauri v2 Rust shell: `Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `NOTES.md`, `src/main.rs`, `src/lib.rs`, `capabilities/default.json`, `test/window-check.ps1`, `icons/` (17 desktop files)

**Verified working:** `npm run build` (0 errors), `npm run check` (0 warnings), `cargo build` clean, `cargo tauri dev` opens window and renders sidecar port.

---

## 5. Repository Layout

**Important:** the repo root **is** the project root. There is no subfolder. This was chosen deliberately (Option A) so that git, CI, and tooling all operate from a single, clean location.

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
│   └── styles/
│       └── global.css
│
├── src-tauri/                   # Tauri v2 Rust shell
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── capabilities/
│   │   └── default.json
│   ├── test/
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
│   │   └── registry.js
│   └── test/
│       ├── handshake.ps1
│       └── smoke.js
│
├── legacy/                      # old Windows-only PowerShell launcher
│   └── (preserved files, never referenced by the new project)
│
├── vite.config.ts
├── tsconfig.json
└── package.json                 # root workspace: frontend + sidecar
```

### 5.1. Workspace Layout Notes

- **npm workspaces.** The root `package.json` declares `"workspaces": ["sidecar"]` and `"private": true`. A single `npm install` at root installs both the frontend and sidecar dependencies. One `package-lock.json` at root.
- **`src/svelte.config.js`, not root.** `vite-plugin-svelte` resolves its config relative to Vite's `root`, which is `src/`. A config at repo root is silently ignored.
- **`src-tauri/gen/` is gitignored.** Tauri regenerates it on every build. Do not commit it.

### 5.2. About the `legacy/` Folder

The `legacy/` folder contains the **previous generation** of this project: a Windows-only launcher written in PowerShell (`dsh-app.ps1`, `installer.iss`, `build.ps1`, `icon.ico`).

**It is historical reference only.**

- Do **not** read it as part of the current project.
- Do **not** import code from it.
- Do **not** modify it.
- Do **not** delete it — it stays in the repo for users who still rely on it.

The new cross-platform launcher is a **clean rebuild**. The only thing it shares with the legacy version is the general goal and the `icon.ico` (which may be reused for the new app).

---

## 6. Git and Repository Conventions

- The repo is `https://github.com/MIHassan3/DSH-Launcher`.
- Repo root **is** the project root. All git operations happen from here.
- `git status` should show a clean working tree before each commit.
- `.gitignore` at repo root must exclude:
  - `node_modules/` (all levels)
  - `src-tauri/target/`
  - `src-tauri/gen/` (Tauri-generated schemas, regenerated on every build)
  - `src-tauri/binaries/*.exe` and `src-tauri/binaries/*.bin` (bundled Node runtime — downloaded during build, not committed)
  - `dist/`
  - `*.log`
  - `.DS_Store`, `Thumbs.db`, `desktop.ini`
  - `.npm-cache/`, `.test-tmp/` (dev-time scratch directories)

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
- **Rust 1.84.0+** — for Tauri. Phase 0 verified with 1.98.1.
- **GitHub Actions** — for cross-platform CI in Phase 4.

---

## 8. Architectural Decisions Log

For future reference, the answers to the open questions raised during the project-introduction review.

| # | Question | Decision |
| :--- | :--- | :--- |
| Q1 | Bundle Node or require it? | **Bundle** a portable Node v22.19+ LTS. Sidecar is plain JS, not a compiled binary. `pkg` and SEA are not used. |
| Q2 | Does `dsh web` accept a port? | **Yes** — `--host`, `--port`, `--no-open`. Verified against a working reference. |
| Q3 | What is "Stable (RC)"? | **Three distinct channels**: Stable (`latest`), RC (`latest-rc`), Alpha (`alpha`). First run downloads Stable + Alpha (2, not 3). |
| Q4 | Frontend stack? | **Svelte 5 + Vite + TypeScript.** |
| Q5 | How to populate version library? | **`npm install --prefix`** into a per-version folder. Not `npm pack`. |
| Q6 | How to detect Active version? | **State file + liveness probe** on the recorded port. |
| Q7 | Orphan / port hygiene? | **Adopt or reap at startup** (§2.3). Plus explicit Stop command and uninstall cleanup. |
| Q8 | Where does launcher state live? | **Per-OS conventions** (§2.4). `$DSH_HOME` passed through unchanged; never touched. |
| Q9 | Background polling cadence? | **Once per 12h**, ETag-aware, `304`-respecting. |
| Q10 | Code signing? | **Out of scope** for v1.0.0. Ship unsigned with documented warnings and checksums. |
| Q11 | Tauri version? | **v2.** |
| Q12 | Embedded webview or browser? | **Embedded Tauri webview.** |
| Q13 | Is §5 product spec? | **No** — dev guidance only. Product has zero plugin dependencies. |
| Q14 | Minimum supported harness version? | **Define a constant**, warn below it, do not block. |
| Q15 | Git strategy? | **Repo root = project root** (Option A). Legacy files moved to `legacy/`. |
| Q16 | IPC transport for the port? | **stdout one-line handshake** (`SIDECAR_READY:<port>`). Tauri commands + local HTTP for all later traffic. No custom socket. |
| Q17 | package.json ownership? | **npm workspaces.** Root owns frontend, `sidecar` is a workspace member. One lockfile. |
| Q18 | Sidecar source path? | Repo-root `sidecar/` always. Copied to `src-tauri/resources/` at package time (Phase 4). Never gitignored. |
| Q19 | Dev Node vs bundled Node? | Dev uses system Node (v24.x now). Shipped bundle pins Node 22.x LTS in Phase 4. |
| Q20 | Icon source? | `docs/assets/icon.ico`, generated into `src-tauri/icons/` via `cargo tauri icon` in Step 5. Mobile icon sets deleted (desktop-only). |
| Q21 | IPv4 pinning? | **Mandatory.** Both `vite.config.ts` `server.host` and `tauri.conf.json` `devUrl` must be `127.0.0.1`, never `localhost`. See §2.7. |
| Q22 | strictPort? | **Keep `true`.** Stale-dev-server footgun documented in §2.7; fix deferred to Phase 3/4. |
| Q23 | MIN_SUPPORTED_DSH? | Placeholder `"0.0.0"` in Phase 0. Real value set in Phase 1 after querying the registry. |

---

## 9. Visual Identity (Forward-Looking)

Not required for Phase 0, but for reference when UI work begins.

- **Icon concept:** minimalist dock, pier, or anchor. A stylized "D" formed by a dock shape is acceptable.
- **Palette:**
  - Primary: Deep Blue `#1E3A5F`
  - Accent: Cyan `#00B4D8`
  - Background: Dark Charcoal `#1A1A1A`
  - Text: Off-White `#F0F0F0`
- **Typography:** Segoe UI (Windows), SF Pro (macOS), Inter (cross-platform web UI).

---

*End of document.*