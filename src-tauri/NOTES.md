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
- `../sidecar/test/handshake.ps1` — verifies the real stdout handshake contract.
- `../sidecar/test/smoke.js` — sidecar liveness, `/health`, and clean shutdown.

Note: WebView2 does not expose its accessibility tree in this configuration, so
the rendered text of the webview cannot be asserted programmatically
(UI Automation reports zero text elements). Visual confirmation is required for
UI-level acceptance.
