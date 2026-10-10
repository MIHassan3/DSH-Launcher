# src-tauri development notes

Phase 0 implementation notes for the Tauri shell. See
`docs/PROJECT_DSH-DOCK.md` for the product specification.

## Why these files have no inline comments

`tauri.conf.json` is **strict JSON**. Tauri deserializes it with
`deny_unknown_fields`, so a `//`-style comment key (a common workaround) makes
the build fail outright with:

```
unknown field `//devUrl`, expected one of `runner`, `dev-url`, `devUrl`, ...
```

JSONC comments are not enabled. Any rationale that cannot live in the config
file therefore belongs here.

## `build.devUrl` MUST be `http://127.0.0.1:1420`

`build.devUrl` here and `server.host` / `server.port` in `../vite.config.ts`
must agree **exactly**. Changing one without the other breaks the dev window.

**Do not use `localhost`.** On Windows, Vite resolves `localhost` to IPv6
`[::1]`, while WebView2 resolves it to IPv4 `127.0.0.1`. The mismatch produces:

- a blank window (the webview connects to an address nothing is listening on),
- and, on the next start, a confusing `Port 1420 is already in use`, because
  the orphaned IPv6-only listener still occupies the port.

Both sides are pinned to the literal IPv4 address `127.0.0.1`.

### Port-checking gotcha

`Get-NetTCPConnection -LocalPort` does **not** report an IPv6-only listener.
It will claim a port is free while `[::1]` is bound. Use `netstat -ano` or a
real connect attempt instead. This cost real debugging time during Phase 0 and
is directly relevant to Phase 1's port-adoption work.

## `strictPort` and the stale dev server footgun

`vite.config.ts` sets `strictPort: true` deliberately: if Vite drifted to
another port, the Tauri window would point at nothing.

The residual hazard: if port 1420 is held by a **stale** Vite server,
`beforeDevCommand` fails and reports a non-zero exit, **but Tauri still
launches the binary** — which then loads the frontend from that stale server.
A fresh window can silently serve old code.

Recorded as `TODO(Phase 3/4)` in `src/lib.rs`. Candidate fixes (not
implemented in Phase 0):

- a pre-flight check that hard-fails when 1420 is occupied, or
- a startup check in `lib.rs` that refuses to run when the dev server was not
  spawned by this process.

## `src/svelte.config.js` lives in `src/`, not the repo root

`vite-plugin-svelte` resolves its config relative to Vite's `root`, which is
`src/`. A root-level `svelte.config.js` is silently ignored and the plugin logs
`no Svelte config found`. Keep it in `src/`.

## Sidecar handshake

The shell learns the sidecar's port from its stdout, and only from stdout:
a single line, `SIDECAR_READY:<port>`.

`sidecar/index.js` also supports a `DSH_DOCK_PORT_FILE` environment variable
that mirrors the port to a file. That is **test-only** — it exists because
confined execution environments block a node-to-node piped stdout capture. The
Rust shell must never read it.

## Test scripts

- `test/window-check.ps1` — confirms a visible native `DSH-Dock` window exists
  via the Win32 API. Run while the app is running.
- `test/packaging-check.ps1` — release packaging gate. See the section below.
- `../sidecar/test/handshake.ps1` — verifies the real stdout handshake contract.
- `../sidecar/test/smoke.js` — sidecar liveness, `/health`, and clean shutdown.

Note: WebView2 does not expose its accessibility tree in this configuration, so
the rendered text of the webview cannot be asserted programmatically
(UI Automation reports zero text elements). Visual confirmation is required for
UI-level acceptance.

## Packaging gate: `test/packaging-check.ps1`

Run this **after** `cargo tauri build` and **before** publishing a release. It is
not part of the build — it is a manual gate over the artifact that build just
produced. Exit code 0 means shippable; 1 means at least one assertion failed and
the failing check is printed with expected vs actual.

```powershell
powershell -NoProfile -File src-tauri/test/packaging-check.ps1
```

It covers the two installer defects found in v0.5.0 — a missing `sidecar/`
payload, and a default install directory that collided with the data directory:

1. `package.json`, `Cargo.toml`, `tauri.conf.json` and the installer filename all
   agree on one version string;
2. the installer exists and is not empty;
3. the payload carries `sidecar\index.js`, `sidecar\lib\control.js`,
   `dsh-dock.exe` and `uninstall.exe` at the root;
4. there is no `resources\sidecar\` — the sidecar must stay exe-adjacent;
5. there is no `sidecar\test\` in the payload;
6. the preprocessed `installer.nsi` sets the default install directory to
   `$LOCALAPPDATA\Programs\DSH-Dock` and has no executable
   `Call RestorePreviousInstallLocation`;
7. everything the run created has been removed again.

### When it refuses to run

The stock NSIS installer terminates a running `dsh-dock.exe` in silent mode:
`nsis_tauri_utils::CheckIfAppIsRunning` matches the image **base name** through
Toolhelp32, so any `dsh-dock.exe` is hit regardless of its path. Killing the
developer's own launcher — which may be hosting the harness session in use — is
not acceptable for a check, so while `dsh-dock.exe` is running the script stops
with exit 1 and installs nothing. Two options:

- close DSH-Dock and re-run, or
- pass `-UseProbeInstaller`: the script compiles its own probe installer from the
  build's preprocessed `installer.nsi` with only that macro neutralized. The
  payload is identical because it comes from the same preprocessed script; the
  probe costs a makensis run (about ten seconds), not a Rust rebuild.

### `-TargetDir`

The render step writes `release/nsis/x64/installer.nsi` into the cargo target
directory that produced the artifact, so the check reads it from there. If you
built with `CARGO_TARGET_DIR` set — for example because the repo's own
`target/release/dsh-dock.exe` was locked by a running launcher — point the check
at that tree:

```powershell
powershell -NoProfile -File src-tauri/test/packaging-check.ps1 -TargetDir <dir> -UseProbeInstaller
```

Otherwise it reads a stale `installer.nsi` and fails assertion 6. When the custom
template marker is missing from that file, the failure message says explicitly
that the preprocessed script is stale output rather than a template problem.

### Safety properties

- Nothing is ever installed to a real location: every install uses
  `/S /NS /D=<throwaway TEMP directory>`.
- `%LOCALAPPDATA%\DSH-Dock` is never read, written or listed, and
  `Remove-SafeDir` refuses any path outside `%TEMP%`.
- Registry keys that a test install writes are snapshotted first and restored
  afterwards, including the `HKCU\Software\dshdock` parent key, so a run leaves
  no trace.

The helpers are reusable — dot-source the script
(`. .\src-tauri\test\packaging-check.ps1`) to load them without running the
checks: `Test-Assertion`, `Remove-SafeDir`, `Invoke-SilentInstall`,
`New-ProbeInstaller`, `Get-RegSnapshot`, `Restore-RegSnapshot`,
`Get-JsonVersion`, `Get-CargoPackageVersion`, `Get-VersionFromInstallerName`.

## Native menu bar

`src-tauri/src/menu.rs` describes the whole menu as pure data:
`menu_plan(state, target_os)` returns a `MenuPlan`, and `build_menu` turns that
plan into a real `Menu`. Because native menus are immutable (section 2.7), any
state change needs a fresh `Menu`; `rebuild_menu` does that, but only when the
plan differs from the one currently on screen. Taking the target OS as an
argument is what makes the macOS shape (application menu first) testable on
Windows.

### Diagnostics

- **`DSH_DOCK_DUMP_MENU_PLAN=1`** — prints the plan for every scenario on every
  platform as JSON to stdout and exits **before** Tauri starts: no window, no
  sidecar, no data-directory access. Any value other than an empty string or `0`
  turns it on. Stdout must be redirected or piped, because the release binary is
  GUI-subsystem (`windows_subsystem = "windows"`). This is the artifact the menu
  gate in `test/menu-check.ps1` asserts against.
- **`DSH_DOCK_MENU_POLL_MS`** — status poll interval in milliseconds. Default
  5000, floor 100. An unparseable value falls back to the default and a value
  below the floor is clamped; either way a warning line is written to
  `launcher.log` rather than the watcher failing to start.

### What a rebuild writes to `launcher.log`

```
[shell] menu rebuild: reason=<initial|status-change|settings-change|poll> duration_ms=<N> status=<label> pid=<pid-or-none> version=<version-or-none>
[shell] menu attached: harness=true main=true
```

The second line is the attach check. Tauri swallows platform attach errors, so
"a menu was recorded for this window" is not the same as "the OS is showing it" —
this line is what makes a silently menu-less window visible in the log.

A poll that finds the same state logs **nothing**. The absence of rebuild lines
is the evidence that the plan gate works: with the harness stopped, a 1s poll
produced no rebuilds at all, because `unavailable` and `stopped` render the same
`● Stopped` label.

### Measured cost

`reason=initial duration_ms=1` on the release build, `duration_ms=0` on the debug
build. The field is truncated milliseconds, so `0` means "under 1 ms". At this
menu size (~25 items) a rebuild is not a performance concern; the cost that
matters is the platform's menu-bar repaint, which is why rebuilds are gated on a
real content change and performed on the main thread (detach and attach then
happen inside one event-loop message, so no paint can land between them).

### The status-label fast path

A full rebuild is a detach/attach of the menu bar per window, and it measured
**~23 ms median (worst 44 ms) on a release build** against section 7.4's 5 ms
target. A status transition changes one line of text and nothing else, so
`rebuild_menu` handles that one case in place:

1. build the would-be plan and compare it with the installed one;
2. if the ONLY difference is the status line's text, look that item up by id
   (`harness.status`) in the installed menu and call `set_text` on it;
3. otherwise rebuild, exactly as before.

muda's `set_text` writes the new string into every `HMENU` the item belongs to and
calls `DrawMenuBar` for each window showing it
(`platform_impl/windows/mod.rs`). So there is no `SetMenu` churn, no client-area
resize, and no moment in which the menu bar is absent.

The window is deliberately narrow. `status_only_change` normalises a copy of the
candidate plan back to the installed status text and compares the two plans, so
any other difference - a tick mark, an enabled flag, the version list, a
different platform shape - declines the fast path and takes a full rebuild.
Structural change therefore still has exactly one code path, and it cannot drift.

It logs under a different name so the two cases can be measured apart:

```
[shell] menu update: reason=poll duration_ms=0 status=● Running · v0.1.5-rc.2 pid=4242 version=0.1.5-rc.2 (status label only, no rebuild)
```

**`Menu::get` is not a tree search.** It is
`self.items().find(|i| i.id() == &id)` — direct children only — and this menu's
direct children are the top-level submenus (Harness, Dock, Settings), so
`harness.status` can never be found through it. `Submenu::get` behaves the same
way. This cost one build cycle: the first fast path looked the item up with
`Menu::get` and fell back to a full rebuild on every single tick. The lookup now
walks submenus recursively, which also means it does not depend on where in the
tree the item lives.

When that lookup fails it says so and lists every id it can reach, so the next
occurrence is answerable from the log alone:

```
[shell] menu update: 'harness.status' is not in the installed menu (ids present: harness, harness.restart, …); falling back to a full rebuild
```

### Menu actions belong to the dashboard, not to the shell

A menu click never performs a harness action in Rust. `handle_menu_event` resolves
the id, forwards the intent as a `menu:action` event carrying
`{ "action": "start" | "stop" | "restart" | "refresh" | "open-logs" }` to the
`main` window, and returns. `src/App.svelte` receives it and calls the very same
function its own button calls. One implementation of each action, two entry
points.

Why this exists: the menu used to call the sidecar over HTTP by itself, so a menu
"Stop Harness" stopped the harness while the dashboard went on showing it as
running. Two implementations of "stop" had drifted apart.

- Forwarded: `restart`, `stop`, `open-logs`. `start` and `refresh` are part of
  the channel but no menu item emits them - section 3.8's menu has no Start (a
  restart from stopped starts the harness) and no Refresh.
- `open-logs` is forwarded AND performed in the shell: revealing a folder has no
  dashboard state to keep in step, so a round trip would only add a failure mode.
- The control panel is the action surface, but the app keeps running when `main`
  is closed and the harness window is still open. An action that cannot be
  delivered is therefore REPORTED, never swallowed:

  ```
  [shell] menu: could not deliver 'stop' - the control panel is not open
  ```

- What the shell still does itself: focusing the control panel
  (`OpenControlPanel`), writing `settings.json` (the auto-update check items), and
  the two placeholders (`Harness Update`, `Dock Update`) that log a notice and
  bring the panel forward. Only the settings write and the logs opener need a
  worker thread; everything else is an event emission or window management.

## The first-run wizard (Pause 4)

Section 3.9. On a first run the dashboard is **hidden** and a small window takes its
place; answering it writes the channel and `first_run_completed = true` in one
atomic write and hands the user to the dashboard with the harness starting.

### The gate

`setup` runs `welcome::gate_decision(settings.first_run_completed())`, which returns
`{show_welcome, hide_main}` and whose two flags are always equal **by design**:
hiding the dashboard without creating the wizard would leave a brand-new user with
no window at all. The block sits after the initial menu rebuild (so the wizard is
created by a process whose menu already exists, giving `clear_welcome_menu`
something to clear) and before the sidecar spawn (so the core starts identically to
every other launch and the wizard is never on the handshake's critical path).

The release binary's log should show, on a first run:

```
[shell] first-run gate: first_run_completed=False show_welcome=true hide_main=true
[shell] window check [after-first-run-gate]: main=visible:false welcome=visible:true
```

and on every later launch:

```
[shell] first-run gate: first_run_completed=True show_welcome=false hide_main=false
```

### The wizard window has no menu bar (two-part guard)

Every window inherits the app-wide menu, and the wizard's capability grants exactly
one command, so a menu there could only ever log `could not deliver`. It is cleared
in **two** places, through one helper (`menu::clear_welcome_menu`):

1. **At creation.** The initial `rebuild_menu` ran *before* the wizard existed, so
   nothing else covers the first-run case.
2. **At the end of every rebuild.** `AppHandle::set_menu` re-attaches the menu to
   every window that has none, so a single clear at creation would survive only
   until the next rebuild. This is what makes it durable - it future-proofs against
   Phase 2's background check firing a rebuild while the wizard is open.

`window.set_menu(Menu::new())` is the "no menu bar" shape; there is no
`set_menu(None)` on a window in tauri 2.

### One submit path, and the in-flight guard

`welcome::submit_and_hand_off` is called by **three** entry points and is the only
thing that writes:

| Entry point | `requested` | reason |
| :--- | :--- | :--- |
| `welcome_submit(channel)` — the button | the channel | `submitted` |
| the window's X (`CloseRequested`, vetoed) | `None` | `dismissed` |
| `DSH_DOCK_WELCOME_ACTION` (diagnostic) | parsed value | `submitted` / `dismissed` |

**The X is the reason `SUBMIT_IN_FLIGHT` exists.** The hand-off *ends by closing the
wizard window*, and closing a window produces a `CloseRequested` event - which
`lib.rs` intercepts so that the X counts as a dismissal. Without the guard those
compose into a regress: the handler vetoes the close (so `close()` never takes
effect), submits again, which closes again, and the wizard sits on screen with the
app apparently frozen. The rule is one hand-off at a time; a close that arrives
while one is in flight is **allowed through** rather than vetoed. No unit test can
see this - it is a property of the event loop - which is why the acceptance script
drives the real path.

A failed write returns `Err`, the wizard **stays open** and shows the message
inline. It is never closed over a write that did not happen: a wizard that vanished
with nothing recorded would simply reappear next launch with no explanation.

### Delivering `install-and-open` reliably (why there is a pending slot)

`main`'s page loads while the window is **hidden**, so at the moment the wizard is
answered its listener may not be registered - and a lost event on a genuine first
run means the user sees a stopped dashboard wondering why "Install and Open
Harness" did nothing.

So the hand-off is an intent with a delivery point, not a blind emit:

1. `menu::arm_install_and_open` stores the payload and emits immediately **if**
   `main`'s page is known to have finished loading.
2. Otherwise it waits for the app-wide `on_page_load` hook to report
   `PageLoadEvent::Finished` for `main` (`menu::mark_main_page_finished`).
3. Delivery is posted to a later turn of the event loop, because `Finished` fires
   when the document completes while the listener is registered by Svelte's
   `onMount` during that same document's evaluation.
4. The stored intent is **cleared once the emit succeeds**, so a later page load
   cannot re-fire a hand-off the user already received. A failed emit puts it back
   for the next load.

The dashboard side is `install-and-open` → refresh, then: `running` → open now;
`starting` → wait; `stopped` → run the **same** `startHarness` its own button runs,
with `pendingOpen` making `refresh` open the harness window when the boot finishes.
One implementation of "start", and "Install and **Open**" is honoured for a cold
install that takes minutes.

`DSH_DOCK_AUTO_OPEN_HARNESS` is unaffected: it checks `harness_window_open` before
acting, and it is a separate diagnostic from this path.

### `DSH_DOCK_WELCOME_ACTION` (diagnostic only)

WebView2 exposes no accessibility tree here, so the wizard's controls **cannot be
clicked programmatically**. Without a hook, the install-and-open hand-off - the one
behaviour that matters most on a first run - would be reachable only by a human
click and could not be asserted at all.

```
$env:DSH_DOCK_WELCOME_ACTION = "alpha"     # rc | alpha | all | dismiss
```

- It is a **trigger, never a second code path**: it calls `submit_and_hand_off`.
- It is a **timer** (a plain thread that sleeps 3s), never a subprocess.
- **Fail-safe:** anything that is not one of `rc`, `alpha`, `all` or `dismiss` is
  logged and **ignored** - the wizard stays open exactly as if the variable were
  unset:

  ```
  [shell] welcome: DSH_DOCK_WELCOME_ACTION='xyz' not recognised; ignoring. Valid: rc, alpha, all, dismiss
  ```

  A stray exported variable must never produce a wrong first run. Falling back to
  `rc` would write a channel the user never chose; leaving the wizard open is the
  only outcome that cannot be wrong.
- Unset, empty and `0` all mean "off", matching `DSH_DOCK_DUMP_MENU_PLAN`.
- Set on a launch that is **not** a first run, it logs and does nothing.

### Window size: inner, not outer — and the probe reports PHYSICAL pixels

`inner_size(500, 300)` sets the **client area** in logical pixels, so the window on
screen is about 39 logical pixels taller once the title bar is added. Section 3.9
says "approximately 500×300" without saying which box; this is the client area, and
`welcome::WELCOME_INNER_SIZE` is the one place it is defined.

**`window probe` reports `inner=` in PHYSICAL pixels.** On a 150%-scaled display the
wizard therefore logs `inner=750x450`, and the dashboard logs `inner=1650x1050`
against its configured `1100x720`. That is correct behaviour, not an oversized
window - but a raw `750x450` cannot be told apart from a wizard that really is half
again too big, so the probe line carries the arithmetic:

```
[shell] window probe [welcome]: hwnd=590962 inner=750x450 logical=500x300 scale=1.5 \
        pos=574,316 visible=true minimized=false
```

`logical=` is `inner=` divided by `scale=`, so "the client area is the 500×300 the
spec asks for" is a subtraction rather than an inference. This is also what makes
macOS Retina and Linux HiDPI checkable rather than guesswork: the raw pixel count
differs per display, the logical figure does not.

### The recorded channel does not yet change what is installed

**Nothing in `sidecar/` reads `auto_update_channel` as of this build.** The wizard
persists the choice - in one atomic write, which is the point of doing it now - and
Phase 2 makes it load-bearing. A future reader should not assume that picking Alpha
in the wizard changes what "Install and Open Harness" downloads today.

### `build.rs` must declare the command

Tauri v2 does **not** auto-discover app commands. `build.rs` keeps an explicit
`AppManifest::new().commands(&[…])` list, and a command missing from it has no
`allow-<name>` permission - so granting it in a capability is a hard build failure:

```
Permission allow-welcome-submit not found, expected one of allow-close-harness-window, …
```

`welcome_submit` is therefore in `build.rs` as well as in `invoke_handler`. Keep the
two in sync. The generated `permissions/autogenerated/welcome_submit.toml` is build
output; never edit it.

### Acceptance: `test/welcome-check.ps1`

```powershell
cargo build --manifest-path "src-tauri/Cargo.toml" --release
powershell -NoProfile -File src-tauri/test/welcome-check.ps1
```

Five cases against the **release** binary (section 7.4: no dev server), each with a
fresh `DSH_DOCK_DATA_DIR` under `%TEMP%`:

1. env var unset → wizard visible, dashboard **hidden**, no auto-submit, nothing
   written;
2. `=alpha` → hand-off delivered, `settings.json` records `alpha` +
   `first_run_completed`, wizard closes, dashboard returns, and a **second launch**
   on the same data dir goes straight to the dashboard;
3. `=dismiss` → the `rc` default is recorded (`dismissed=true`);
4. `=xyz` → the rejection is logged and the wizard **stays open** with nothing
   written - the case that stops a broken hook from making the others pass;
5. plus the menu-clearing and probe lines from case 1.

It never touches `%LOCALAPPDATA%\DSH-Dock` and removes every directory it created
(`-KeepArtifacts` to inspect instead). `Remove-SafeDir` refuses any path outside
`%TEMP%`. The ~5 minute npm install a real first run would trigger is **not**
exercised - that belongs to Phase 2's testing; these cases assert the hand-off and
the settings only.

### Future concern: `.gitattributes` and CRLF

`core.autocrlf=true` with no `.gitattributes`, while every tracked source file is
LF-only. Nothing is broken today, but a `git add -A` with that setting in play could
rewrite line endings across the tree and bury a real diff in noise. A
`.gitattributes` decision belongs in a later revision or Phase 2 prep.

## Shutting the sidecar down

`stop_sidecar` logs its outcome (`the sidecar was terminated` / `could not
terminate the sidecar` / `no child was recorded`), and the exit path logs
`DSH-Dock exiting: stopping the sidecar`. Both exist because an orphaned sidecar
is otherwise invisible: it keeps a loopback port open after the launcher is gone.
Section 2.7 already documents orphaned `node.exe` processes and section 8.1
defers Windows Job Objects to Phase 2, so an orphan after a **hard** kill is
expected until then — these lines are what make the difference between "we never
tried to stop it" and "the kill failed" readable.

**Do not test a launcher's shutdown by closing its console window.** For a
console-subsystem (debug) build, `CloseMainWindow()` and a console close target
the console, and Windows terminates the whole process group with
`STATUS_CONTROL_C_EXIT` (`0xC000013A`): no Tauri shutdown code runs at all, and
the sidecar is left behind. Close the actual DSH-Dock window instead.

## Windows and WebView2: the window that is created and then vanishes

A Tauri window can be created, attached to a menu, and then destroyed a few
hundred milliseconds later — leaving a process that is alive, responding, and
has **no window at all**. `webview_windows()` still lists it, because the manager
keeps the wrapper while the native handle is gone, so nothing in the launcher
could previously tell "hidden" from "destroyed" from "never created".

What the log says now:

```
[shell] window check [setup-start]: main=visible:error(runtime error: failed to receive message from webview)
[shell] menu attached: main=menu:true visible:error(...)
[shell] window probe [main]: hwnd=error(the underlying handle is not available) inner=error(...) visible=error(...)
```

`hwnd=error(the underlying handle is not available)` is
`raw_window_handle::HandleError::Unavailable`: the native window does not exist.
**The `[setup-start]` line is meaningful, not noise.** Tauri creates config
windows - and their webviews - before the `setup` hook runs, so a healthy build
reports `main=visible:true` there. A getter failure at that point means the
webview was already broken before any of our own setup code ran. This is not the
same as a getter failing because the loop is not pumping yet: when the webview
exists, the answer comes back.

**Root cause: WebView2 refuses to initialise at Low integrity.** Two ways to get
there, one mechanism: the executable (or a folder above it) carries a
`Mandatory Label\Low Mandatory Level` integrity label - on this repository it had
been inherited into `src-tauri\target\debug\` from the tree itself - or the
launching process token is Low, in which case children inherit it. A shell that
runs its commands at Low integrity cannot host a Tauri window at all, whichever
binary it launches, released ones included. That is exactly what was measured
here: the shipped v0.5.1, a build of the pre-menu-bar sources and the current
build all showed the window appearing and disappearing within ~200-500 ms, each
with **zero `msedgewebview2.exe` processes**, because WebView2 never starts and
wry tears the window down. Pointing `WEBVIEW2_USER_DATA_FOLDER` at a writable
path changes nothing: the problem is integrity, not the profile path.

A healthy run looks like this instead:

```
[shell] window check [setup-start]: main=visible:true
[shell] menu attached: main=menu:true visible:true
[shell] page load started [main]: http://tauri.localhost/
[shell] page load finished [main]: http://tauri.localhost/
[shell] window probe [main]: hwnd=1574662 inner=1650x1050 pos=124,1 visible=true minimized=false
```

### Diagnosis

> If a fresh `target\debug` build renders no window AND `window probe [main]`
> reports no handle AND the same binary works from a different path - check the
> folder's integrity level with `icacls <path>`. A `Low Mandatory Level` label on
> the repo tree blocks WebView2 initialization.
> Fix: `icacls <path> /setintegritylevel "(OI)(CI)M" /T /C`.

```powershell
# 1. the executable's own label, and its folder's
icacls "src-tauri\target\debug\dsh-dock.exe"
icacls "src-tauri\target\debug"

# 2. the integrity level of the process that launches it (children inherit it)
whoami /groups | Select-String "Mandatory Label"
```

A `Low Mandatory Level` from either command is the answer. Both were seen in this
repository's history: the folder carried the label, and the sandboxed shell that
ran the tests was itself Low integrity.

### Fix

```powershell
icacls "<repo>" /setintegritylevel "(OI)(CI)M" /T /C
```

Verified on this repository: ~49,000 files reset to Medium, no failures, and the
window then reported `visible=true` and stayed up.

### Rule

If `window probe` reports no handle, the menu is not the suspect and neither is
the Rust code - check the two integrity labels above. If it reports a real handle,
a real size and `visible=true`, the window exists, and any remaining complaint is
about menu content or clicks.

---

# Phase 2A: the version library (backend)

Everything in this section is `sidecar/` only. No UI, no menu, no Tauri command, no
registry polling and no Job Object work happens in Phase 2A - those are 2B, 2C and
2D. The phase exists to make `<data-dir>/versions/` hold **N versions cleanly** and
to make an install verifiable rather than merely finished.

## The module split, and why it is four files

| Module | Owns |
| :--- | :--- |
| `library.js` | Enumeration, the three states, path containment, path identity, deletion, cache-limit candidate selection |
| `validation.js` | "Is this tree complete?" - pure filesystem checks, structured problem codes |
| `catalogue.js` | The advisory `versions/catalogue.json` index: dates, sources, checksums |
| `library-lock.js` | The advisory `<versions>/.lock` that serializes library mutations |

The split is by QUESTION, not by layer. A single `versions.js` was rejected because
the four questions have different failure semantics: validation must never throw,
the catalogue must never be authoritative, the lock must never be permanently
unacquirable, and only `library.js` may destroy anything.

`version-manager.js` was deliberately NOT converted into this module or into a
directory. It stays what it already was - a constants home (`HARNESS_PACKAGE`,
`DEFAULT_VERSION_LIMIT`, `CHANNELS`) - so Phase 2A did not churn every import for
no functional gain.

## The three-state model: `installed` / `partial` / `absent`

`readLibraryEntry(version)` returns exactly one of:

- **`installed`** - the directory exists AND the tree validates. The only state that
  means "this can be run".
- **`partial`** - the directory exists but the tree does not validate, or it carries
  an `.incomplete` marker. This is what an interrupted install leaves behind.
- **`absent`** - no directory.

Three states rather than two because "not here" and "here and broken" need
completely different UI and completely different repair, and before Phase 2A nothing
in the codebase could tell them apart. `partialInstallDirs()` reports the leftovers
(staging directories, marker-bearing directories, quarantined catalogues) and
`listReadyVersions()` filters to the runnable ones.

**Ordering is deterministic**: primary key `installedAt` descending (section 3.8's
"recent versions by date"), versions with no catalogue entry after the dated ones,
then version-string descending. An unordered list feeding a menu is a bug that shows
up as a reshuffling menu.

## The catalogue is ADVISORY. The filesystem is the ground truth.

`<data-dir>/versions/catalogue.json`:

```json
{ "schemaVersion": 1, "updatedAt": "<iso>", "versions": {
    "<version>": { "installedAt": "<iso>", "source": "next", "installDir": "<version>",
                   "checksum": "sha256:<64 hex>", "validatedAt": "<iso>",
                   "package": "@deepseek-ai/dsh" } } }
```

Four rules, each pinned by a test, each of which makes the file impossible to
mistake for a source of truth:

1. **A version on disk with no entry is still installed.** Enumeration reads the
   filesystem; the catalogue only supplies dates.
2. **An entry with no version on disk is ignored.** The install directory is derived
   from the *validated version name*, never from the stored string, so a hand-edited
   entry cannot redirect a delete, a switch or an enumeration.
3. **A missing, corrupt, oversized or newer-schema catalogue degrades to
   filesystem-only enumeration.** A corrupt file is MOVED aside to
   `.corrupt-<timestamp>` (never deleted - it may be the only record of what the
   library held) and the library still enumerates.
4. **A catalogue write failure never fails an install.** By the time it is written
   the version is on disk and validated; the result reports
   `catalogue: "recorded" | "unrecorded (reason)"` and the install stays successful.

`installDir` is stored **relative to the library root**: an absolute path is
machine-specific, and copying a data directory to another drive would otherwise
leave every entry pointing somewhere that no longer exists.

`checksum` is sha256 of `node_modules/@deepseek-ai/dsh/package.json` - small, stable
in content, and enough to catch a truncated or substituted install. It is NOT a
whole-tree hash: hashing a full install is hundreds of megabytes and must never run
during enumeration (`checksums: true` opts in, and the live report uses it).

`listInstalledVersions` does not read the catalogue at all. Dates arrive through an
`installedAt` map the caller passes in (`catalogue.readInstalledAt()`), which is why
the advisory guarantee is structural rather than a discipline.

## Installs: staged rename, with an in-place fallback

`installVersion(version, options)` installs into
`<versions>/.staging-<version>-<nonce>` - a **sibling** of the target, so the rename
can never cross a volume boundary - validates there, and only then renames onto
`<versions>/<version>`.

**The invariant: the final path only ever appears in a validated state.**

A tree that fails validation ABORTS (a second npm run with the same flags produces
the same broken tree, so falling back would only double a large download). The
fallback exists for **environmental** failures - npm not populating the staging
prefix, or the rename not landing - because installing in place is a genuinely
different attempt. `approach: "staged" | "in-place"` and `fallbackReason` are
reported on every result, so a silent downgrade is impossible.

`fs.renameSync` cannot replace an existing directory on this platform, so a `force`
reinstall moves the old tree aside to `.staging-<version>-replaced-<ts>`, installs,
then removes the backup. If the final rename fails the backup is **renamed back**, so
a failed reinstall is never how a user loses a version. That restore branch is
covered by an injected-rename test (`options.rename` is a test-only seam; a real
`EPERM`/`EXDEV` cannot be provoked inside one temp directory).

**Live confirmation (2026, Phase 2A Step 5).** Two real published versions
(`0.2.0-rc.1`, `0.2.0-rc.2`) were installed with real npm on Windows:
`approach=staged` for both, ~162s and ~64s, no staging leftovers, and a library root
containing exactly the two version directories plus `catalogue.json`. **The
`--prefix` staging question is settled: npm honours a sibling staging prefix on
Windows**, and the in-place fallback is a safety net rather than the production path.

Two incidental findings from the same run:

- The harness package itself is small (**~74 KB unpacked, 20 files**); the ~370 MB /
  543 packages is its **dependency tree**. First-run cost estimates should quote the
  tree, not the package.
- `npm --prefix <dir>` writes its own `package.json` and `package-lock.json` into
  `<dir>`, alongside `node_modules`. Both are harmless artifacts inside a version
  directory. Because the staged form is what now runs, nothing lands in the library
  root.
- `@deepseek-ai/dsh-web-app` is a declared runtime dependency of `@deepseek-ai/dsh`
  and npm **hoists it to a sibling of `dsh`** in `node_modules/@deepseek-ai/`. The
  validation resolver checks the hoisted location first and the npm conflict layout
  (`dsh/node_modules/@deepseek-ai/...`) second, so both layouts validate.

## The `.incomplete` marker (fallback-only)

The in-place path writes `<versions>/<version>/.incomplete` **before** npm runs and
deletes it **only after validation passes**. `listInstalledVersions` treats any
directory carrying it as `partial` regardless of whether `bin.js` exists - which
matters, because a stale `bin.js` from an earlier attempt otherwise makes a marked
directory look installable.

The marker is never written on the staged path. On a failed install: a directory this
attempt CREATED is removed entirely (so "the target is absent" reliably means "not
installed"), while a directory that pre-existed keeps its content and its marker.

`validateInstallTree` therefore takes `checkMarker`:

- `true` (default) - "is this complete AND finished?". What `library.js` asks.
- `false` - "is this complete?". What the in-place installer must ask, because it
  plants the marker itself. The first in-place install failed on its own bookkeeping
  before this split existed.

## Guards: the running version cannot be overwritten or deleted

`installVersion(..., {force: true})` and `deleteVersion()` both refuse the version the
recorded harness is running from, with the same sentence:

```
Refusing to overwrite the running version <V>; stop the harness or choose another version.
Refusing to delete the running version <V>; stop the harness or choose another version.
```

Both route through one predicate, `library.resolvesToSamePath`, because two guards
that disagreed about "the same path" would let one fire and not the other, and the
failure mode is destroying the tree the user is working in. It handles trailing
separators, separator flavour, Windows casing, `.`/`..`, and `realpathSync` for 8.3
names and symlinks.

Why the guard exists at all: on Windows, renaming over - or deleting - a running
process's tree fails with `EPERM`/`EBUSY`, which is self-protecting but arrives after
minutes of npm work with a useless message. The guard converts it into a refusal
before anything is touched. A **non-forced** install of an already-installed version
still short-circuits rather than refusing, so the section 3.3 fast path is intact.

## Deletion

`deleteVersion` runs every guard before any mutation: exact-version name (dist-tags
and ranges are refused, not treated as absent), containment computed from the
validated name, the running-version check, and the `.incomplete` marker. It takes the
same library lock installs use, around the `rmSync` and the catalogue removal -
concurrent install+delete would otherwise both rewrite `catalogue.json`.

- **`dryRun` takes no lock and removes nothing**, and returns file/directory/byte
  counts. That is the seam 2C's storage prompt calls: section 3.1 requires that
  exceeding the cache limit PROMPTS, never silently evicts.
- **`deletePartialVersion`** is the explicit cleanup for a marked or broken tree - a
  thin wrapper over one implementation, so the guards cannot drift. It still refuses
  the running version: "this tree is broken" is not a licence to delete the harness
  that is serving.
- **`selectVersionsToDelete`** produces prompt CANDIDATES and deletes nothing -
  partial installs first, then oldest first, never the running or pinned version. The
  "prompt, never silently evict" rule is expressed as code that structurally cannot
  evict.

## The library lock

`<versions>/.lock`, created with `fs.openSync(..., "wx")` - exclusive creation, atomic
on NTFS and POSIX, so there is no read-then-write race in acquire. Stale after 15
minutes (the install budget is 10, so the timeout fires first), or immediately if the
recorded pid is gone. Release checks ownership first, so a process whose stale lock was
taken over never deletes the new holder's lock.

`withLock` is async-aware. A helper that released when the body returned its *promise*
would drop the lock at the start of the work.

The honest limit: this is an advisory lock against the launcher's own processes and a
cooperative operator. It is not a security boundary and a determined external writer
can ignore it.

## Two lessons that cost real debugging time

**A rule stated in two modules must be pinned by a test that compares them.**
`isSafeVersionName` exists in both `library.js` and `harness-install.js`. In Step 3 the
install module's copy was tightened to reject dist-tags, and the library's copy was
not. The consequence was not a crash: `deleteVersion("next")` would have reported
`not-installed` instead of refusing - a *plausible, silent, wrong answer* that 2B's tag
resolution could have fed into a delete path. Step 4 also lost `isVersionDirName` the
same way. The fix is a test (`sidecar/test/library.js`) that runs one accept/refuse
list through both modules and asserts they agree on every case. Testing each module
against its own expectations does not catch a divergence.

**A guard chain must never throw; it must refuse.** `planDelete` and
`runningVersionInfo` both called `installDirFor`, which throws for a name that cannot
be a directory - so `deleteVersion("../../evil")` crashed instead of returning a
refusal with a reason. The first guard in every chain is now "can this even be a
version?", and the "unsafe" path returns a result rather than raising.

Two smaller traps that produced confusing symptoms:

- **An `async` function's throw is a rejected promise, not a synchronous throw.** A
  test that called `installVersion` without `await` inside `try`/`catch` never caught
  anything AND left a real install running in the background holding the library lock,
  which then failed every later section of that file. If `install-flow.js` ever shows a
  flaky "lock is held" symptom, look for a missing `await` first.
- **`import()` needs `pathToFileURL` on Windows.** A bare drive-letter specifier fails
  with `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`. Any test that spawns a
  Node child which imports a module by absolute path must convert it first.

## The libuv Job Object finding (this changes Phase 2D)

Section 8.1 deferred "Windows Job Object for orphan prevention" to Phase 2. The
research says the mechanism already exists and the deferral's premise was wrong.
From libuv's Windows spawn implementation (`deps/uv/src/win/process.c`), which Node
uses for every `child_process` spawn:

1. libuv creates a **per-process job object** on the first non-detached spawn, with
   `JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK |
   JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
   and assigns the Node process itself to it.
2. Every **non-detached** child is assigned to that job. A **detached** child is not -
   and libuv's comment explicitly declines to set `CREATE_BREAKAWAY_FROM_JOB`, because
   that flag makes `CreateProcess` FAIL when the process is already inside a job that
   disallows breakaway.
3. `SILENT_BREAKAWAY_OK` is what makes the detached harness survive: a process already
   inside a job may create children that are not placed in that job when the job allows
   silent breakaway, which libuv always sets.

Consequences for this project:

- **The sidecar already dies with the launcher.** It is a non-detached child of the
  launcher, whose libuv job has `KILL_ON_JOB_CLOSE`. No new code is needed for that.
- **The harness already survives the launcher, by design** - that is exactly what makes
  section 2.3's adopt/reap work, and it is libuv's behavioural guarantee, not luck.
- **`CREATE_BREAKAWAY_FROM_JOB` is therefore unnecessary**, and using it would be
  riskier than doing nothing: it fails outright under a restrictive outer job.
- Node's `child_process` cannot create or assign a job of its own (libuv asserts its
  flag set is limited to `DETACHED`, `SETUID`/`SETGID`,
  `WINDOWS_FILE_PATH_EXACT_NAME`, `WINDOWS_HIDE*`, `VERBATIM_ARGUMENTS`). If the
  sidecar ever needs its own job, that requires a native addon - colliding with Phase
  4's "bundled Node runtime, no compile step" - or launcher-side spawning, which breaks
  the thin-shell rule.

So 2D is **"decide and document", not "build native code"**: when the launcher is
force-killed and the harness survives by design, is that correct? The current answer is
yes - the next launch's adopt/reap either reuses it or reaps it - and what 2D owes is a
recorded decision plus a test proving the launcher's force-kill does not orphan the
*sidecar*. The orphans actually observed in Pause 3/4 testing were sidecars left by
force-killed **test** runs, not harnesses.

## Tests, and the `RUN_LIVE=1` gate

All offline suites are dependency-free scripts run directly (`node sidecar/test/<file>.js`),
matching the existing convention - no framework, no `node:test`, no new packages:

| Suite | Covers |
| :--- | :--- |
| `library.js` | Names, containment, the three states, ordering, leftovers, and the cross-module version-name pin |
| `catalogue.js` | Round-trip, corruption and quarantine, write failures, the advisory guarantee |
| `install-flow.js` | Staged rename, the fallback, the marker, the running guard, the lock (incl. cross-process) |
| `library-delete.js` | Every refusal, dry run, real delete, the backup-restore path, cross-process locking |
| `library-select.js` | Cache-limit candidate selection (pure, deletes nothing) |
| `library-probe.js` | Read-only diagnostic: prints the library the way the launcher sees it |
| `version-switch.js` | Phase 2B: the switch guard order, repair-after-stop, failure states, `$DSH_HOME` passthrough, the CROSS-PROCESS lock probe |
| `version-registry.js` | Phase 2B: `/registry/versions` projection against a loopback stub registry |
| `version-progress.js` | Phase 2B: the job model, the phase vocabulary pin, reconnect-after-completion |
| `library-probe-rewire.js` | Phase 2B: the rewire against the REAL Phase 2A trees (read-only, writes nothing) |

**`sidecar/test/library-live.js` is the network tier and is opt-in.** It is gated by
`RUN_LIVE=1` (the Phase 2 plan's name); `DSH_DOCK_TEST_INSTALL=1` is also accepted,
because that is the existing sidecar convention and silently skipping an
explicitly-requested ~12-minute network test is the more expensive mistake. It
installs **two** real versions, because one proves an install and two prove the library
actually holds N.

```powershell
$env:RUN_LIVE='1'; node sidecar/test/library-live.js
$env:RUN_LIVE='1'; $env:DSH_DOCK_LIVE_VERSIONS='0.2.0-rc.1,0.2.0-rc.2'; node sidecar/test/library-live.js
```

**It refuses to run unless the data directory is under a temp root and NOT under
`%LOCALAPPDATA%`.** That is checked before any import that could resolve a path,
because the user's live install is `%LOCALAPPDATA%\DSH-Dock\` and is running the
session. `DSH_DOCK_LIVE_DATA` overrides the default (`<repo>/.test-tmp/library-live`),
which is PRESERVED after a run for inspection. npm's cache is redirected inside the data
directory with `--cache`, so the user's global npm cache is never touched.

A re-run against a preserved library asserts the **fast path** instead of the install,
because both versions are then already present - the first version of that loop
asserted "it installed" unconditionally and failed on a correct re-run.

## Phase 2B: the decisions this phase is built on

Recorded BEFORE the code, so a later reader sees *why* each choice was made rather than
having to infer it from a diff. Sources: the Phase 2B kickoff brief, the Step A read, and
the owner's ten answers.

### Q73 - Transport for the new routes: narrow typed commands

The frontend never speaks HTTP to the sidecar. `proxy_control` is `pub(crate)` and the
dashboard reaches it through three `#[tauri::command]` wrappers, so every new route needs
three things: a command in `lib.rs`, an entry in `build.rs`'s
`AppManifest::commands([...])`, and a grant in `capabilities/default.json`.

**Decision: five narrow commands** - `versions_list`, `versions_download`,
`versions_progress`, `versions_switch`, `versions_delete`. A single parameterized proxy
command was considered and **rejected**: it would widen the main window's reach to every
route the sidecar ever grows, which is the same reason `proxy_control` is not `pub` in the
first place. A command missing from `build.rs` has no permission identifier and fails the
build, which is the safe direction to fail in.

### Q74 - Menu-initiated switch bypasses the dashboard

Unlike `start`/`stop`/`restart`, which route through the dashboard to keep its state in
step, `switch` dispatches directly from the shell to the sidecar on a worker thread.
Rationale: a switch can take seconds to minutes and must not depend on the dashboard
window being open. The dashboard's state is recovered by its existing status poll.

This is the **only** exception to section 3.8's "menu handlers do not call the sidecar"
rule, and it is narrow: the action is still ONE implementation (the sidecar's switch
route), reached from two entry points (the menu's worker thread, the dashboard's button).
The rule itself stands for every other action, because those are fast and synchronous and
the dashboard owns their visible state.

### Q75 - Recent Versions data path: `/harness/status` gains `recentVersions`

The shell populates `MenuState.recent_versions` from the status payload it already polls
every 5 s, so the menu and the dashboard cannot disagree about the version list.

**The payload carries the WHOLE library, not the menu's five.** `recent_versions_submenu`
keeps its own `RECENT_VERSIONS_LIMIT = 5` cap on what it displays, because "Show all
versions..." must open a manager that holds every version while the submenu shows five.
Sending only five would make the manager unable to show what its own label promises.

**Measured before adopting this design.** `listInstalledVersions` + `readInstalledAt` over
the two real 2A trees: **1-6 ms** (best/worst of six runs). Cheap enough for the poll, but
it is O(versions) with roughly three `stat` calls and a catalogue read per version, and the
dashboard polls at 500 ms. A 1 s memo inside `control.js` keeps the poll and the UI from
stacking; if Step 10 shows it still matters, the next step is mtime invalidation.

**A separate change guard is required in `menu.rs`.** `update_harness` compares only
status/version/pid/error, so a populated `recent_versions` would be silently dropped and
the submenu would never populate - a silent no-op, which is the failure mode section
2.8.4's log-and-fall-through philosophy exists to prevent. `update_library` therefore has
its own guard and its own `RebuildReason`.

### Q76 - Cold-start ordering: version-string order, never mtime

A library with no `catalogue.json` (a Phase 1 install, a hand copy, live-test residue) has
no `installedAt` dates. The Recent Versions submenu falls back to the order
`listInstalledVersions` already produces - dated entries first, newest first, then undated
entries by version string descending.

Silently substituting directory mtime was **rejected**: mtime is a guess about install time
(an antivirus touch, a backup restore or a `git checkout` all move it), and this project
does not guess. A library that has never been catalogued simply has no dates, and the menu
shows that honestly.

### Q77 - `MIN_SUPPORTED_DSH` is a verified floor, and it badges rather than omits

The value is `"0.2.0-rc.1"`: **the oldest version this project has verified install + boot +
switch** (section 3.2's own phrasing). It is a claim about what has been demonstrated, NOT a
compatibility boundary and NOT a guarantee about anything older.

**Enforcement is Q14's "warn once, never block".** `/registry/versions` marks sub-minimum
entries with `belowMinimum: true` and carries `minimumSupported` in the payload; the UI
badges them. Omitting them from the list would be blocking by another name, and the user is
sovereign.

### Q78 - Which surface "Show all versions..." opens

`SHOW_ALL_VERSIONS_ENABLED` flips to `true` and the label drops its `(Phase 2)` suffix. The
menu remains a pure shell surface: the click emits `menu:action` with the plain action name
and the dashboard decides what to reveal, exactly as every other menu action does. The shell
keeps no notion of a version section, so no new constant or grant is needed.

This is deliberately different from the `OpenControlPanel { tab }` route used for
Settings/About, and it is the better shape for Phase 3: when the dashboard grows real tabs,
only the dashboard's routing changes.

### Q79 - `CHANNELS.RC = "latest-rc"` is stale; out of scope

`version-manager.js` still maps the RC channel to a dist-tag that does not exist. The
registry's real tags are `alpha` / `next` / `latest`, and `registry.js` resolves the RC
channel as `next -> latest -> hard failure` (section 3.1's note). The 2B registry route reads
dist-tags off the packument and never consults `CHANNELS`, so the constant is inert here.

**Flagged, not changed.** It gets fixed when `version-manager.js` is next touched (likely
2C's update-check work). Recorded so a reader does not mistake it for a 2B oversight.

### Q80 - The switch does not roll back a failed boot

On a failed switch the user ends up with the harness **stopped**, `lastError` naming the
failing step with its log tail, no new `runtime-state.json`, the target version on disk in
whatever state it reached (`partial` if npm failed validation), and the previous version
still installed and one click away.

**Recommendation adopted: no automatic rollback.** Three reasons.

1. **It cannot preserve what it appears to.** The harness was already stopped and its
   per-boot token is already dead, so "rolling back" is a second stop-and-start cycle
   arriving at a URL that is not the one the user was on. The session was lost at the stop
   regardless; rollback recovers convenience, not state.
2. **It fights the user's intent.** The user asked for version X and would silently get
   version Y. A tool that quietly undoes your instruction is worse than one that stops and
   says why.
3. **It doubles the failure surface.** The rollback can itself fail - and the previous
   version may be the very partial tree that prompted the switch - leaving a third state
   that has to be explained.

**Accepted consequence:** a failed switch leaves no harness until the user acts, and the
error text is the only diagnostic. A one-click "Switch back to v{previous}" affordance is
offered in the error card, which is a convenience over the same switch route and runs only
on a click - not a rollback.

### Q81 - Progress is a polled state field

`GET /versions/progress` returns the current job. SSE and long-poll were both considered
and **rejected**:

- **It is the pattern this codebase has already paid for.** `/harness/start` answers 202
  immediately and the UI polls `/harness/status`; `control.js` already carries a `progress`
  string for a multi-minute boot. A second, differently-shaped progress channel would be two
  mechanisms for one concern.
- **The data is coarse and tiny** - four phases and a version string over minutes. SSE's
  advantage is high-frequency fan-out, which is not the shape of this problem.
- **Polling is stateless, which is what makes reconnect trivial.** SSE and long-poll both
  require the client to re-establish and then reason about what it missed.
- **Both alternatives interact badly with shutdown.** `service.js`'s `dispose()` awaits
  `control.settled()` and then closes the server; an open event stream or a held long-poll
  request would need that contract special-cased.

**The job object retains the LAST FINISHED job**, which is what makes this reconnect-safe
rather than merely pollable: a poll arriving after completion still learns the outcome.

**Phases are honest, not cosmetic:** `resolving` (registry fetch) / `downloading` (npm is
running - genuinely the network-and-disk bulk) / `linking` (the staged rename, or the
in-place marker removal) / `validating` (`validateInstallTree` on the final tree, plus the
catalogue write). Reached through a new OPTIONAL `onPhase` callback threaded from
`installVersion` down to the npm run, so every existing suite keeps passing untouched.

**A switch's progress does not use this route.** A switch IS a start from the harness's point
of view, so its `stopping -> installing -> starting` phases ride on `/harness/status`'s
existing `starting` + `message` fields, which the dashboard's 500 ms poll already renders.
One mechanism per concern: `/versions/progress` owns installs, `/harness/status` owns boots.

**On reconnect the UI reads `/versions/progress` and `/harness/status` unconditionally and
never trusts cached local state.** If the sidecar itself restarted, its in-memory job is gone
and the honest answer is `busy: false` with no job - the inventory becomes the source of
truth, and a directory in state `partial` IS the visible debris of an interrupted install.
That is the same "filesystem is ground truth, bookkeeping is advisory" rule the catalogue
follows, applied to progress: an interrupted install is not remembered, it is observed.

### Q82 - Guard order for a switch, and why the library lock is probed BEFORE stopping

A switch is `stop -> (install only if needed) -> spawn -> record`, with this guard order:

1. validate the version name (`isSafeVersionName`) before any path is built;
2. read the version's library state;
3. **probe the library lock (read-only) and refuse BEFORE stopping** if a download holds it;
4. refuse if another 2B job is in flight;
5. stop the recorded harness (identity-checked - a `mismatch` aborts the switch);
6. install only when the state is not `installed`, and let `installVersion` take the lock
   implicitly, so 2B adds no second lock discipline;
7. spawn, wait for readiness, and only then write `runtime-state.json`.

**Why step 3 exists.** Without it, a switch that races a download would stop the harness and
*then* hit `LibraryLockedError`, losing the user's session to a bookkeeping collision. The
probe converts that into a refusal that costs nothing. A race between the probe and the
install remains possible and is handled as a failure, not as a hang.

**Why the lock is NOT taken around the stop.** That would serialize a stop behind a
multi-minute install and turn a clean refusal into an apparent hang.

**Why the install happens AFTER the stop.** `installVersion`'s running-version guard fires
even on a non-force path once the short-circuit misses (`isInstalled` ->
`isInstalledAndValid`, Q83). So a `partial` tree that is also recorded as running would turn
today's silent skip into a hard `InstallError` refusal. Stopping first is what makes the
repair path work, and the ordering is pinned by a test that asserts the state file is
already cleared at the moment the install is invoked.

### Q83 - The `isInstalled` -> `isInstalledAndValid` rewire

The rewire lands in `ensureVersionInstalled` (the start path's entry point), not in
`installVersion`'s short-circuit. Two reasons:

1. The Phase 2A note at `harness-install.js` names this exact seam, and 4.3 records the
   contract as "one caller today (`control.js`'s start path)".
2. `installVersion`'s own short-circuit stays `isInstalled`, so the forced-recovery behavior
   pinned by `install-flow.js` ("a force install recovers a marked directory") does not
   change meaning.

**The behavior change, stated exactly:** a version whose tree is incomplete - missing
`bin.js`, missing `@deepseek-ai/dsh-web-app`, or carrying `.incomplete` - is now "not
installed" for the purpose of starting the harness, so it is repaired instead of adopted.

**One test in `install-flow.js` had to change with it, and that is the point of the test.**
The section "a marked directory becomes installed once a good install completes" asserted
`skipped === true` for a non-forced install of a `.incomplete`-marked tree, with the comment
"this is exactly why the isInstalled rewire is deferred to its own step". Under the rewire
that assertion inverts: the marked tree is no longer skipped, it is rebuilt. The test now
asserts the new contract and keeps the old observation (`isInstalled` still says yes) as the
reason the rewire was needed.

**The residual risk, recorded:** for a Phase-1 tree that BOOTS but fails validation - the
realistic case being a `dsh-web-app` that npm hoisted somewhere our two candidate paths do
not cover - the user's near-instant startup becomes a multi-minute reinstall against the
network, and if npm is unreachable it becomes a cold start that previously worked and now
fails. `isInstalled` only ever checked `bin.js`, while `library.js`'s enumeration has ALWAYS
used full validation, so the rewire does not create an inconsistency - it removes one, at the
cost of making the start path strictly stricter than it was. If a real version is found to
fail validation, that is a validation bug to fix BEFORE the rewire ships: calling a working
install broken is worse than the failure the rewire prevents.

### Three bugs the rewire exposed, and what caught each

Recorded because all three were INVISIBLE to reasoning and immediate to a test. Each is a
different class of mistake, which is why they are worth naming separately.

**1. A decision that did not survive delegation (caught by `install-flow.js`).**
`ensureVersionInstalled` asked the strict question, correctly concluded "this tree does not
validate, rebuild it", and then called `installVersion` - whose OWN short-circuit still asked
the historical `isInstalled` question, saw the stale `bin.js` that a partial tree usually
has, and returned `{ skipped: true }` WITHOUT INSTALLING ANYTHING. The start path would have
reported success and adopted a tree it had just proved incomplete: the rewire would have been
inert, and the bug would have looked like success. Fixed by `skipShortCircuit`, which carries
the caller's verdict down instead of letting a cheaper check contradict it. The option is
deliberately NOT `force`: force means "reinstall even though it IS installed", while this
means "the decision is already made".

**2. A flag that was read but never applied (caught by `control.js`).**
`readLibraryEntry`'s cheap path (`validate: false`) computed `hasIncompleteMarker` - and then
reported the state from `hasBin` alone. A directory carrying `.incomplete` *with* a surviving
old `bin.js` therefore read as `installed`. That is exactly the trap the marker exists to
close, and the new status payload would have shown the user an installable version that the
start path was about to reinstall. Fixed by making the marker decisive on the cheap path too:
`validate: false` means "do not walk the tree for package.json files", not "ignore the one
stat that settles the question".

**3. A cache handed out by reference (caught by `library-probe-rewire.js`).**
`librarySummary()` memoizes for 1s and returned `{ ...value, stale }`. A shallow spread
copies the container but not the array inside it, so any caller doing
`summary.versions.push(...)` was writing straight into the cache - every later reader would
see a version that does not exist. Only the real-library probe found it, because only it
mutated what it was handed and then asked again. Fixed by `copySummary`, which copies the
array and each entry.

**The lesson this phase keeps re-teaching:** the two most dangerous bugs here were a
*correct* decision that was silently reversed one level down, and a *reported* value that
disagreed with the decision. Both were invisible in a diff and instant in a test - which is
why the rewire landed with assertions on BOTH seams (the start path repairs, `installVersion`
stays idempotent) rather than on one.

**One measurement changed a design detail.** The status payload's version list could have used
full validation per version; measured on the two real 2A trees that is **2.40 ms/call versus
0.20 ms/call** without it - twelve times the cost, because validation opens and reads a
`package.json` per version. The list therefore uses `validate: false` plus a 1s memo, and the
strict question is asked in exactly one place: the start path. The two agreeing on the REAL
trees is asserted by `library-probe-rewire.js`, which is the check that matters, because a
disagreement there means the UI offers a version the start path will silently reinstall.

**And the cheap probe had to be FIXED, not merely trusted.** `validate: false` first decided
from `bin.js` plus the marker alone, so a tree with `bin.js` but no `@deepseek-ai/dsh-web-app`
read as `installed`. The 2A suite had a test that ASSERTED that wrong answer ("the cheap probe
(validate:false) calls a bin-only tree installed"), which is why the gap survived: the test
pinned the bug instead of catching it. The predicate now lives beside the authoritative one as
`validation.js`'s `hasRequiredEntries`, and `library.js`'s new cross-module section walks EVERY
fixture asserting the cheap and strict verdicts agree, with the single allowed divergence (an
unparseable manifest, which the cheap route cannot see) named explicitly and asserted to err
toward `installed` - the safe direction, because the start path is the strict one.

### Q84 - The pre-stop lock probe borrows `acquireLock`'s verdict

`VersionManager.lockHeld()` asks `acquireLock` whether the library lock is takeable, releases
immediately when it was, and reports the result.

**Why not hand-roll it from `readLock` + `isLockStale`.** The first implementation did, and got
an important case BACKWARDS. `readLock` returns `null` for both "no lock file" and "an
unreadable one", and `isLockStale(null)` is deliberately **stale** ("the lock file is
unreadable, so it cannot be a live holder") - a rule `install-flow.js` already pins. A probe
that treated an unreadable lock as HELD would therefore be STRICTER than the install it guards:
it would refuse a switch, telling the user to fix a file that `withLock` was about to take over
and replace anyway. Deriving the verdict from `acquireLock` makes the probe and the mutation
disagree only if `library-lock.js` itself changes.

**The cost, stated:** a definite "no" writes and deletes a lock file. That is a filesystem
round trip on a path that is about to do one anyway, and it is the only way to ask the real
question. The one case that gets a message rather than a verdict is a lock that cannot even be
CREATED (permissions, bad path): that is reported as held, with the real error attached, because
refusing is the safe direction when the library may be unwritable.

### Q85 - A failed switch ends in `error`, not `stopped`

`control.js` reports `error` whenever `lastError` is set and nothing is recorded. A switch whose
stop succeeded and whose start then failed therefore leaves the status as **`error`** with
`lastError` carrying the boot failure and its log tail - not `stopped`.

That is the existing contract, and 2B adopts it rather than inventing a fifth state: `error` is
already what the dashboard renders as a recoverable card with Retry, and "the last start failed"
is precisely what happened. The properties that matter are unchanged and asserted: no
`runtime-state.json` survives, no phantom `running`, and the job carries the failing step with
the underlying message.

**Consequence for the UI:** the dashboard will show the error card with the boot log tail, and
the version list still holds the previous version, so the way back is one click. That is Q80's
no-rollback decision made visible.

### Q86 - A download does not start anything

`/registry/download/<version>` installs and stops there: the job ends `ok` with reason
`installed`, `runtime-state.json` is untouched, and no harness is started. This is worth stating
because the SWITCH route reuses the same job machinery and does start a harness, and an
assertion in `version-switch.js` initially expected a download to fail at a start step it never
performs. The download is the "add this version to my library" operation; making it also change
what is running would be two user decisions behind one button.

### A naming collision worth recording (`version-jobs.js`)

The new module was first written as `sidecar/lib/version-manager.js`, which already exists: it
is the Phase 0 constants module that owns `MIN_SUPPORTED_DSH`, `HARNESS_PACKAGE` and
`CHANNELS`, and `registry.js` imports it. Importing those constants from an identically-named
file created a cycle, and ESM reported it as the OLD module **"does not provide an export named
'HARNESS_PACKAGE'"** - which is not what had happened, and which sends a reader looking for a
missing export that is present and correct.

The new module is therefore **`version-jobs.js`** (it owns the long-running version OPERATIONS),
and the constants keep their name and contents. The obvious reading of that error message is
wrong, which is why it is written down.

`CHANNELS.RC = "latest-rc"` remains stale in the constants file (Q79): flagged, not changed.

### One test-harness trap

`sidecar/test/state.js` reports **64** checks instead of 65 when `DSH_DOCK_DATA_DIR` is set in
the calling shell, because one of its assertions is about the UNSET case and skips itself. It is
not a regression and there is no skipped test: run it in a clean environment and it is 65. Worth
knowing before reading a sweep table that mixed shells.

### Q87 - The lock probe is verified with a lock held by a REAL second process

A test that holds the library lock **in the same process** cannot prove the probe works. The
switch reads a lock FILE, so an in-process holder only proves that the file is read - and the
whole purpose of probing before stopping is to see a claim made by *somebody else*.

`version-switch.js` section 4a therefore spawns a second Node process that acquires the lock and
writes a handshake file atomically (temp + rename), following `install-flow.js`'s cross-process
convention exactly: never stdout sniffing (a `data` event is a chunk, not a record), never killed
by image name (the child exits when its stdin closes), and `pathToFileURL` for the child's import
specifier (a bare Windows drive letter is rejected by the ESM loader).

**What it asserts, in order, and point three is the reason it exists:**

1. the other process really acquired the lock, and the lock file records its pid;
2. the switch is refused with `409` / `library-locked`;
3. **THE HARNESS WAS NEVER STOPPED** - `stopFn` was never called, and the running version is
   unchanged. A switch that stops the user's harness and only then discovers it cannot proceed
   would leave them with no harness and no error path. This is the assertion that turns the
   ordering from a claim into a fact;
4. no job was started, and no staging directory was created;
5. once the holder exits, the abandoned lock no longer blocks: the same switch is then accepted
   and only then calls `stopFn`.

### Q88 - The version list is ordered by the registry's `time` map, and the comparator is still honest

`GET /registry/versions` orders by the packument's own publish timestamps. A hand-rolled semver
comparator would be a parser to maintain and to get subtly wrong, and the registry already
publishes an authoritative date per version - which is also the order a user means by "newest".

`compareVersions` exists anyway, for one production question ("is this below
`MIN_SUPPORTED_DSH`?"), and it was **wrong** when first written: it compared pre-release strings
directly, so `"rc.10" < "rc.9"` was true ('1' < '9') and a newer release would have been badged as
below the minimum once a series reached ten pre-releases. `version-registry.js` caught it.

It now compares pre-release identifiers part by part with semver's rules: numeric parts as
numbers, numeric identifiers below alphanumeric ones, a shorter list below a longer one, and a
pre-release below its own release. The values tested are real (`0.2.0-rc.9` / `rc.10`) rather
than invented, because this is the exact shape the package's own version series takes.

### Test-count reconciliation for 2B (the paper trail)

Every figure below was MEASURED by running the suites, not derived.

| Point | Suites | Total |
| :--- | ---: | ---: |
| 2A as committed (`075a897`) | 12 | **1166** |
| 2B end (15 suites + 2 probes) | 15 | **1461** |

**The MD records 1100/1100 across 11 suites for 2A, and that is under-counted by one suite:**
1166 - 1100 = 66 = `harness-start.js` exactly. `registry.js` (53) is also absent from section
4.3's "New" list, so it too was pre-existing. Both belong in the next MD revision.

**A note on the 2B paper trail itself.** At PAUSE 1 the `library.js` count was reported as 155.
The PAUSE 2 table shows 162 for the same suite at that point, and 162 is correct. The 7-check
difference is the cheap-probe section that the owner's clarification (`hasRequiredEntries`, the
missing-web-app case, the cross-module agreement walk) added BETWEEN the two reports, and the
PAUSE 1 sweep was run before it. The later figure is the right one; the earlier one was accurate
when it was printed. Recorded so the trail reads as a sequence of measurements rather than a
contradiction.

### Q89 - The five version commands, and the exact route each reaches

Narrow and typed, one command per user-facing action, each building a FIXED sidecar path. A
single parameterized proxy ("call this URL for me") was rejected for the same reason
`proxy_control` is not `pub`: it would let the dashboard reach every route the sidecar ever
grows.

| Command | Method + sidecar route | Returns | Why this shape |
| :--- | :--- | :--- | :--- |
| `versions_list` | `GET /versions/status` | `{progress, library, running, minimumSupported}` | the page-load call: one round trip draws the whole version screen |
| `versions_progress` | `GET /versions/progress` | the job object | polled while work runs; the sidecar retains the last finished job |
| `versions_download` | `POST /registry/download/<version>` | `202` + job | never waits for the install; a cold one is minutes |
| `versions_switch` | `POST /versions/switch?version=<v>` | `202` + job, or `409` refusal | both are normal results carrying a body the UI renders |
| `versions_delete` | `POST /library/delete?version=<v>[&partial=1]` | `{ok, deleted, reason, message}` | the flag selects the explicit partial-install intent |

**`GET /versions/library` deliberately has NO command.** It is a strict subset of
`/versions/status` (the same `library()` array, nothing else), so a sixth command would be a
second way to fetch one list - the duplication the one-implementation rule exists to prevent. It
stays served for diagnostics and is documented as not wire-reachable. If that ever becomes
awkward, deleting the route is a one-line change.

**The download/switch asymmetry is deliberate, not an oversight.** `/registry/download/<version>`
addresses the version as a PATH SEGMENT because the phase specification names it that way;
`/versions/switch` names it with `?version=` because the route was designed alongside
`/library/delete`, which needs a second parameter. `a_download_puts_the_version_in_a_path_and_a_
switch_in_a_query` pins both, so a later tidy-up cannot silently turn one into a 404.

### The three-file registration pin (and why `encode_query_value` is hand-written)

Tauri v2 does not auto-discover app commands, so each name must appear in `build.rs`'s
`AppManifest::commands([...])` AND in `capabilities/default.json` AND in `generate_handler!`. A
name missing from either of the first two has no permission identifier, and the failure appears
only at RUNTIME as "not allowed" - the least diagnosable shape this mistake can take. So a test
parses the ACTUAL command list out of `build.rs` (the string literals inside `.commands(&[...])`)
and the ACTUAL permission identifiers out of the capability JSON, and asserts set equality in
both directions against `VERSION_COMMANDS`. A whole-file `contains` check would have matched a
name that appears only in a comment.

**`encode_query_value` is hand-written rather than pulling in `form_urlencoded`.** The tree is
kept deliberately small (see the `ureq` note in Cargo.toml), and the encoding actually needed is
well defined and fully tested. It matters for one specific character: **`+`**. The sidecar decodes
with `URLSearchParams`, which reads a raw `+` as a SPACE, so an unencoded `1.0.0+build.5` would
arrive as `1.0.0 build.5` and be refused as an invalid version - about a version that is exactly
right. Everything outside ASCII alphanumerics and `-._~` is percent-encoded; over-encoding is
harmless because `%XX` decodes back to the same value.

One test asserts that an unencoded SEPARATOR never reaches a path. Note what is asserted and why:
`..%2F..%2Fevil` still contains `..`, and that is fine - the slashes are encoded, so the sidecar's
`decodeURIComponent` sees ONE segment whose value the version-name gate then refuses. What would
be dangerous is an unencoded `/` creating extra segments, so that is what is checked.

### Q90 - `update_library`: a SECOND change guard, compared by content

`update_harness` compares four fields and returns `false` when they are unchanged, and the watcher
only asks for a rebuild when something reports a change. The version list is a FIFTH thing the menu
renders, so without its own guard a list that changed while the harness did not - which is exactly
what an install or a delete IS - would never reach `rebuild_menu` at all. The submenu would stay
stale forever and nothing would be logged. That is this phase's recurring bug class: a fact
computed and then never applied.

**Compared by content, never by reference.** `/harness/status` is rebuilt on every 5s poll, so
`recentVersions` arrives as a fresh `Vec` each time. A reference or pointer comparison would report
"changed" every poll and trigger a full structural rebuild (~37 ms) forever. The guard compares the
version strings element-wise, in order.

**Only the version strings are compared, and `installed_at` deliberately is not.** The submenu does
not render dates, so a catalogue rewrite that moved dates without moving the list would otherwise
cost a 37 ms rebuild for a menu that looks identical. Comparing exactly what is DISPLAYED is what
makes the guard correct in both directions. (`installed_at` is still stored: Phase 3's version table
will want it.)

**Order is significant**, so a reordering counts as a change - the submenu's whole content is a
sequence.

`update_snapshot` is the ONE entry point both callers use (the 5s watcher and the `harness_status`
command). It evaluates both guards with `|` rather than `||`, because short-circuiting would skip
the library update whenever the harness facts moved too - and those are independent facts about
different parts of the menu.

**The fast path needed no change, and that is the section 2.8.4 prediction confirmed.**
`status_only_change` compares the ENTIRE `MenuPlan` and returns `Some` only when the single
difference is the status label, so a version-list difference returns `None` and routes to a full
rebuild. A test asserts both halves: a list change declines the fast path, and a status-only change
still takes it.

**Cadence consequence:** a full rebuild fires when the LIBRARY changes (install, delete, a
switch that installs) and not on the poll. User-initiated, minutes apart. Steady state stays 0 ms.

### Q91 - The dead-sidecar case for a menu switch

**Decision: refuse with a message, not a greyed-out item.** `switch_dispatch(version, port,
shell_error)` is a PURE function returning either the route to call or the message to show, so all
three refusals are unit-tested without a window or a sidecar.

- **Sidecar never came up:** the shell's recorded startup error is shown, because it names the real
  cause (a missing `sidecar/index.js`, for instance). The generic "has not reported a port yet" is
  used only when there is no error to show - the same reasoning that makes `ProxiedResponse` carry
  `shellError` at all.
- **Port known, call fails:** the transport error is shown, with the shell error appended when there
  is one.
- **Refused (409):** the SIDECAR's own wording is used verbatim. "Another version library operation
  is in progress (pid 4242 ...)" is more specific than anything the shell could invent.

**Why not disable the item instead.** Two reasons, and the first is decisive: the submenu is
populated FROM the sidecar's payload, so a dead sidecar means there is no version list to grey out -
there is nothing to disable. Second, a disabled menu item cannot say WHY it is disabled (menus have
no tooltips), so the user would be left with a dead entry and no explanation. A click that opens the
version section with a specific sentence is strictly more informative, and it matches what the
dashboard does on a dead sidecar: it shows an error card rather than silently doing nothing.

**Verified equivalence.** The dashboard reaches the sidecar through `proxy_control` via
`harness_*`/`versions_*`; the menu reaches it through `proxy_control_app`, which resolves the same
`SidecarState` and calls the same `proxy_control`. So a dead sidecar produces the same diagnosis on
both paths - the menu's message is the shell error the dashboard also renders as `shellError`.

### Q92 - The worker/main boundary for a menu switch

`handle_menu_event` runs on the MAIN thread and must not block; a switch is a multi-minute
operation. But the rule cuts both ways: **a worker must not touch the menu.** `set_menu`,
`MenuItem::set_text`, window focus and `emit` are all main-thread work, and calling them from a
worker either silently does nothing or panics.

The boundary, named:

| Work | Thread |
| :--- | :--- |
| `switch_dispatch` (decide: refuse or dispatch) | **main** (inside `handle_menu_event`) |
| `run_switch_request` (the HTTP call) | **worker** (`dsh-dock-menu-switch`) |
| `switch_outcome_message` (pure formatting) | worker (no UI involved) |
| `on_main(...)`: log, `request_rebuild`, `open_control_panel` | **main** (marshalled) |

There is exactly ONE production `app.set_menu` call site (`rebuild_menu`, reached through
`request_rebuild` -> `run_on_main_thread`), pinned by a test. A future edit that installs a menu
from a worker therefore fails that test rather than panicking in the field.

### Q93 - Rebuild reason vs. the wizard's window menu

`rebuild_menu` re-clears the wizard's menu after every rebuild, unconditionally - not matched on
`reason`. Phase 2B adds a rebuild path that can fire while the wizard is legitimately open (a
first-run install completes, so the version list changes and `update_library` reports it), and the
unconditional guard covers that for free. A test pins that the clear is NOT behind a `reason` check,
because a new reason silently skipping it is exactly how the two-part guard from Pause 4 would rot.

### Two bugs 7b's own tests found

**1. `is_switchable_version` mishandled a version with BOTH suffixes.** The first version split once
on `-` or `+`, which handled `1.2.3-rc.1` and `1.2.3+build.5` but refused `1.2.3-rc.1+build.5` -
legal, and the exact shape a pre-release with build metadata takes. Caught by the corpus test, fixed
by splitting at the first `-` and then at the first `+` after it.

**2. `MenuAction::from_id` accepted `../../evil` as a version.** It checked only that the suffix was
non-empty, so any garbage after `harness.recent.` became a `SwitchVersion`. Nothing was exploitable -
`switch_version` refuses it through the same predicate - but the PARSER and the DISPATCHER disagreed
about what a version is, which is the drift Q71 exists to prevent. `from_id` now validates with the
same predicate, and a corpus test asserts the two agree on every string in it, so they cannot drift
on a version nobody thought to write a fixture for.

### The cross-language version-name pin

The shell's predicate is a COPY of the sidecar's rule, because a malformed menu id must not become
an HTTP request, and it cannot be shared across the language boundary. The relation that must hold is
a SUBSET: anything the shell dispatches must be valid, while the shell is allowed to be stricter.

`library.js` asserts it against the SAME corpus the Rust test uses - duplicated on purpose, because a
version added to one list and not the other is the drift the pair exists to catch. It asserts both
directions over that corpus and records the honest position: on every string in the corpus the two
AGREE, and no divergence is claimed, because inventing one to prove the shell is "stricter" would be
asserting something unverified. An earlier draft of that test did exactly that with `1.2.3-.`, which
the library also refuses - the test caught the invented claim and it was removed.

### Q94 - `/versions/library` is deleted

It was a strict subset of `/versions/status` (the same `library()` array, nothing else), so keeping
it meant two ways to fetch one list - the duplication the one-implementation rule exists to prevent.
Removed from `version-jobs.js` in 7b. `version-progress.js` now asserts the route 404s, so a stale
route cannot come back unnoticed, and no other test references it.

### Q95 - The version section's polling cadence, and why it is two cadences

`src/lib/VersionManager.svelte` polls on its OWN schedule, not the dashboard's. Three distinct
frequencies, each chosen for a different reason:

| What | When | Why |
| :--- | :--- | :--- |
| `versions_progress` | every **500 ms**, ONLY while a job is busy | the phases are minutes apart, so this is far more often than needed - it is chosen so a phase change appears promptly rather than up to a second late, and 500 ms matches the dashboard's existing harness poll so the screen does not update in two visible rhythms |
| `versions_list` | on mount, when a job ends, and on Refresh | the library changes on human timescales |
| `versions_available` | on mount, when a job ends, and on Refresh | **never polled** - it is a network call to the public registry |

**The poll stops the moment nothing is busy, and the `busy` flag is the SIDECAR's, not this
component's.** That second part is the load-bearing one: a job can be running because the MENU
started it (Q74), so a component that only polled after its own clicks would show nothing for a
switch begun from the menu. Idle cost is therefore zero extra requests beyond the initial pair.

### The version section refuses to poll the registry

`GET /registry/versions` has a 60 s cache in the sidecar and a `?refresh=1` bypass. The UI never
polls it: a mount fetches once, and a `refresh=1` fetch happens only when a job ENDS (because an
install changes which rows are already installed). A dashboard left open overnight makes no
registry requests at all.

### Q96 - A partial tree: repaired by a switch, removed by a cleanup

The row shows a `partial` badge and offers **two** buttons, and the split is the honest one:

- **Switch** *repairs* the tree. A switch reinstalls a non-`installed` target and then starts it, so
  "Switch" on a partial row is the repair path - one button, because a repair IS a switch.
- **Clean up** calls `versions_delete` with `partial: true`, which routes to the sidecar's
  `deletePartialVersion`. That is 2A's explicit intent for a tree an interrupted install left
  behind, and it is a different operation from deleting a version the user installed.

There is deliberately **no third "Repair" button**: it would be a second name for the switch, and
two implementations of one outcome is what the one-implementation rule exists to prevent.

A `delete` of the RUNNING version is refused by `library.js`, not by the UI - the guard lives with
the destructive operation, so no caller can bypass it. The UI also disables the button for the
running row, which is a courtesy rather than the guard.

### Q97 - `belowMinimum` in the UI: a badge, never a block

Marked on BOTH lists:

- **Available**: from the `belowMinimum` field the sidecar computed for each entry, with the
  minimum named in the badge (`below 0.2.0-rc.1`) and a `title` explaining that it is older than
  anything DSH-Dock has verified.
- **Installed**: computed by a small local `compare()` against the `minimumSupported` the status
  payload reports, because the installed list carries no per-entry flag. The local copy is
  deliberately tiny - the authoritative comparison is `sidecar/lib/version-jobs.js`'s
  `compareVersions`, and this one only has to agree on real version strings.

**`"0.0.0"` is treated as "no floor"** and badges nothing, because that is the sidecar's own
placeholder meaning the value has not been derived yet. Without that check every version would
appear unsupported until Step 11.

The badge never blocks: an older version stays installable and switchable. Q77/Q14 - the user is
sovereign, and hiding a version is blocking by another name.

### The supported-floor facts were DEAD FIELDS for one revision

`download()`'s result gained `belowMinimum` and `minimumSupported`, but `progress()` **whitelists**
the fields it returns - so setting them on the job was invisible to every caller. Caught by asking
whether the fact actually reaches a poller, which is this phase's recurring question, and the answer
was "no".

Fixed by carrying them on the job from `beginJob` (where the version is known) and including them
both at the TOP LEVEL of `progress()` and inside `job`, so a poller that only reads the summary
still sees the floor that was in force. `version-progress.js` section 2b asserts they are on the
RETURNED object rather than merely on `manager.job` - the distinction that made the bug invisible.

This is the third instance of the class in 2B: a decision reversed one level down, a flag read but
never applied, and now a fact computed but never returned.

### Q98 - `versions_available`: the sixth command, and the deviation it is

**The phase brief's Step 9 requires the version section to list AVAILABLE versions. The five
commands from 7a cannot reach the registry listing** - `versions_list` serves
`/versions/status`, which carries the INSTALLED library, and no other command touches
`/registry/versions`. Without a sixth command, "Available" would have been permanently empty: a
brief that cannot be satisfied by its own constraint.

So `versions_available` → `GET /registry/versions[?refresh=1]` was added, with the usual three-file
registration (`lib.rs`, `build.rs`, `capabilities/default.json`). It is narrow and typed in the same
way as the rest: a fixed path and one optional boolean.

**Why implemented rather than paused on.** The brief itself allowed it - "from `versions_list`'s
payload **or a second call if needed**" - so the intent was clear and a pause would have spent a
round trip on a question the brief had already answered. It is reported as one of the three
constraints it technically crosses ("no new Tauri command", "no new capability grant", and the
count of five), and removing it is mechanical if the reading should be strict.

`VERSION_COMMANDS` is now `[&str; 6]` and the count is asserted, so a SEVENTH command has to be a
deliberate edit to that test rather than an accident.

### The version section and the menu share one destination

`panel:open` with `tab: "versions"` is what the shell emits for `Show all versions…` (Q78) and for a
switch outcome. `App.svelte` listens for it, scrolls the version section into view, and renders the
message the shell carried - which is how a switch started from the MENU reports back even when the
dashboard was closed at the time (the shell opens the window and delivers the message with it).

The shell keeps no notion of a "version section": it names a tab and the dashboard decides what that
means, which is why Phase 3 can add real tabs without touching `menu.rs`.

## Phase 2B acceptance: three bugs, and what each one was really about

The Step 10 acceptance run found three defects. All three were in 2B's own new work, and two of them
were the SAME mistake in two places.

### Bug 1 + Bug 3 share one root cause: two pollers that only ran when they had caused the change

**Symptom 1.** After a switch from the dashboard, the Harness card kept showing the old version and an
"Open Harness" button pointing at the URL the PREVIOUS harness had served - a dead URL, so clicking it
produced a loading error. Refresh corrected everything.

**Symptom 2.** After a switch started from the MENU, the Versions card's Installed list kept its
"Running" badge on the previous version. Refresh corrected it.

**Root cause, stated once.** Both surfaces were EVENT-driven rather than STATE-driven:

- `App.svelte` polled `harness_status` ONLY while the status was `starting`, and every other path
  called `stopTimers()`. Once the harness was up, nothing read the status again until the user acted.
  A switch is not something this window did, so it never heard about it.
- `VersionManager.svelte` started its progress poll only from a `busy: true` it had already seen -
  which required either its own click or a lucky timing. A menu switch (Q74) never touched it.

So a single cause: **a surface whose job is to report state did not poll for state it did not cause.**
The 2B plan claimed the versions poll was "driven by the SIDECAR's `busy`, never by whether THIS
component started the job" - the intention was right and the mechanism did not exist, because nothing
ran to OBSERVE that flag while idle.

**The fix, and why it is two mechanisms rather than one.**

1. **Both surfaces now poll continuously.** The dashboard polls `harness_status` at 500 ms while
   `starting` and **5 s otherwise, forever**; the version manager polls at 500 ms while busy and
   **5 s otherwise, forever**. The idle cadence is what makes "driven by the sidecar's flag" true
   rather than aspirational.
2. **Plus one event, for immediacy.** A switch the user clicked in the version manager also calls an
   `onSwitchComplete` callback prop, so the Harness card updates at once instead of up to 5 s later. A
   user watching the screen reads 5 s as "it did not work".

Two mechanisms because they cover two origins: the poll covers everything this window did not cause
(the menu's switch, a menu stop, a harness reaped by the next launch's adopt/reap), and the callback
covers the one case where the user is watching and already knows.

**The decisions moved out of the components.** `src/lib/version-refresh.js` holds the cadences, the
cadence choice (`harnessPollMs`, `versionsPollMs`) and the completion rule (`jobCompletion`) as plain
JS, with `src/test/version-refresh.test.js` (36 checks) covering them. Both bugs were DECISIONS about
when to refresh, made inside components where the only way to exercise them was to run the app and
look. A decision two bugs lived in should not stay trapped there.

**`jobCompletion` exists because the sidecar RETAINS the last finished job.** Every poll after a
completion returns the same outcome, so without comparing `finishedAt` each poll would look like a
fresh completion: the library re-read forever, and the dashboard notified on every tick.

### Bug 2: the harness window never had a menu bar, because the MD is wrong about Tauri

**The finding.** The harness window is built by `build_harness_window` with `WebviewWindowBuilder` and
no `.menu()`. Section 2.8.3 claims `AppHandle::set_menu()` gives the menu to "every existing window
that has none, and windows created later inherit it at creation". The second half is FALSE. tauri
2.11.5 (`src/app.rs`, `set_menu`) iterates the window map ONCE, at call time:

```rust
for window in self.manager.windows().values() {
    let has_app_wide_menu = window.has_app_wide_menu() || window.menu().is_none();
    if has_app_wide_menu { window.set_menu(menu.clone())?; ... }
}
```

A window created after that loop is not in the map, so it starts with no menu and nothing subsequently
attaches one. Nothing in this codebase was deliberately keeping the menu off the harness window - the
only window whose menu is deliberately cleared is the wizard (`clear_welcome_menu`). So the menu
SHOULD have been there and section 2.8.1's intent ("top of the harness window") is correct; only the
mechanism was missing.

**Why it mattered more than a missing menu bar.** Q74's entire premise is that a switch must not
depend on the dashboard being open. With no menu on the harness window, the only menu with `Recent
Versions` lived on the dashboard - so the acceptance step "close the dashboard, then switch from the
menu" was unsatisfiable, and the user had to reopen the dashboard and use its menu. The exception Q74
carved out was unreachable in the architecture it was designed for.

**The fix.** `build_harness_window` attaches the CURRENT app-wide menu to the new window immediately
after `build()`, via the WINDOW-scoped `window.set_menu(menu)` - not the app-wide
`AppHandle::set_menu`, which would re-run the whole app-wide attach on every harness window creation.
Pinned by two tests: the attach is present and window-scoped, and `clear_welcome_menu` is re-applied
AFTER it (a third place a menu now reaches a window, so the wizard's two-part guard is re-applied
rather than assumed).

**A cross-check worth noting.** `every_rebuild_reason_goes_through_the_one_set_menu_call_site` in
`menu.rs` counts APP-WIDE `app.set_menu` call sites. Using the app-wide form here would have failed
that test, so two tests constrain the fix from opposite sides.

**Still open, and deliberately NOT fixed here.** Menu actions other than `switch` still route to the
dashboard (`deliver()`), so with the dashboard closed a menu **Stop** or **Restart** logs "the control
panel is not open" and does nothing. That is a DIFFERENT question from Bug 2 - "should the menu be able
to stop the harness with no dashboard?" - and it changes the one-implementation rule for those
actions. Reported for a decision rather than fixed.

**Also verified by reading `window.set_menu`:** it does not update the window's `is_app_wide` flag,
but that flag is already `true` for this window - a window with no explicit menu is treated as having
the app-wide one - so `rebuild_menu` will continue to replace the harness window's menu on later plan
changes rather than leaving it stale. That is reasoning from source, not from a run: the next
acceptance pass should confirm the harness menu's status label updates when the harness state moves.

### The acceptance script's own three bugs

Recorded because the checklist is now the artifact a user runs, and each of these would have wasted a
verification pass:

1. **`Copy-Item -Recurse` silently HALF-copies an npm tree.** Paths past MAX_PATH
   (`...\@opentelemetry\...\getMachineId-unsupported.d.ts`) make it throw partway, leaving an
   incomplete library - worse than no copy, because the run would then fail for a reason that looks
   like a launcher bug. Now `robocopy /E` with an exit-code check (`0-7` success, `>=8` throws), and
   the copy is verified complete at 53,496 files.
2. **`robocopy /SL` does not hardlink regular files.** `/SL` copies SYMBOLIC LINKS as links, and this
   tree has none, so it quietly performed a full copy while the comment claimed otherwise - verified
   with `fsutil hardlink list`, which listed two unrelated paths. The claim was removed, and a real
   hardlink mode was tried and then REMOVED too: `New-Item -ItemType HardLink` fails on the same long
   paths. One mode, documented, ~973 MB.
3. **`$_` inside `catch` is the error record, not the pipeline item.** A `Copy-Item $_.FullName`
   fallback failed with "Cannot bind argument to parameter 'Path' because it is null", which points at
   the pipeline rather than the catch. The source path is now captured before the `try`.

`Remove-Item -Recurse -Force` also fails on those paths; cleanup uses `cmd /c rmdir /s /q` behind a
resolved-path guard that refuses to delete anything outside the scratch dir.

## Q99 - Menu actions that must work without the dashboard route sidecar-side

**Menu actions that must work without the dashboard route sidecar-side.** Stop, Restart, and Switch
dispatch directly from the shell to the sidecar on a worker thread, unconditionally. Rationale: a menu
item that does nothing when clicked is worse than the scope expansion, and it violates the "one
implementation per action" rule in the other direction - the dashboard is now optional for every
harness action. The dashboard's state is recovered by its status poll, which runs continuously.

**What replaced what.** Q58 said every actionable menu item emits an intent and the dashboard
performs it: "one implementation per action, two entry points". That rule assumed the dashboard is
always there and the action is fast. Neither held. The acceptance run showed the cost directly: with
the dashboard closed, a menu **Stop** or **Restart** logged `menu: could not deliver '<action>' - the
control panel is not open` and did nothing at all. Q74 had already carved out `switch` for exactly
this reason; the carve-out is now the rule, and the rule it replaced covers one action.

**One implementation is still true, in both directions.** The SAME sidecar route serves the menu and
the dashboard's button (`POST /harness/stop`, `POST /harness/restart`,
`POST /versions/switch?version=`). What changed is that the dashboard is OPTIONAL rather than
required - which is what "one implementation" was always meant to buy.

**Still forwarded, and why there is exactly one left.** `deliver()` survives for `OpenLogsFolder`, the
one action with no dashboard state to keep in step: the event is emitted for consistency and the shell
reveals the folder itself (Q58). A test asserts `handle_menu_event` contains exactly one `deliver(`
call, so a future action cannot quietly rejoin the old path.

**Why this is safe now and was not before.** Moving Stop and Restart off the dashboard would have left
the Harness card stale - the Bug 1 defect. The continuous status poll (Q95) is what makes the
dashboard recover a change it did not perform, and it landed first.

**The threading, pinned by tests rather than by comment.** `run_menu_action` is the ONE place a
menu-dispatched action spawns a worker, does the HTTP hop, and marshals back via `on_main`. A worker
must not touch the menu, so the tests assert by source shape that:

- `run_menu_request` (worker) calls `proxy_control_app` and **none** of `set_menu`,
  `clear_welcome_menu`, `request_rebuild`, `open_control_panel`, `on_main`, `installed_item`;
- `run_menu_action` marshals, and `request_rebuild` appears **after** `on_main(` - a rebuild outside
  the closure would touch the menu from the worker;
- each of `stop_harness`, `restart_harness`, `switch_version` delegates to the shared helpers and does
  not spawn its own worker or call the hop directly.

`MenuAction::needs_worker` was updated to match: five actions now reach outside the process (three
harness actions, the logs spawn, the settings write), where it previously said two. The test that
pinned "exactly two workers" was itself pinning the old assumption.

## Q100 - The running version is a native CHECK, not a `(installed)` suffix

The `Recent Versions` submenu marks the version that is currently running with a **check mark**
(`PlanNode::Check`, `checked: true`), reusing the variant that already backs the auto-update options.

**Why a check rather than a bullet prefix.** A native check is the platform's own idiom for "this is
the current one" in a radio-style list, so it looks like a mark everywhere instead of like part of the
version string - and it cannot be confused with the `●` of the status label, which answers a different
question ("what state is the harness in", not "which version is this").

**Why the item is not clickable.** Switching to the version that is already running is NOT a no-op:
the sidecar stops the harness and starts it again, so a click would restart a working harness for
nothing. `enabled: false` makes the tick information, which is also why the id still round-trips - a
`Check` whose id did not parse would be a dead entry that the plan-walking test would catch.

**Why the `(installed)` suffix is gone.** Every entry in that submenu is installed by definition, so
the suffix was noise next to a tick that says something the suffix did not: which one is RUNNING.

**The case with no tick.** If the running version has aged out of the five displayed, **nothing** is
ticked - a tick on a different version would be a lie about which one is running. That state is
already covered by "Show all versions…", and a test pins that the running version is not smuggled
into the five merely to have something to tick.

**Tests.** Four: the running entry is checked and not clickable while the others are switch actions;
**exactly one** entry is checked; the tick MOVES when the running version changes and the version that
lost it becomes clickable again; and nothing is ticked when nothing is running or when the running
version is outside the shown five.

## Deferred - background job status surface

**Status: NOT in 2B. Not designed, not implemented. Recorded so Phase 3 can pick it up deliberately
rather than rediscover it.**

### The requirement

Background jobs - a menu-initiated switch, a download, a forced install - should surface their
progress, completion, and any recommended follow-up action ("restart the harness") in a place that
does **not** require the dashboard window to be open. A menu-initiated switch is precisely the case
that motivated Q99, and it currently reports its OUTCOME through a modal-ish path
(`open_control_panel` + a message) while it RUNS with no visible surface at all: the status label
changes and nothing else.

### The uncertainty

A persistent, right-aligned status indicator in a native menu bar is not something either muda or the
platform menu APIs expose portably. Windows has no supported way to place a live control in a menu
bar; the closest idiom is a disabled item whose text carries the state. So the honest options are:

1. **A menu item that carries the last job's outcome** - cheapest, portable, and fits the existing
   `StatusLabel` pattern (`● Running · v0.2.0-rc.2`). Loses live progress: it can only show what the
   plan was rebuilt with, so it would need the same `update_*` guard treatment as the version list
   (Q90), and a 5s poll means a 5s-granularity progress readout at best.
2. **A system tray icon** (Phase 4, section 2.2/2.9) - the natural home for an always-present status
   surface, and already planned. Blocked on the tray, which is deferred and is not uniform on Linux
   (stock GNOME 40+ has no tray).
3. **A native notification toast** (Phase 4) - good for COMPLETION and follow-up actions (section
   3.10 already describes "Run now" / "Ignore"), poor for continuous progress, and not available in
   every desktop environment.
4. **A footer line in the menu** - a disabled item at the bottom of the Harness submenu. Same
   portability as (1) with less prominence.

### The trigger to revisit

**Phase 3 (Settings & Update UI)**, when more background work exists - the 12-hour auto-update poll
and pre-downloading (2C/3.2), plus the notification flow in section 3.10 - and a status surface
becomes load-bearing rather than a convenience. Deciding before that work exists risks building the
wrong shape.

**Explicitly out of 2B scope.** Recorded here so the 2B decision not to build it is visible as a
decision.
