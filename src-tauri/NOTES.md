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
