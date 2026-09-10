//! DSH-Dock Tauri shell.
//!
//! Architectural role (docs/PROJECT_DSH-DOCK.md section 2): the shell is "dumb".
//! It owns the native window, the system tray, and the lifecycle of the Node
//! sidecar. It holds no launcher logic - version resolution, registry access,
//! port allocation and harness spawning all live in the sidecar.
//!
//! Phase 0 scope: spawn the sidecar, parse its stdout handshake, publish the
//! port to the frontend.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager};

/// Event name emitted once the sidecar reports its port.
pub const EVENT_SIDECAR_READY: &str = "sidecar:ready";

/// Event name emitted when the sidecar failed to start.
pub const EVENT_SIDECAR_ERROR: &str = "sidecar:error";

/// Prefix of the sidecar's single stdout handshake line.
///
/// This is the ONLY sanctioned way to learn the port. The sidecar also has an
/// optional `DSH_DOCK_PORT_FILE` escape hatch, but that exists purely for the
/// sidecar's own smoke test and MUST NOT be read here.
const READY_PREFIX: &str = "SIDECAR_READY:";

/// Shared sidecar state, accessible as Tauri managed state.
#[derive(Default)]
pub struct SidecarState {
    inner: Mutex<SidecarInner>,
    ready: Condvar,
    child: Mutex<Option<Child>>,
}

#[derive(Default)]
struct SidecarInner {
    /// `Some(port)` once the handshake succeeded.
    port: Option<u16>,
    /// `Some(message)` once startup failed.
    error: Option<String>,
    /// True once stdout closed, i.e. the sidecar is gone.
    exited: bool,
}

/// Payload for [`EVENT_SIDECAR_READY`].
#[derive(Clone, serde::Serialize)]
struct ReadyPayload {
    port: u16,
}

impl SidecarState {
    fn set_port(&self, port: u16) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            inner.port = Some(port);
        }
        self.ready.notify_all();
    }

    fn set_error(&self, message: String) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            inner.error = Some(message);
        }
        self.ready.notify_all();
    }

    fn mark_exited(&self) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            inner.exited = true;
        }
        self.ready.notify_all();
    }

    /// Blocks until the port is known, or the sidecar dies trying.
    ///
    /// A bounded wait: a wedged sidecar must surface as an error rather than
    /// hang the calling thread forever.
    fn wait_for_port(&self) -> Result<u16, String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);

        loop {
            if let Some(port) = inner.port {
                return Ok(port);
            }
            if let Some(error) = inner.error.as_ref() {
                return Err(error.clone());
            }
            if inner.exited {
                return Err("Sidecar exited before reporting a port".to_owned());
            }

            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(
                    "Timed out waiting for the sidecar handshake (15s). \
                     Is Node.js on PATH and sidecar/index.js present?"
                        .to_owned(),
                );
            }

            let (guard, _timeout) = self
                .ready
                .wait_timeout(inner, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            inner = guard;
        }
    }

    fn store_child(&self, child: Child) {
        let mut slot = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        *slot = Some(child);
    }
}

/// Returns the sidecar's port to the frontend, waiting for it if necessary.
///
/// This exists alongside [`EVENT_SIDECAR_READY`] to close a real startup race:
/// the sidecar can announce its port before the webview has registered a
/// listener, in which case an event-only design would leave the UI stuck on
/// "Waiting for sidecar..." forever. The frontend calls this as a fallback, so
/// the port is delivered at least once regardless of ordering.
#[tauri::command]
fn sidecar_port(state: tauri::State<'_, SidecarState>) -> Result<u16, String> {
    let port = state.wait_for_port()?;
    // Phase 0 proof that the handshake reached the UI: if this line appears, the
    // frontend called the command and a real port was returned to it.
    println!("[shell] frontend requested the sidecar port: {port}");
    Ok(port)
}

/// Resolves the repository root at compile time.
///
/// `CARGO_MANIFEST_DIR` is `<repo>/src-tauri`, so its parent is the repo root.
/// This is a compile-time constant: no absolute path is ever written into a
/// file, and nothing depends on the current working directory at runtime.
///
/// TODO(Phase 4): when the app is packaged, prefer the bundled resource
/// (`resources/sidecar/index.js`) and the bundled Node binary
/// (`binaries/node(.exe)`) when both exist, and fall back to the system Node
/// only if they do not. `src-tauri/resources/` and `src-tauri/binaries/` are
/// deliberately not created in Phase 0.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent directory")
        .to_path_buf()
}

/// Spawns the sidecar and wires its handshake into application state.
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let root = repo_root();
    let entry = root.join("sidecar").join("index.js");

    if !entry.is_file() {
        return Err(format!(
            "Sidecar entry point not found at {}. Phase 0 runs the sidecar from \
             the repository, so the app must be launched from a full checkout.",
            entry.display()
        ));
    }

    // During development the sidecar runs on system Node. Phase 4 adds the
    // bundled runtime (see TODO above); this is the Phase 0 path only.
    let mut child = Command::new("node")
        .arg("sidecar/index.js")
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Failed to spawn `node sidecar/index.js`: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sidecar stdout was not captured".to_owned())?;

    let handle = app.clone();
    thread::spawn(move || {
        let state = handle.state::<SidecarState>();
        let mut found = false;

        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let line = line.trim();

            // Diagnostics belong on stderr; anything else on stdout is logged
            // but ignored so it cannot be mistaken for the handshake.
            let Some(raw_port) = line.strip_prefix(READY_PREFIX) else {
                println!("[shell] sidecar stdout: {line}");
                continue;
            };

            match raw_port.trim().parse::<u16>() {
                Ok(port) if port > 0 => {
                    found = true;
                    state.set_port(port);
                    let _ = handle.emit(EVENT_SIDECAR_READY, ReadyPayload { port });
                    println!("[shell] sidecar ready on port {port}");
                }
                _ => {
                    let message = format!("Malformed sidecar handshake line: {line:?}");
                    state.set_error(message.clone());
                    let _ = handle.emit(EVENT_SIDECAR_ERROR, message);
                }
            }
        }

        // stdout closed: the sidecar is gone.
        state.mark_exited();
        if !found {
            let message = "Sidecar stdout closed before a port was reported".to_owned();
            state.set_error(message.clone());
            let _ = handle.emit(EVENT_SIDECAR_ERROR, message);
        }
    });

    let handle = app.clone();
    thread::spawn(move || {
        let state = handle.state::<SidecarState>();
        // Give the handshake a generous window before declaring failure, so a
        // slow start is not misreported as an error.
        thread::sleep(Duration::from_secs(12));
        let inner = state.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.port.is_none() && inner.error.is_none() {
            let message = "Sidecar did not report a port within 12 seconds".to_owned();
            drop(inner);
            state.set_error(message.clone());
            let _ = handle.emit(EVENT_SIDECAR_ERROR, message);
        }
    });

    app.state::<SidecarState>().store_child(child);
    Ok(())
}

/// Builds and runs the Tauri application.
///
/// TODO(Phase 3/4): `cargo tauri dev` is a real footgun here. If port 1420 is
/// already held by a STALE Vite server, `beforeDevCommand` fails and reports a
/// non-zero exit, but Tauri still launches this binary - which then loads the
/// frontend from that stale server. A fresh window can therefore serve old
/// code silently. Two candidate fixes, deliberately not implemented in
/// Phase 0: (a) a pre-flight check that hard-fails when 1420 is occupied, or
/// (b) a startup check here that refuses to run when the dev server was not
/// spawned by this process.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_port])
        .setup(|app| {
            // A failed spawn must not abort startup: the window still needs to
            // open so the failure is visible to the user rather than silent.
            if let Err(message) = spawn_sidecar(app.handle()) {
                eprintln!("[shell] {message}");
                let state = app.state::<SidecarState>();
                state.set_error(message.clone());
                let _ = app.handle().emit(EVENT_SIDECAR_ERROR, message);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Phase 0 keeps the sidecar on a plain child lifetime and stops it
            // with the window. Detached, background-surviving behaviour with
            // adopt/reap is Phase 1 (section 2.3).
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<SidecarState>();
                let mut slot = state.child.lock().unwrap_or_else(PoisonError::into_inner);
                if let Some(mut child) = slot.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DSH-Dock");
}
