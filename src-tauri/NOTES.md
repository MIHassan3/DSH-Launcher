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
