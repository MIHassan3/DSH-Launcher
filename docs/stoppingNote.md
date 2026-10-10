# DSH-Dock — Stopping Note

**Document:** `docs/stoppingNote.md`
**Written:** 2026-10-10, at close of development
**Project status:** **STOPPED — not under active development.** Superseded by the official DeepSeek Harness desktop application (released 2026-09-30).
**Repository state at close:** `main` @ `bee40ce` — working tree clean, in sync with `origin/main`
**Purpose of this document:** the standard closing record. It states what the code is, what was verified and when, what is knowingly broken, what remained on the original plan, and what a future reader (or a resuming engineer) must do first. The user-facing "use the official app instead" notice lives at the top of `README.md`; this file is the engineering counterpart.

> **One-line summary.** Phases 0–1, Pause 3, Pause 4 and Phase 2A are complete and released as far as v0.5.1 (Phase 1 scope only). Phase 2B is ~90% complete and committed but **never fully verified, never released**: the version-switch backend, registry routes, minimal Version Manager UI, Recent Versions submenu and menu-side dispatch all exist in code; two user-visible defects were open when work stopped, one with a confirmed root cause and a fix that was drafted but never applied.

---

## 1. Why the project stopped

- **2026-09-30** — DeepSeek released an **official desktop application** for the DeepSeek Harness (Windows + macOS). It covers the project's entire premise: one-click launch, background operation, local file access, auto-update, first-party support.
- **2026-10-10** — development stopped. The premise ("run the Harness without touching a terminal") no longer requires a third-party launcher.
- The repository is retained as a **record of the work**, not as a maintained tool. No further commits, releases, dependency bumps or security responses should be expected. `SECURITY.md` remains accurate for the code as shipped, but the code is unmaintained.

---

## 2. What exists in the repository

### 2.1 Commit history that matters

| Commit | Date | Meaning |
| :--- | :--- | :--- |
| `9729b08` | 2026-10-03 | Pause 4 — first-run wizard, channel selection, install-and-open hand-off |
| `dc1daf8` | 2026-10-02 | Pause 3 + 3.5 — native menu bar, settings model, fast-path status updates |
| `075a897` | 2026-10-07 | **Phase 2A complete** — version library foundation (backend) |
| `18ff35a` | 2026-10-07 | MD v2.7.0 — Phase 2A complete, decisions Q67–Q72 |
| `131f0c0` | 2026-10-10 | **Phase 2B (partial)** — version manager backend + UI, menu actions. *This is the last code commit.* |
| `0bef006` | 2026-10-10 | README status banner — development stopped |
| `3a7dfc8` / `bee40ce` | 2026-10-10 | `docs/Notes` created then deleted (empty file; no content lost) |

`131f0c0` is the feature tip: 29 files, +9,477/−202 lines. Everything Phase 2B built is in it.

### 2.2 Architecture as built (unchanged from the MD's design)

Tauri v2 (thin Rust shell) + Node.js sidecar (smart core, plain `.js`) + Svelte 5 frontend + opaque official `@deepseek-ai/dsh` harness + a local version library. Four layers, one rule: the shell holds no launcher logic, the harness is never modified, `$DSH_HOME` is never read or written.

State lives in `%LOCALAPPDATA%\DSH-Dock\` (`runtime-state.json`, `settings.json`, `versions/`, `logs/`, `cache/`, `.npm-cache/`); binaries in `%LOCALAPPDATA%\Programs\DSH-Dock\`. `DSH_DOCK_DATA_DIR` overrides the data directory (a product feature, not a test hack) and is how every test isolates itself.

### 2.3 Published releases (GitHub)

| Tag | Date | Scope | Asset |
| :--- | :--- | :--- | :--- |
| `dsh-launcher-v0.1.0` | 2026-09-09 | Legacy PowerShell launcher | `DSH-Launcher_v0.1.0_windows.exe` |
| `dsh-launcher-v0.1.1` | 2026-09-09 | Legacy PowerShell launcher | `DSH-Launcher_v0.1.1_windows.exe` |
| `v0.5.0` | 2026-09-13 | Tauri technical preview (**installer packaging bug**) | `DSH-Dock_0.5.0_x64-setup.exe`, `.msi` |
| `v0.5.1` | 2026-09-14 | Installer fix — **the last published release** | `DSH-Dock_0.5.1_x64-setup.exe` (sha256 `d9c046c62d45f20e43d2b79d5971f9d138473dfb1e3a707ad6634dbe7a202281`) |

**No release was ever published from the Phase 2 work.** Published v0.5.1 is Phase 1 scope: no version picker, no settings UI, no tray, Windows only, unsigned, Node.js required on the machine.

A **local, unreleased** NSIS build of the 2B source existed at `src-tauri\target\release\bundle\nsis\DSH-Dock_0.5.1_x64-setup.exe` (2026-10-09 19:39, 2,635,331 bytes) next to the release binary `src-tauri\target\release\dsh-dock.exe` (11,975,680 bytes). Version fields still read `0.5.1`; nothing was bumped for 2B. **These artifacts were built during the halted acceptance work and were never rebuilt or hash-pinned from `bee40ce`** — they were evidence of a build that existed, not a verified release candidate, and they were **deleted with `src-tauri\target\` during close-out** (§2.4). Rebuild from source with `npm run tauri -- build` if the artifact is ever needed.

### 2.4 Local-only artifacts — cleaned at close-out

All of the following were gitignored and none of them is part of the repository. **They were deleted on 2026-10-10 after the verification in §4 was complete**, leaving a working tree of ~3 MB (excluding `.git`). Roughly **12.0 GB** was reclaimed.

| Path | Size before | Deleted | How to restore |
| :--- | ---: | :--- | :--- |
| `src-tauri\target\` | ~8,560 MB | yes | `npm install`, then `npm run tauri -- build` |
| `.test-tmp\library-live\` | ~1,196 MB | yes | `RUN_LIVE=1 node sidecar/test/library-live.js` (needs network + real npm) |
| `.test-tmp\version-manager-check\` | ~928 MB | yes | Re-created by `src-tauri/test/version-manager-check.ps1` |
| `.test-tmp\menu-probe\versions\` | ~928 MB | yes | Probe tree from the PAUSE 9 diagnosis; re-created by re-running that probe |
| `.test-tmp\live-data\` | ~372 MB | yes | Early Phase 0/1 scratch |
| `.npm-cache\` | ~170 MB | yes | Repopulated on the next harness install |
| `node_modules\` | ~90 MB | yes | `npm install` |
| `.test-tmp\` suite scratch (17 dirs) | ~0 MB | yes | Re-created by any suite run |
| `legacy\build\`, `legacy\dist\`, `dist\`, `src-tauri\gen\` | ~3.4 MB | yes | Legacy PowerShell build / `vite build` / Tauri CLI |

**Deliberately kept (one file, 6.4 KB):** `.test-tmp\menu-probe\logs\launcher.log` — the launcher-side log from the 2026-10-09 probe run, which is the raw evidence behind defect **D2** in §5. It is gitignored and stays on this machine only.

**Deliberately removed for hygiene:** the probe's scratch `dsh-home\` contained a `.credentials.yaml` written by the harness under test. It was inside the scratch tree and is gone; nothing under the real `$DSH_HOME` was ever touched.

### 2.5 External records that are part of this project

- **`src-tauri/NOTES.md`** (1,834 lines) — the in-repo engineering record: the menu architecture, the wizard, the Windows/WebView2 integrity failure, the whole 2A section, and the Phase 2B decisions **Q73–Q100**. The MD's own decision log stops at Q72, so **after 2A, NOTES.md is the authoritative decision record**, not `docs/PROJECT_DSH-DOCK.md`.
- **`docs/PROJECT_DSH-DOCK.md`** (v2.7.0, 743 lines) — the framework specification and phase plan.
- **Two DeepSeek conversations that describe how the project was designed and built** (referenced here because they are project history, not because they are machine-readable):
  - DSH-Dock 1 — https://chat.deepseek.com/share/c9bgwk6hiofoeyin6m
  - DSH-Dock 2 — https://chat.deepseek.com/share/11m18s8qj314bgaver
  - **Preservation risk:** these are hosted, third-party pages. At close, fetching them from a non-browser client returned HTTP 403 (CloudFront), and their content is **not archived anywhere in this repository**. If the project record matters, export them manually while the links are live.
- The final acceptance session ("Phase2.2", `session-a7034241-00f0-4f9b-9114-edf2e7e650ac`) is preserved in the local harness session store as a zstd-compressed JSONL event log under `%USERPROFILE%\.dsh\sessions\<workspace-key>\session-a7034241-…\session.v4.jsonl.zstd` (2,716 zstd frames / ~11.6 MB of JSONL when decompressed). It is the only verbatim record of the 2B acceptance run and the PAUSE 9 diagnosis. It is outside the repository and is not backed up by it.

---

## 3. Plan status

Original plan: `docs/PROJECT_DSH-DOCK.md` §4 (Phases 0–4) plus the Phase 2 sub-phase split into 2A–2D.

| Milestone | Status at close |
| :--- | :--- |
| Phase 0 — Foundation | ✅ Complete 2026-09-10 |
| Phase 1 — MVP core (install, spawn, adopt/reap, embedded webview) | ✅ Complete 2026-09-13 |
| v0.5.0 / v0.5.1 releases | ✅ Published 2026-09-13 / 2026-09-14 |
| Pause 3 — native menu bar, settings model, fast-path status | ✅ Complete 2026-10-02 (130 Rust tests, fast path 0 ms) |
| Pause 4 — first-run wizard | ✅ Complete 2026-10-03 (161 Rust tests, acceptance 29/29) |
| Phase 2A — version library backend | ✅ Complete 2026-10-07 (`075a897`) |
| **Phase 2B — version switch + registry routes + minimal UI** | ⚠️ **Steps 1–9 committed; Step 10 partially verified; Step 11 never started; PAUSE 4 never reached** |
| Phase 2C — background updates, storage management | ❌ Never started (was deferred) |
| Phase 2D — Job Object "decide and document" | ❌ Never started (reframed from code work by the libuv finding, Q72) |
| Phase 3 — Settings & Update UI | ❌ Never started |
| Phase 4 — Polish & release (v1.0.0) | ❌ Never started |

### 3.1 Phase 2B, step by step (the plan as it stood)

| Step | Content | State |
| :--- | :--- | :--- |
| 1 | Decision log and risk inventory (`NOTES.md` §2B) | ✅ Done (Q73–Q100) |
| 2 | `control.js` version-agnostic start, `recentVersions` in `/harness/status`, `isInstalled` → `isInstalledAndValid` rewire | ✅ Done |
| 3 | `version-manager.js` job model, progress, `switchTo` guard order | ✅ Done |
| 4 | `service.js` wiring + `/versions/*` routes | ✅ Done |
| 5 | Registry routes (`GET /registry/versions`, `POST /registry/download/<version>`) | ✅ Done |
| 6 | Offline suites (`version-switch.js`, `version-registry.js`, `version-progress.js`) | ✅ Done |
| 7 | Rust shell commands + capability grants (5 commands, then a 6th — see Q98) | ✅ Done |
| 8 | Menu snapshot, `SwitchVersion` worker, submenu flag, `SHOW_ALL_VERSIONS_ENABLED` | ✅ Done |
| 9 | Minimal Version Manager UI (`VersionManager.svelte`) | ✅ Done |
| 10 | Full-app verification against the release build | ⚠️ **Run twice, not closed** — see §5 |
| 11 | Live verification + set `MIN_SUPPORTED_DSH` | ❌ **Never started** |
| — | PAUSE 4 — final 2B report | ❌ Never reached |

### 3.2 What Phase 2B actually delivered (committed in `131f0c0`)

- **Version switch** — identity-checked stop (reusing §2.3's adopt/reap path) → install only if not `installed` → detached spawn → rewrite `runtime-state.json` with a new `instanceId`. Guard order pinned: version-name validation → library state → **refuse if the library lock is held, before stopping anything** → refuse if another job is in flight → stop → install (lock taken implicitly by the installer, so no second lock discipline can deadlock) → spawn → record. No rollback on a failed boot (Q80); the job reports `error` (not `stopped`) with the previous version named as still installed.
- **Six Tauri commands** — `versions_list`, `versions_progress`, `versions_download`, `versions_switch`, `versions_delete`, plus `versions_available` (the sixth, a documented deviation: without it the "Available" list could never be populated — Q98). Each maps to exactly one fixed sidecar route; no parameterized proxy.
- **Sidecar routes** — `GET /versions/status`, `GET /versions/progress`, `POST /versions/switch?version=`, `POST /library/delete?version=&partial=1`, `GET /registry/versions[?refresh=1]`, `POST /registry/download/<version>`. `GET /versions/library` was deleted in 7b (a strict subset of `/versions/status`).
- **Job/progress model** — polled state field, four coarse phases (`resolving / downloading / linking / validating`), last finished job retained so a late poll still learns the outcome.
- **Minimal Version Manager UI** — installed list (state badge, switch, delete, partial-tree "Switch (repair)" + "Clean up"), available list (download, `belowMinimum` badge that never blocks), progress panel.
- **Recent Versions submenu** — up to five by catalogue date with a version-string fallback when no catalogue exists (Q76), plus "Show all versions…"; the running version rendered as a native **check** (Q100), and the already-running entry deliberately not clickable.
- **Menu actions work without the dashboard** (Q99) — Stop, Restart and Switch dispatch from the shell to the sidecar on a worker thread, unconditionally; `deliver()` survives for `OpenLogsFolder` only.
- **Continuous state polling** — the dashboard polls `/harness/status` at 500 ms while starting and 5 s otherwise forever; the version section polls at 500 ms while busy and 5 s otherwise forever; the cadence decisions live in `src/lib/version-refresh.js` with their own suite. This replaced the event-driven polling that caused two of the three acceptance bugs.
- **`MIN_SUPPORTED_DSH`** — declared in `sidecar/lib/version-manager.js` with the §3.2 semantics (allow, warn once, never block) and consumed by the UI badge, but the value is still the placeholder **`"0.0.0"`**, which the UI treats as "no floor".

---

## 4. Verification performed at close (2026-10-10)

All numbers below were **measured in this closing session against `bee40ce`**, not copied from earlier reports. Commands are reproducible from the repository root (add `src-tauri/` for the Rust ones).

| Tier | Command | Result |
| :--- | :--- | :--- |
| Sidecar offline suites (15) | `node sidecar/test/<suite>.js` | **1,474 checks, 0 failures** |
| Frontend suite scripts (2) | `node src/test/version-refresh.test.js`, `node src/test/sidecar-connection.test.js` | **59 checks, 0 failures** (36 + 23) |
| **Total offline checks** | — | **1,533 checks, 0 failures** |
| Rust unit tests | `cargo test --lib` | **192 passed, 0 failed** |
| Rust lints | `cargo clippy --lib` | Clean, exit 0 |
| Frontend types/diagnostics | `npx svelte-check --tsconfig ./tsconfig.json` | **0 errors, 0 warnings** |

Per-suite counts measured now (for the paper trail — these supersede the figures recorded during the session):

| Suite | Checks | Suite | Checks |
| :--- | ---: | :--- | ---: |
| `library.js` | 166 | `platform.js` | 42 |
| `catalogue.js` | 145 | `registry.js` | 53 |
| `harness-install.js` | 74 | `control.js` | 81 |
| `install-flow.js` | 241 | `version-switch.js` | 115 |
| `library-delete.js` | 158 | `version-progress.js` | 76 |
| `library-select.js` | 36 | `version-registry.js` | 70 |
| `state.js` | 65 | `src/test/version-refresh.test.js` | 36 |
| `harness.js` | 86 | `src/test/sidecar-connection.test.js` | 23 |
| `harness-start.js` | 66 | | |

**Number corrections for the next revision of any document:** `NOTES.md`'s 2B reconciliation table records "2B end: 15 suites, 1,461"; measured at `bee40ce` the sidecar tier is **1,474** (+13, added by the late acceptance fixes). The MD's §4.3 "1,100/1,100 across 11 suites" for 2A is also wrong — the in-session measurement was **1,166 across 12 suites** at `075a897` (`harness-start.js` was omitted; `registry.js` was mislabelled as new).

### 4.1 What was NOT verified (do not read the table above as end-to-end proof)

- **No end-to-end run of the committed source.** No release build was produced from `bee40ce` at close, and the menu/UI acceptance checklist (`src-tauri/test/version-manager-check.ps1`) was not re-run. The last full-app acceptance run predates the final commits.
- **Live tier not run.** `sidecar/test/library-live.js` and `control-live.js` are gated behind `RUN_LIVE=1` and need real npm and network; they were not executed here. No live install/boot/**switch** round trip has been performed against the committed source.
- **`MIN_SUPPORTED_DSH` has no evidence.** Step 11 was never started; `sidecar/test/version-switch-live.js` does not exist.
- **Packaging gate not re-run.** `src-tauri/test/packaging-check.ps1` last ran against the 2026-10-08 build.

---

## 5. Open defects and unfinished work at halt

### D1 — The running version shows no checkmark in Recent Versions (root cause confirmed, fix never applied)

- **Symptom.** The `Recent Versions` submenu never ticks the running version, in either window.
- **Root cause (confirmed 2026-10-09 by the acceptance session).** `MenuState::installed_version` is a **stored field with no production writer**. `snapshot_from_status_payload` fills `recent_versions` but not it; `update_harness` writes `harness_version` but not it. Only test fixtures and the menu-plan dump scenarios ever set it. `recent_versions_submenu` (`src-tauri/src/menu.rs:780`) compares each entry against that field, so with `None` it never ticks anything. The plan construction was right; its input was always empty.
- **Secondary consequence.** The §2.8.4 fast-path guard compares the whole plan, so it *would* have declined on the status label alone — but the running-version change never reached the plan in the first place, so a switch could take the status-label-only path and leave a menu that never learned the version moved.
- **Known good fix (drafted in the session, never applied).** Derive the field at the single production read site, `MenuRuntime::snapshot()`, so it cannot be empty while the menu names a running version:

  ```rust
  /// The current menu state.
  pub fn snapshot(&self) -> MenuState {
      let mut state = self.lock().state.clone();
      // `installed_version` IS DERIVED HERE... it was a stored field with no
      // production writer, so in a running launcher the field stayed `None`
      // forever, the check mark never appeared, and the fast path could not
      // see a version change. Deriving it from `harness_version` - the field
      // that IS maintained - makes that impossible. Writing the field in
      // `update_harness` instead would leave two fields able to drift, which
      // is exactly how the bug arose.
      state.installed_version = state.harness_version.clone();
      state
  }
  ```

- **Why it is not in the code.** The edit was issued as the session's final action and was **rejected by the tool** (`FS_NOT_OBSERVED: file has not been read`); the session ended on the user's next `continue` with no further turns. `grep installed_version src-tauri/src` at `bee40ce` confirms the field is still written only by `MenuState::default()` and test fixtures.

### D2 — Harness-window menu lifecycle after a version switch (partially diagnosed)

- **Symptom (README known issue).** The harness window has a menu bar right after the app opens, but after a version switch, when the harness window is recreated, the menu bar is reported missing.
- **Evidence measured during the halted diagnosis** (`.test-tmp\menu-probe\logs\launcher.log`):
  - The harness window **does** receive the app-wide menu at creation: `harness window menu after create: held=1051 app_wide=1051 match=true`.
  - The app-wide attach **never reaches the harness window** on later rebuilds: every `menu app-wide attach:` line names `main` only.
  - In the observed switch run, **no rebuild ran at all while the harness window was open** — the switch was rendered as a status-label-only fast-path update.
- **Consequence, stated conservatively.** Because the harness window gets its menu through the window-scoped `window.set_menu()` at creation (which does not set Tauri's `is_app_wide` flag) and the app-wide `AppHandle::set_menu()` only touches windows where `has_app_wide_menu() || menu().is_none()`, later rebuilds can leave the harness window's menu stale. Whether that fully explains the *missing* menu bar (as opposed to a stale one) was **not established**.
- **Unresolved side question.** A run with the explicit attach removed still showed `match=true`, so it is not yet settled whether the explicit `window.set_menu(menu)` added in Pause 7 (`build_harness_window`) is required or redundant. It is still present in `bee40ce`, with two tests pinning it.
- **Related, landed finding worth keeping.** MD §2.8.3 is **wrong** about Tauri: `AppHandle::set_menu()` iterates the window map once at call time; a window created later does *not* inherit the app-wide menu. That correction belongs in any future revision of the MD.

### D3 — Partial-tree and failed-switch paths are unit-tested but never exercised live

The switch suite (115 checks) covers the guard order, repair-after-stop, the failed-boot state shape, `$DSH_HOME` passthrough and the cross-process lock probe. None of it has been exercised against real npm and a real harness boot through the UI.

### D4 — Step 11 unfinished: no verified supported floor

`MIN_SUPPORTED_DSH = "0.0.0"` in `sidecar/lib/version-manager.js`; the UI treats `"0.0.0"` as "no floor" so no `belowMinimum` badge ever appears. The evidence base for the intended value (`"0.2.0-rc.1"`) existed locally in `.test-tmp\library-live\` but was never switched between, and that scratch tree was deleted at close-out (§2.4) — it must be re-created before Step 11 can be attempted.

### D5 — Documentation drift (any future revision must fold these in)

1. MD §4.3: `1,100/1,100 across 11 suites` → measured **1,166/12 suites** at `075a897`; `harness-start.js` was omitted and `registry.js` mislabelled as new.
2. MD §4.3: `validateInstallTree(installDir, {checkMarker})` → actual signature is `validateInstallTree(version, installDir, {checkMarker})`.
3. MD §5: `11 offline suites` → 12 at 2A, **15** at 2B; the suite table in `NOTES.md` is the live register (there is no aggregate runner and no `npm test`).
4. MD §2.8.3: the "windows created later inherit the app-wide menu" claim is false (see D2).
5. MD §8 decision log stops at **Q72**; Q73–Q100 exist only in `NOTES.md`.
6. MD header still says "Phase 2A complete. Phase 2B next." and §4 shows 2B as "next".
7. `NOTES.md` 2B reconciliation table: 1,461 → **1,474** sidecar checks at `bee40ce` (see §4).
8. `README.md` contains two contradictory status sections: the accurate 2026-10-10 stop banner at the top and a stale "Status: Technical Preview (v0.5.0)" roadmap below it. The banner supersedes; the lower section was left as published history.
9. `README.md` promised "Phase 2 will add explicit profile isolation" between DSH-Dock and the official harness. **It was never implemented** — running both simultaneously still risks a plugin-tree conflict in the shared `$DSH_HOME`.

### D6 — Known minor issue carried from v0.5.1

A brief "the sidecar has not reported a port yet" message can appear on the first launch after a cold boot; it clears on Refresh. The retry-budget fix was assigned to 2C and never written.

---

## 6. Remaining steps per the original plan

Recorded in the order the plan itself imposes. **Steps 1–4 are the only ones that matter if the Phase 2B work is ever to be called finished; the rest are the phases that were never reached.**

### 6.1 To finish Phase 2B (the work that was in flight)

1. **Land the D1 fix.** Apply the `snapshot()` derivation in `src-tauri/src/menu.rs`, add a test at the `MenuRuntime` level that a runtime snapshot carries the running version (the existing four check-mark tests use fixtures and therefore passed while the production field was dead), then `cargo test --lib` and `cargo clippy`.
2. **Close D2.** Re-run the harness-window menu reproduction with the diagnostic logging that is already in `build_harness_window` and `rebuild_menu`. Decide whether the window-scoped attach at creation is required, and if later rebuilds must reach the harness window, give it a path that does not depend on Tauri's `is_app_wide` flag. The `MenuPlan`/`MenuState` decision must be made explicit in `NOTES.md`.
3. **Re-run Step 10 acceptance in full**, on a **release** build with no dev server (§7.4): `npm run tauri -- build`, then `src-tauri/test/packaging-check.ps1`, then the ten-step checklist `src-tauri/test/version-manager-check.ps1`. The two items that regressed must be verified specifically: switching from the **menu with the dashboard closed**, and the **checkmark following the running version** after switch, stop and start.
4. **Run Step 11 and set the floor.** Create `sidecar/test/version-switch-live.js` gated on `RUN_LIVE=1`. The original `.test-tmp\library-live\` trees were deleted at close-out, so first re-create a live library with `RUN_LIVE=1 node sidecar/test/library-live.js` (real npm + network), then boot `0.2.0-rc.2` → switch to `0.2.0-rc.1` → switch back, asserting recorded version / `installDir` / new `instanceId`, the old PID gone, and `$DSH_HOME` byte-identical before and after. Then set `MIN_SUPPORTED_DSH = "0.2.0-rc.1"` with the comment "the oldest version this project has verified install + boot + switch".
5. **PAUSE 4 — final report**, then commit (the entire Phase 2B session ran with git read-only by design, so all 2B work is committed in one halt commit and nothing after it).

### 6.2 Phase 2C — background updates and storage management (never started)

- Background version check on a 12-hour cadence, ETag-aware.
- Storage management prompts and `cache_limit` enforcement (the pure selection logic already exists in `sidecar/lib/library.js` / `library-select.js`).
- Sidecar "no port" flash — retry-budget extension (D6).
- Menu rebuilt after wizard dismissal (inherits the §2.8.4 fast-path work automatically).

### 6.3 Phase 2D — Job Object: decide and document (never started)

Per Q72, the libuv finding reframed this from "build a Job Object" to "decide and document what should happen to a detached harness when the launcher is force-killed". The deliverable is a decision, a written rationale, and a test proving the launcher's force-kill does not orphan the **sidecar**. Current behaviour (the harness survives by design; adopt/reap on next launch, §2.3) is arguably already correct.

### 6.4 Phase 3 — Settings & Update UI (never started)

- Full Version Manager table UI (§3.4) — the hand-written UI type mirrors are the flagged weak seam; a shared schema is the recommended direction.
- Update Preferences UI; channel selection and pinning UI.
- Background check + notification system (§3.10).
- Tauri v2 Updater integration for the launcher itself.
- Deferred from 2B by decision: **undeliverable-action slot** (a menu action fired with the dashboard closed) and broader fast-path `set_text` coverage (§8.2); **background-job status surface** (a menu/tray surface for a long-running job's progress — four options analysed in `NOTES.md`, deliberately not designed in 2B).

### 6.5 Phase 4 — Polish and v1.0.0 (never started)

System tray; macOS and Linux builds (all cross-platform verification to date is Windows-only — §2.9); **bundled Node.js runtime** (today the user must install Node v22.19+ themselves); MSI installer; code signing; `--remap-path-prefix`; docs + `SECURITY.md` refresh; `v1.0.0`.

### 6.6 Post-1.0 (§8.4) — never started

Harness-first launch: subsequent runs open the harness window directly and the dashboard becomes an advanced surface. Requires four extra menu items (Start, Open Harness, Close Harness Window, Refresh), a `launch_behavior` setting, and the tray.

---

## 7. How each claim in this note was established

| Claim | Evidence |
| :--- | :--- |
| Repository state, commit history, clean tree, sync with origin | `git status`, `git log`, `git rev-parse HEAD origin/main` at close |
| Check/test counts in §4 | Suites executed at close; each prints `RESULT: all N checks passed`; Rust via `cargo test --lib` |
| Phase 2B step status, Q73–Q100 | `src-tauri/NOTES.md` (written during the phase) + commit `131f0c0` |
| D1 root cause and the drafted fix | The acceptance session's own transcript (recovered read-only and decompressed into `%TEMP%`; the `installed_version` read-site grep at `menu.rs:246/267/780`) and a `grep` of the committed source that shows the fix absent |
| D2 evidence | `.test-tmp\menu-probe\logs\launcher.log` (probe run 2026-10-09) and the session transcript |
| Releases and asset digests | GitHub Releases API for the repository |
| Local artifact sizes, build timestamps, stray processes | Filesystem inspection at close |
| The two DeepSeek conversations | Provided by the project owner; fetched at close and found **not retrievable** by a non-browser client (HTTP 403) |

---

## 8. Closing checklist — performed at close

- [x] **Pulled `origin/main`** — the local checkout was three commits behind (`0bef006`, `3a7dfc8`, `bee40ce`); fast-forwarded cleanly.
- [x] **Confirmed nothing is uncommitted and nothing is unpushed** (`bee40ce` == `origin/main`, clean tree).
- [x] **Ran the full offline verification** — 1,533 checks, 0 failures; 192 Rust tests; clippy and `svelte-check` clean (§4).
- [x] **Stopped two orphaned harness processes** left detached by the halted verification runs — pids `6460` (`.test-tmp\menu-probe\versions\0.2.0-rc.1\…\bin.js`) and `31852` (`.test-tmp\version-manager-check\versions\0.2.0-rc.2\…\bin.js`). Both were identified by command line before killing; no `node` process remains. Their orphaned state is the documented, by-design behaviour of a detached harness, not a defect.
- [x] **Left the user's real installation and data untouched.** `%LOCALAPPDATA%\DSH-Dock\` was neither read nor written. The Phase 2B session transcript was read **read-only** from `%USERPROFILE%\.dsh\sessions\` and decompressed into `%TEMP%`; nothing inside `$DSH_HOME` was modified.
- [x] **Recorded the un-released build artifacts** in §2.3 rather than presenting them as a release.
- [x] **Recorded documentation drift** (§5, D5) instead of silently fixing the MD — the MD was under a standing "do not write" rule for the whole of Phase 2, which is why it lags by three phases of decisions.
- [x] **Deleted the regenerable residue after verification** — `src-tauri\target\`, `node_modules\`, `.npm-cache\`, `dist\`, `legacy\build\`, `legacy\dist\`, `src-tauri\gen\` and all `.test-tmp\` scratch except one log file. ~12.0 GB reclaimed; the working tree is ~3 MB excluding `.git`. Details and restore commands in §2.4.
- [x] **Removed the scratch tree's own `dsh-home`** (it contained a `.credentials.yaml` written by the harness under test) and the temporary extraction of the Phase 2B transcript from `%TEMP%` (~11.4 MB). Nothing under the real `$DSH_HOME` was touched at any point.
- [x] **Committed and pushed** as the final close-out commit on 2026-10-10 — this note plus a link to it from the README banner. No other tracked file was changed.
- [ ] **Optional follow-up for the owner** — the repository-level actions in §10 (archive, export the two DeepSeek conversations, annotate the `v0.5.1` release notes).

---

## 9. If someone resumes this project

1. Read `src-tauri/NOTES.md` first, not the MD — it is 1.8k lines and holds the real decision record, including Q73–Q100 that the MD never received.
2. Treat nothing as verified until it is re-built from the current `HEAD` and re-run: the last full acceptance pass predates the final commits (§4.1).
3. Finish §6.1 before touching 2C/2D/Phase 3 — a stale menu and an unverified floor sit directly under the features those phases would extend.
4. Keep the project's two load-bearing disciplines, because they are what kept the bug count low: **a rule stated in two places must be pinned by a test that compares them** (Q71), and **no number goes into a report without being measured** (the Phase 2B paper trail corrected two fabricated figures against `HEAD`).
5. Before publishing anything, re-check whether the official DeepSeek Harness desktop app still makes this project redundant. That was the reason it stopped.

---

## 10. Recommended repository-level close-out (owner actions)

These are outside the code and were deliberately left to the owner:

1. **Archive the GitHub repository** (Settings → Archive). It is unmaintained, its premise is gone, and an archived repo cannot collect pull requests against dead code.
2. **Point every entry route at the official app.** The README banner already opens with it and is the first thing rendered; consider appending the same stop notice to the `v0.5.1` release notes, since release pages are reached directly from search and from the installer.
3. **Export the two DeepSeek conversations** into `docs/history/` before they rot (see §2.5). They are the only narrative account of how the design was arrived at, and they are not archived here.
4. **Do not publish the unreleased local 2B build.** It is unsigned, unverified end-to-end, and carries two known user-visible defects (D1, D2).
5. **Leave the release assets up.** `v0.5.1` still works for what it is, and the README explains the SmartScreen warning and the Node prerequisite.
6. **Optionally tidy `README.md`** so the stale "Status: Technical Preview (v0.5.0)" roadmap section below the banner is marked as historical rather than current (D5 item 8).

---

*End of stopping note.*
