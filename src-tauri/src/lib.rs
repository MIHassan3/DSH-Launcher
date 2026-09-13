//! DSH-Dock Tauri shell.
//!
//! Architectural role (docs/PROJECT_DSH-DOCK.md section 2): the shell is "dumb".
//! It owns the native windows, the system tray, and the lifecycle of the Node
//! sidecar. It holds no launcher logic - version resolution, registry access,
//! port allocation and harness spawning all live in the sidecar.
//!
//! Phase 1 scope: spawn the sidecar, parse its stdout handshake, publish the
//! port to the frontend, proxy the three control commands, and own the
//! `harness` window.
//!
//! Requests go through Tauri commands, never a direct `fetch` from the
//! frontend: a direct call would need CORS on the sidecar and would bypass the
//! capability system (section 2, and the Phase 1 decision).
//!
//! What this shell must NOT do: kill the harness. The harness is spawned
//! detached by the sidecar and must outlive the launcher (section 2.2). Only
//! the sidecar is a child of this process.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Event name emitted once the sidecar reports its port.
pub const EVENT_SIDECAR_READY: &str = "sidecar:ready";

/// Event name emitted when the sidecar failed to start.
pub const EVENT_SIDECAR_ERROR: &str = "sidecar:error";

/// Label of the window that displays the harness UI.
pub const HARNESS_WINDOW_LABEL: &str = "harness";

/// Label of the launcher's own dashboard window (declared in tauri.conf.json).
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Prefix of the sidecar's single stdout handshake line.
///
/// This is the ONLY sanctioned way to learn the port. The sidecar also has an
/// optional `DSH_DOCK_PORT_FILE` escape hatch, but that exists purely for the
/// sidecar's own smoke test and MUST NOT be read here.
const READY_PREFIX: &str = "SIDECAR_READY:";

/// How long a proxied control call may take.
///
/// `/harness/status` probes a URL, so it needs a real budget; start and stop
/// answer immediately by design (start returns 202 without waiting for boot),
/// so this is generous for all three.
const PROXY_TIMEOUT: Duration = Duration::from_secs(20);

/// Environment variable that overrides the launcher data directory.
///
/// Mirrors `sidecar/lib/state.js`. The shell only needs it to know WHERE to
/// write its own log; the sidecar remains the authority on launcher state.
const DATA_DIR_ENV_VAR: &str = "DSH_DOCK_DATA_DIR";

/// How the sidecar's stderr is wired up.
///
/// MUST stay `Piped`. See [`spawn_sidecar`]: on a `windows_subsystem =
/// "windows"` binary, `Stdio::inherit()` makes Windows allocate a console for
/// the child, which appeared as a visible console window in release builds.
///
/// Declared as a constant so `the_sidecar_stderr_is_never_inherited` can assert
/// it; a comment alone would not stop a future edit from reintroducing it.
const SIDECAR_STDERR_INHERITED: bool = false;

/// Windows `CREATE_NO_WINDOW` (0x08000000).
///
/// Every child process this shell or the sidecar starts must pass this, or
/// Windows allocates a console for it - a `windows_subsystem = "windows"`
/// launcher has no console to hand down, so the child gets its own visible one.
///
/// Required in ADDITION to piped stdio: piping redirects the streams but does
/// not prevent the console from being created. Applied here for the sidecar and
/// in `sidecar/lib/harness-start.js` for the harness; both were observed
/// producing stray console windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// True when THIS process has a console attached.
///
/// Used only in the startup log. It makes the "stray console window" class of bug
/// self-diagnosing instead of requiring a guess: a `windows_subsystem = "windows"`
/// binary must report `console: none`, and any child we spawn with
/// CREATE_NO_WINDOW must report the same from its own side.
#[cfg(windows)]
fn has_console() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleWindow() -> *mut std::ffi::c_void;
    }
    // SAFETY: GetConsoleWindow takes no arguments and returns a handle or null.
    unsafe { !GetConsoleWindow().is_null() }
}

#[cfg(not(windows))]
fn has_console() -> bool {
    true
}

/// Resolved path of the shell's own log file, set once at startup.
static LAUNCHER_LOG: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Resolves `<data-dir>/logs/launcher.log` for this platform.
///
/// Deliberately a small mirror of the sidecar's rule rather than a second
/// source of truth: the shell must be able to log a failure that happens
/// BEFORE the sidecar exists, so it cannot ask the sidecar where to write.
fn launcher_log_path() -> Option<PathBuf> {
    let root = match std::env::var(DATA_DIR_ENV_VAR) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => {
            #[cfg(windows)]
            {
                let base = std::env::var("LOCALAPPDATA")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var("USERPROFILE")
                            .ok()
                            .map(|home| PathBuf::from(home).join("AppData").join("Local"))
                    })?;
                base.join("DSH-Dock")
            }
            #[cfg(target_os = "macos")]
            {
                let home = std::env::var("HOME").ok()?;
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("DSH-Dock")
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                let base = std::env::var("XDG_DATA_HOME")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .or_else(|| std::env::var("HOME").ok().map(|home| PathBuf::from(home).join(".local").join("share")))?;
                base.join("dsh-dock")
            }
        }
    };
    Some(root.join("logs").join("launcher.log"))
}

/// Initializes the launcher log. Idempotent; safe to call more than once.
fn init_launcher_log() {
    LAUNCHER_LOG.get_or_init(|| {
        let path = launcher_log_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        Some(path)
    });
}

/// Writes one timestamped lifecycle line to the launcher log AND stderr.
///
/// WHY A FILE: `main.rs` sets `windows_subsystem = "windows"` for release
/// builds, so `println!`/`eprintln!` go nowhere - stderr is not attached to any
/// console. A release-build failure was therefore completely silent: the
/// dashboard rendered, no sidecar appeared, and the spawn error was discarded.
/// On Windows release builds this file is the ONLY way to see what happened.
///
/// Never panics and never fails a caller: diagnostics must not be able to break
/// startup. A logging failure is itself written to stderr and otherwise ignored.
fn log_line(message: &str) {
    let stamped = format!("{} [shell] {message}", timestamp());

    // stderr still helps in dev (`cargo tauri dev` attaches a console).
    eprintln!("{stamped}");

    let Some(Some(path)) = LAUNCHER_LOG.get() else {
        return;
    };
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            use std::io::Write;
            let _ = writeln!(file, "{stamped}");
        }
        Err(error) => {
            eprintln!("[shell] could not write the launcher log: {error}");
        }
    }
}

/// Minimal UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) with no chrono dependency.
///
/// Derived from the Unix epoch by civil-date arithmetic, so it stays correct
/// without pulling a date library into the launcher.
fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;

    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

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

    /// Returns the port if it is already known, without waiting.
    ///
    /// Used by the proxy commands, which must fail fast with a readable message
    /// rather than block a webview call for 15 seconds.
    fn port_now(&self) -> Option<u16> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .port
    }

    /// Kills the sidecar child if this process still owns it.
    ///
    /// Deliberately kills ONLY the sidecar. The harness is a detached process
    /// that the sidecar spawned; it is not a child of this shell and must
    /// survive (section 2.2, and the Phase 1 acceptance criterion).
    pub fn stop_sidecar(&self) {
        let mut slot = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Returns the recorded startup error, if any.
    ///
    /// This is the REAL reason the sidecar is missing (for example "Could not
    /// find sidecar/index.js. Searched, starting from the running executable:
    /// ..."). The UI must show this rather than a generic "no port yet", which
    /// is what made a release-build failure take far longer to diagnose than it
    /// should have.
    pub fn error(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .error
            .clone()
    }
}

/// Result of a proxied control call.
///
/// A non-2xx sidecar response is a NORMAL result, not a Rust error: the UI needs
/// the body (for example `{"status":"error","lastError":...}`) to show the user
/// what went wrong. Only transport failures become `Err`.
#[derive(Debug, Serialize)]
pub struct ProxiedResponse {
    /// HTTP status the sidecar returned. `0` when unavailable.
    pub code: u16,
    /// Parsed JSON body, or null when the body was not JSON.
    pub data: serde_json::Value,
    /// Human-readable note when the call could not be completed.
    pub error: Option<String>,
    /// The shell's own startup error, when the sidecar never came up.
    ///
    /// Without this the UI could only ever say "the sidecar has not reported a
    /// port yet", which is a symptom, not a cause. Populated from
    /// [`SidecarState::error`] so the dashboard shows the actual reason.
    ///
    /// Serialised as `shellError` to match the field name the TypeScript
    /// interface in `src/App.svelte` declares; the Rust name stays snake_case.
    #[serde(rename = "shellError")]
    pub shell_error: Option<String>,
}

impl ProxiedResponse {
    fn unavailable(message: impl Into<String>, shell_error: Option<String>) -> Self {
        Self {
            code: 0,
            data: serde_json::Value::Null,
            error: Some(message.into()),
            shell_error,
        }
    }
}

/// Payload for `open_harness_window`, so the UI can confirm what happened.
#[derive(Debug, Serialize)]
pub struct HarnessWindowState {
    pub open: bool,
    pub url: Option<String>,
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
    // Proof that the handshake reached the UI, and now a durable record too.
    log_line(&format!("frontend requested the sidecar port: {port}"));
    Ok(port)
}

/// Calls one control route on the sidecar and returns its response verbatim.
///
/// The shell does NOT interpret the body. `status`, `starting`, `error` and the
/// log tails are the sidecar's business; the UI renders them.
fn proxy_control(
    state: &tauri::State<'_, SidecarState>,
    method: &str,
    path: &str,
) -> ProxiedResponse {
    // Read the startup error FIRST: it is the real cause whenever the sidecar is
    // missing, and it is valid even after the port has appeared (the sidecar
    // could have died later).
    let shell_error = state.error();

    let Some(port) = state.port_now() else {
        return ProxiedResponse::unavailable(
            "The sidecar has not reported a port yet.",
            shell_error,
        );
    };

    let url = format!("http://127.0.0.1:{port}{path}");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROXY_TIMEOUT))
        .build()
        .new_agent();

    let result = if method == "POST" {
        agent.post(&url).send_empty()
    } else {
        agent.get(&url).call()
    };

    match result {
        Ok(response) => {
            let code = response.status().as_u16();
            // The sidecar always answers JSON; a parse failure is reported as a
            // transport-level note rather than being silently swallowed.
            match response.into_body().read_json::<serde_json::Value>() {
                Ok(data) => ProxiedResponse { code, data, error: None, shell_error },
                Err(error) => ProxiedResponse {
                    code,
                    data: serde_json::Value::Null,
                    error: Some(format!("The sidecar returned a non-JSON body: {error}")),
                    shell_error,
                },
            }
        }
        // The sidecar answers 4xx/5xx WITH a JSON body whenever it can, and
        // ureq surfaces those as `Err(StatusCode)`. That body is exactly what
        // the UI needs, so it must not be discarded as a failure.
        Err(ureq::Error::StatusCode(code)) => ProxiedResponse {
            code,
            data: serde_json::Value::Null,
            error: None,
            shell_error,
        },
        Err(error) => ProxiedResponse::unavailable(
            format!("Could not reach the DSH-Dock core on 127.0.0.1:{port}: {error}"),
            shell_error,
        ),
    }
}

/// Proxy for `GET /harness/status` (see `sidecar/lib/control.js`).
#[tauri::command]
fn harness_status(state: tauri::State<'_, SidecarState>) -> ProxiedResponse {
    proxy_control(&state, "GET", "/harness/status")
}

/// Proxy for `POST /harness/start`.
///
/// Returns as soon as the sidecar accepts the start (HTTP 202). It never waits
/// for the harness to boot - that can take minutes on a first run, and the UI
/// polls `harness_status` instead.
#[tauri::command]
fn harness_start(state: tauri::State<'_, SidecarState>) -> ProxiedResponse {
    proxy_control(&state, "POST", "/harness/start")
}

/// Proxy for `POST /harness/stop`.
///
/// When the stop succeeds, the harness window is closed: leaving it open on a
/// dead URL would show the user a browser error page. The frontend can re-open
/// it after a later start.
#[tauri::command]
fn harness_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> ProxiedResponse {
    let response = proxy_control(&state, "POST", "/harness/stop");

    let stopped = response
        .data
        .get("status")
        .and_then(|value| value.as_str())
        == Some("stopped");
    if response.error.is_none() && stopped {
        close_harness_window_inner(&app);
    }

    response
}

/// True when the `harness` window currently exists.
fn harness_window_open(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(HARNESS_WINDOW_LABEL).is_some()
}

/// Closes the `harness` window if it exists. Returns true when one was closed.
fn close_harness_window_inner(app: &tauri::AppHandle) -> bool {
    match app.get_webview_window(HARNESS_WINDOW_LABEL) {
        Some(window) => {
            let _ = window.close();
            true
        }
        None => false,
    }
}

/// Validates that `url` is a loopback HTTP URL the harness window may load.
///
/// Pure, so the rule is unit-testable without a running app. The URL comes from
/// the sidecar, but this shell must not become a generic "render any URL in a
/// window" gadget if that value were ever influenced by anything else - and a
/// non-loopback URL would be a request to fetch a remote page from the user's
/// machine, which is never what the harness needs.
///
/// Only the IPv4 literal `127.0.0.1` is accepted.
///
/// `localhost` is deliberately REJECTED, matching section 2.7 and the PORTS the
/// project already pins: on Windows `localhost` resolves to `[::1]` for some
/// clients and `127.0.0.1` for others, which is exactly the mismatch that
/// produced a blank Phase 0 window. The harness always reports the literal, so
/// refusing the name costs nothing and removes the ambiguity.
///
/// `[::1]` is rejected too: section 2.7 pins this project to IPv4, and the
/// harness's bind host is `127.0.0.1` or nothing (verified in
/// `dsh-host-webserver`), so allowing IPv6 loopback would be dead permission.
pub fn validate_harness_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("Invalid harness URL: {error}"))?;

    if parsed.scheme() != "http" {
        return Err(format!(
            "Refusing to open a non-HTTP harness URL: {url}. The harness is served over plain http on loopback."
        ));
    }

    let host_ok = matches!(parsed.host_str(), Some("127.0.0.1"));
    if !host_ok {
        return Err(format!(
            "Refusing to open a non-loopback harness URL: {url}. The harness is always served on the IPv4 literal 127.0.0.1."
        ));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "Refusing to open a harness URL carrying credentials: {url}"
        ));
    }

    Ok(parsed)
}

/// Environment variable that auto-opens the harness window once it is running.
///
/// DIAGNOSTIC ONLY. Clicking "Open Harness" cannot be automated (WebView2
/// exposes no injectable path - see NOTES.md), so reproducing a blank harness
/// window required a human click, on a specific machine, at a specific moment.
/// Setting this variable makes the window open by itself the moment the harness
/// reports `running`, so `launcher.log` captures the navigation trace without
/// anyone touching the UI.
///
/// Nothing sets it in production; it is read-only and defaults to off.
const AUTO_OPEN_ENV_VAR: &str = "DSH_DOCK_AUTO_OPEN_HARNESS";

/// When set, watches for a running harness and opens the window for it.
///
/// Runs on its own thread so it cannot block startup or the event loop, and
/// deliberately never panics: a diagnostic must not be able to take the app down.
fn spawn_auto_open_watcher(app: tauri::AppHandle) {
    if std::env::var(AUTO_OPEN_ENV_VAR).ok().as_deref() != Some("1") {
        return;
    }

    log_line("auto-open: ENABLED (diagnostic hook) - will open the harness window when it reports running");

    thread::spawn(move || {
        // Up to ~6 minutes: a cold first boot can take several.
        for _ in 0..720 {
            thread::sleep(Duration::from_millis(500));

            let state = app.state::<SidecarState>();
            let Some(port) = state.port_now() else { continue };

            let url = format!("http://127.0.0.1:{port}/harness/status");
            let agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(5)))
                .build()
                .new_agent();

            let Ok(response) = agent.get(&url).call() else { continue };
            let Ok(body) = response.into_body().read_json::<serde_json::Value>() else {
                continue;
            };

            if body.get("status").and_then(|value| value.as_str()) != Some("running") {
                continue;
            }
            let Some(harness_url) = body.get("url").and_then(|value| value.as_str()) else {
                continue;
            };

            match validate_harness_url(harness_url) {
                Ok(parsed) => {
                    if harness_window_open(&app) {
                        continue;
                    }
                    log_line(&format!("auto-open: opening the harness window at {harness_url}"));
                    if let Err(error) = build_harness_window(&app, parsed) {
                        log_line(&format!("auto-open: FAILED - {error}"));
                    }

                    // Optional second pass that exercises the RE-NAVIGATE path,
                    // which is where the freeze was reported. Gated separately so
                    // the normal diagnostic run does not trigger it.
                    if std::env::var(AUTO_RENAVIGATE_ENV_VAR).ok().as_deref() == Some("1") {
                        thread::sleep(Duration::from_secs(5));
                        if let Some(existing) = app.get_webview_window(HARNESS_WINDOW_LABEL) {
                            let Ok(target) = validate_harness_url(harness_url) else {
                                log_line("auto-renavigate: url no longer valid");
                                return;
                            };
                            let started = std::time::Instant::now();
                            log_line("auto-renavigate: calling navigate() on the existing window...");
                            let result = existing.navigate(target);
                            log_line(&format!(
                                "auto-renavigate: navigate() returned in {}ms -> {:?}",
                                started.elapsed().as_millis(),
                                result.map_err(|error| error.to_string())
                            ));
                        } else {
                            log_line("auto-renavigate: the harness window is gone");
                        }
                    }

                    // One attempt is enough to capture a trace.
                    return;
                }
                Err(error) => {
                    log_line(&format!("auto-open: refusing the reported url - {error}"));
                    return;
                }
            }
        }
        log_line("auto-open: gave up waiting for a running harness");
    });
}

/// How to turn on Chrome DevTools Protocol for BOTH windows.
///
/// WebView2 reads `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` from its environment
/// and applies it to every webview it creates, which is exactly what a
/// diagnostic needs:
///
/// ```text
/// $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
/// ```
///
/// `http://127.0.0.1:9222/json/list` then lists the DSH-Dock dashboard AND the
/// harness window as separate `page` targets, each with console, network and
/// DOM access.
///
/// WHY THE SHELL DOES *NOT* CALL `additional_browser_args()` ITSELF - measured,
/// not assumed. Passing `--remote-debugging-port` to the HARNESS window's own
/// environment made the window build (0ms) and then NEVER NAVIGATE: no
/// `navigating` line, no page load, no CDP listener, a permanently blank
/// window. Reproduced twice - on its own, and alongside the environment
/// variable. The main window's WebView2 environment already owns the browser
/// process for the shared user-data folder, so a second environment cannot be
/// given its own browser arguments.
///
/// An earlier revision shipped that per-window flag. It silently broke the very
/// window it was meant to diagnose, so it was removed rather than repaired. If a
/// per-window switch is ever needed again, it must come with a separate user
/// data folder per window.
#[allow(dead_code)]
const WEBVIEW2_ARGS_ENV_VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Environment variable that makes the auto-open watcher re-navigate the
/// harness window a few seconds after opening it.
///
/// DIAGNOSTIC ONLY. The reported freeze happened on the RE-NAVIGATE path, so
/// this exercises it without a human click and records how long `navigate()`
/// took. The call happens on the watcher's own thread, so it takes the
/// queue-only branch of `send_user_message` - the same branch
/// [`open_harness_window`] now uses.
const AUTO_RENAVIGATE_ENV_VAR: &str = "DSH_DOCK_AUTO_RENAVIGATE";

/// How long `navigate()` may take before the shell gives up on it.
///
/// The call queues a message to the event loop and normally returns instantly.
/// It is bounded anyway because an unresponsive webview must never be able to
/// hold a launcher command open indefinitely - the previous behaviour left the
/// window unclosable for minutes with no feedback.
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Builds the harness window at `parsed`, with navigation diagnostics attached.
///
/// THE LOGGING IS A DIAGNOSTIC, NOT DECORATION. A blank harness window was
/// observed on a clean VM while the SAME url rendered perfectly in Edge, and the
/// window then resisted closing - which pointed at navigation, not at the
/// harness. These two handlers separate the possibilities:
///
///   `on_page_load` Started then Finished  -> navigation worked; look elsewhere
///   Started but never Finished            -> the redirect is hanging
///   neither                               -> the webview never began loading
///   `on_navigation` with no following load -> the URL was refused before load
///
/// They are cheap, and they make the next occurrence self-diagnosing from
/// `logs/launcher.log` alone.
fn build_harness_window(
    app: &tauri::AppHandle,
    parsed: tauri::Url,
) -> Result<tauri::WebviewWindow, String> {
    let shown = parsed.to_string();

    // Timed because the leading hypothesis for the blank-window freeze was that
    // `build()` blocks the event loop. A long gap between "opening" and the
    // first navigation event confirms that; a short one rules it out.
    let started = std::time::Instant::now();

    let builder = WebviewWindowBuilder::new(app, HARNESS_WINDOW_LABEL, WebviewUrl::External(parsed))
        .title("DeepSeek Harness")
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .on_navigation(move |url| {
            // Returning true means "allow". The shell is not a navigation
            // policy engine; it only records where the webview is going, which
            // reveals whether the token URL was followed to its redirect.
            let shown = url.to_string();
            log_line(&format!("harness window navigating to {shown}"));
            true
        })
        .on_page_load(|_window, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            log_line(&format!(
                "harness window page load {event}: {}",
                payload.url()
            ));
        });

    // NO `additional_browser_args()` HERE - on purpose. See the note on
    // WEBVIEW2_ARGS_ENV_VAR: passing browser arguments to this window's own
    // WebView2 environment stopped the window from ever navigating. Use the
    // environment variable instead; it covers this window and the dashboard.
    if std::env::var(WEBVIEW2_ARGS_ENV_VAR).is_ok() {
        log_line("webview2: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is set for this process");
    }

    let window = builder
        .build()
        .map_err(|error| {
            log_line(&format!("harness window build FAILED for {shown}: {error}"));
            format!("Could not open the harness window: {error}")
        })?;

    log_line(&format!(
        "harness window build() returned in {}ms",
        started.elapsed().as_millis()
    ));
    Ok(window)
}

/// Opens (or re-navigates) the `harness` window at `url`.
///
/// `url` is whatever the sidecar reported - a token-bearing
/// `http://127.0.0.1:<port>/?token=...` URL. It is used VERBATIM: rebuilding it
/// from a port would drop the token and the harness would refuse the page.
///
/// If the window already exists it is re-navigated rather than duplicated,
/// because Tauri window labels are unique - a second window with the same label
/// would fail anyway, and silently doing nothing would leave the user looking at
/// a stale page.
///
/// ASYNC, AND `navigate()` RUNS OFF THE MAIN THREAD. Both matter:
///
/// `tauri-runtime-wry`'s `send_user_message` runs the message INLINE when the
/// caller is already on the main thread, and merely queues it otherwise:
///
/// ```text
/// if current_thread().id() == context.main_thread_id {
///     handle_user_message(...)          // runs the WebView2 call right here
/// } else {
///     context.proxy.send_event(message) // queue only; returns immediately
/// }
/// ```
///
/// A Tauri command runs on the main thread, so a busy or wedged WebView2 made
/// `navigate()` run its call inline and block the event loop - which is exactly
/// the reported 3m19s freeze, with every later click queued behind it. Awaiting
/// `spawn_blocking` takes the queue-only branch.
///
/// The timeout is belt-and-braces: even queued, an unresponsive webview must
/// never hold a launcher command open without limit.
#[tauri::command]
async fn open_harness_window(
    app: tauri::AppHandle,
    url: String,
) -> Result<HarnessWindowState, String> {
    let parsed = validate_harness_url(&url)?;
    log_line(&format!("open_harness_window requested for {url}"));

    if harness_window_open(&app) {
        let existing = app
            .get_webview_window(HARNESS_WINDOW_LABEL)
            .ok_or_else(|| "The harness window disappeared while re-opening it".to_owned())?;

        let target = parsed.clone();
        let started = std::time::Instant::now();
        let worker = tauri::async_runtime::spawn_blocking(move || existing.navigate(target));

        // Bounded: even the queue-only path must not hold a command open
        // indefinitely if the runtime itself is wedged.
        let joined = match tokio::time::timeout(NAVIGATE_TIMEOUT, worker).await {
            Ok(result) => result,
            Err(_) => {
                log_line(&format!(
                    "harness window re-navigate DID NOT COMPLETE within {}s - the webview is unresponsive",
                    NAVIGATE_TIMEOUT.as_secs()
                ));
                return Err(format!(
                    "The harness window is not responding, so it could not be re-navigated \
                     (gave up after {}s). Close the harness window and open it again.",
                    NAVIGATE_TIMEOUT.as_secs()
                ));
            }
        };

        let navigated =
            joined.map_err(|error| format!("The navigate worker could not be joined: {error}"))?;

        match navigated {
            Ok(()) => {
                log_line(&format!(
                    "harness window re-navigate accepted in {}ms (queued to the event loop)",
                    started.elapsed().as_millis()
                ));
            }
            Err(error) => {
                log_line(&format!("harness window re-navigate FAILED: {error}"));
                return Err(format!("Could not navigate the harness window: {error}"));
            }
        }

        if let Some(window) = app.get_webview_window(HARNESS_WINDOW_LABEL) {
            if let Err(error) = window.set_focus() {
                log_line(&format!("could not focus the harness window: {error}"));
            }
        }
        return Ok(HarnessWindowState { open: true, url: Some(url) });
    }

    let window = build_harness_window(&app, parsed)?;
    let _ = window.set_focus();
    log_line(&format!("harness window opened at {url}"));
    Ok(HarnessWindowState { open: true, url: Some(url) })
}

/// Closes the `harness` window if open. Idempotent.
#[tauri::command]
fn close_harness_window(app: tauri::AppHandle) -> HarnessWindowState {
    if close_harness_window_inner(&app) {
        log_line("harness window closed");
    }
    HarnessWindowState { open: false, url: None }
}

/// Resolves the repository root AT RUNTIME, from the running executable.
///
/// WHY THIS IS NOT `env!("CARGO_MANIFEST_DIR")`: that macro is evaluated when
/// the binary is COMPILED, so the absolute build-host path gets baked into the
/// executable. A release build copied to any other machine then looks for the
/// sidecar under the build host's directory, fails to find it, and (because a
/// release build has no console - see main.rs) fails silently. That was a real
/// release blocker: the dashboard rendered, no `node.exe` was ever spawned, and
/// nothing said why.
///
/// The walk is derived from `current_exe()`, so it is correct wherever the
/// binary is placed:
///
///   <root>/src-tauri/target/release/dsh-dock.exe   -> 4 ancestors -> <root>
///   <root>/src-tauri/target/debug/dsh-dock.exe     -> 4 ancestors -> <root>
///
/// Candidates are probed by looking for the sidecar entry point, not by
/// counting directories blindly: a copied or nested layout still resolves as
/// long as `sidecar/index.js` sits at some ancestor. The walk is bounded, and
/// the error names every directory that was tried.
///
/// TODO(Phase 4): replace this with `app.path().resource_dir()` once the
/// sidecar ships as a bundled resource (`resources/sidecar/index.js`) alongside
/// the bundled Node binary (`binaries/node(.exe)`). Then no repository walk is
/// needed at all and this function can be deleted.
pub fn resolve_repo_root() -> Result<PathBuf, String> {
    resolve_repo_root_from(std::env::current_exe().ok())
}

/// Testable core of [`resolve_repo_root`]: takes the exe path explicitly.
pub fn resolve_repo_root_from(exe: Option<PathBuf>) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();

    if let Some(exe) = exe {
        if let Some(dir) = exe.parent() {
            // Five levels covers `target/<profile>` plus a couple of extra
            // layouts; the entry-point probe below is what actually decides.
            let mut candidate = Some(dir.to_path_buf());
            for _ in 0..5 {
                let Some(current) = candidate else { break };
                if current.join("sidecar").join("index.js").is_file() {
                    return Ok(current);
                }
                tried.push(current.clone());
                candidate = current.parent().map(|parent| parent.to_path_buf());
            }
        } else {
            tried.push(PathBuf::from(format!("(no parent for {})", exe.display())));
        }
    } else {
        tried.push(PathBuf::from("(could not determine the executable path)"));
    }

    // Last resort: the process working directory. Only consulted if the exe
    // walk failed, so a launcher started from the repo root inside a strange
    // directory layout still works.
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("sidecar").join("index.js").is_file() {
            return Ok(cwd);
        }
        tried.push(cwd);
    }

    let looked = tried
        .iter()
        .map(|path| format!("\n    {}", path.display()))
        .collect::<String>();
    Err(format!(
        "Could not find sidecar/index.js. Searched, starting from the running \
         executable:{looked}\n\
         The launcher expects the repository layout (<root>/sidecar/index.js). \
         A packaged build ships the sidecar as a bundled resource instead \
         (TODO(Phase 4))."
    ))
}

/// Spawns the sidecar and wires its handshake into application state.
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let root = resolve_repo_root()?;
    let entry = root.join("sidecar").join("index.js");

    log_line(&format!("spawn: repository root resolved to {}", root.display()));

    if !entry.is_file() {
        // Kept as a separate check so the message can name the exact file. The
        // resolver above already probes this path, so this is now a race or a
        // permissions problem rather than a layout problem.
        let message = format!(
            "Sidecar entry point not found at {}. The launcher runs the sidecar \
             from the repository, so it expects a full checkout next to the binary.",
            entry.display()
        );
        log_line(&format!("spawn: FAILED - {message}"));
        return Err(message);
    }

    // During development the sidecar runs on system Node. Phase 4 adds the
    // bundled runtime (see the TODO above); this is the Phase 1 path only.
    log_line("spawn: starting `node sidecar/index.js`");

    // Stderr is PIPED, never inherited.
    //
    // WHY: this binary sets `windows_subsystem = "windows"` in release builds
    // (see main.rs), so it has NO console. Passing `Stdio::inherit()` for stderr
    // makes Windows allocate a console for the child, and a visible console
    // window appeared on a release build as a result. Piping keeps the child
    // console-free, and the reader thread below forwards the text into
    // launcher.log so nothing is lost.
    let mut command = Command::new("node");
    command
        .arg("sidecar/index.js")
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if SIDECAR_STDERR_INHERITED { Stdio::inherit() } else { Stdio::piped() });

    // CREATE_NO_WINDOW as well as piped stdio.
    //
    // Piping alone was NOT enough: a black `node.exe` console still appeared
    // beside the launcher. This shell is a GUI-subsystem binary with no console
    // of its own, so Windows creates one for the console-subsystem child. Piping
    // redirects the streams but does not stop the console from being allocated.
    //
    // The same flag is applied to the harness in `sidecar/lib/harness-start.js`;
    // both spawn sites need it.
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn `node sidecar/index.js`: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sidecar stdout was not captured".to_owned())?;

    // Forward the sidecar's stderr into the launcher log.
    //
    // The sidecar writes all of its diagnostics here - harness progress, npm
    // output, readiness timing. With stderr piped it would otherwise be captured
    // and dropped, which is strictly worse than a console window.
    let stderr_thread = child.stderr.take().map(|stderr| {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if !line.is_empty() {
                    log_line(&format!("sidecar: {line}"));
                }
            }
        })
    });
    if stderr_thread.is_none() {
        log_line("spawn: warning - the sidecar's stderr was not captured");
    }

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
                log_line(&format!("sidecar stdout: {line}"));
                continue;
            };

            match raw_port.trim().parse::<u16>() {
                Ok(port) if port > 0 => {
                    found = true;
                    state.set_port(port);
                    let _ = handle.emit(EVENT_SIDECAR_READY, ReadyPayload { port });
                    log_line(&format!("handshake received: sidecar ready on port {port}"));
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
        .invoke_handler(tauri::generate_handler![
            sidecar_port,
            harness_status,
            harness_start,
            harness_stop,
            open_harness_window,
            close_harness_window
        ])
        .setup(|app| {
            // The launcher log must exist BEFORE anything can fail, because on a
            // Windows release build it is the only place a failure is visible.
            init_launcher_log();
            log_line(&format!(
                "DSH-Dock starting (version {}, {} build, console: {})",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) { "debug" } else { "release" },
                if has_console() { "attached" } else { "none" }
            ));

            // A failed spawn must not abort startup: the window still needs to
            // open so the failure is visible to the user rather than silent.
            if let Err(message) = spawn_sidecar(app.handle()) {
                log_line(&format!("sidecar spawn FAILED: {message}"));
                let state = app.state::<SidecarState>();
                state.set_error(message.clone());
                let _ = app.handle().emit(EVENT_SIDECAR_ERROR, message);
            }

            // Off unless DSH_DOCK_AUTO_OPEN_HARNESS=1; see the note there.
            spawn_auto_open_watcher(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // NOTE (Phase 1): this handler must NEVER touch the harness.
            //
            // The harness is spawned detached by the sidecar and is designed to
            // outlive the launcher (section 2.2). Killing it here - the Phase 0
            // behaviour - would break the Phase 1 acceptance criterion that
            // closing the launcher leaves the harness running and the next
            // launch adopts it (section 2.3, and Step 4's live proof).
            if let tauri::WindowEvent::Destroyed = event {
                // The sidecar is a plain child of this process. When the MAIN
                // window is destroyed, the app is about to exit, so reap it
                // deterministically instead of leaving it to close on stdout
                // pipe teardown. Only `main` is treated as "the app is closing":
                // the harness window dying must not take the core down.
                if window.label() == MAIN_WINDOW_LABEL {
                    log_line("main window destroyed: stopping the sidecar");
                    let state = window.state::<SidecarState>();
                    state.stop_sidecar();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DSH-Dock")
        .run(|app, event| {
            // Belt and braces: on a normal exit, make sure the sidecar is gone.
            // The harness is deliberately NOT touched - see the note above.
            if let tauri::RunEvent::Exit = event {
                app.state::<SidecarState>().stop_sidecar();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // The URL guard is the only non-trivial pure logic in this shell, so it is
    // the one thing worth unit-testing here. Everything else is Tauri plumbing
    // covered by the PowerShell window/process tests.

    #[test]
    fn accepts_the_real_harness_url_shape() {
        // Exactly what the sidecar records (verified against a live boot).
        let url = "http://127.0.0.1:60555/?token=VC8S92xfd0OScVk7Y-iLu0G4KQGzVXvnY7Uj1xokf_U";
        let parsed = validate_harness_url(url).expect("the real URL shape must be accepted");
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.port(), Some(60555));
        // The token must survive untouched: rebuilding the URL from the port
        // would drop it and the harness would refuse the page.
        assert!(parsed.query().unwrap_or_default().contains("token="));
    }

    #[test]
    fn accepts_only_the_ipv4_loopback_literal() {
        assert!(validate_harness_url("http://127.0.0.1/").is_ok());
        assert!(validate_harness_url("http://127.0.0.1:1/?token=a").is_ok());
        assert!(validate_harness_url("http://127.0.0.1:65535/?token=a").is_ok());
    }

    #[test]
    fn rejects_localhost_and_ipv6_loopback_by_name() {
        // Section 2.7: `localhost` resolves inconsistently on Windows, which is
        // why every address in this project is the literal. The harness always
        // reports the literal, so refusing the name costs nothing.
        let error = validate_harness_url("http://localhost:3080/?token=a").unwrap_err();
        assert!(error.contains("non-loopback"), "{error}");

        // IPv6 would be a capability the harness can never use.
        let v6 = validate_harness_url("http://[::1]:3080/?token=a").unwrap_err();
        assert!(v6.contains("non-loopback"), "{v6}");
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        for url in [
            "http://example.com/?token=a",
            "http://10.0.0.5:3080/?token=a",
            "http://192.168.1.10:3080/?token=a",
            // Rebinding-style attack: a hostname that merely CONTAINS loopback.
            "http://127.0.0.1.evil.com/?token=a",
            "http://notlocalhost/?token=a",
        ] {
            assert!(
                validate_harness_url(url).is_err(),
                "must refuse a non-loopback host: {url}"
            );
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        for url in [
            "https://127.0.0.1:3080/?token=a",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<h1>hi</h1>",
            "tauri://localhost/",
        ] {
            assert!(
                validate_harness_url(url).is_err(),
                "must refuse a non-http scheme: {url}"
            );
        }
    }

    #[test]
    fn rejects_credentials_in_the_url() {
        assert!(validate_harness_url("http://user:pass@127.0.0.1:3080/?token=a").is_err());
        assert!(validate_harness_url("http://user@127.0.0.1:3080/?token=a").is_err());
    }

    #[test]
    fn rejects_unparseable_input() {
        assert!(validate_harness_url("not a url").is_err());
        assert!(validate_harness_url("").is_err());
        // A relative URL has no host and must not be treated as loopback.
        assert!(validate_harness_url("/harness/status").is_err());
    }

    #[test]
    fn error_messages_name_the_problem_and_the_url() {
        let error = validate_harness_url("http://example.com/?token=a").unwrap_err();
        assert!(error.contains("non-loopback"), "{error}");
        assert!(error.contains("example.com"), "{error}");

        let scheme_error = validate_harness_url("https://127.0.0.1/").unwrap_err();
        assert!(scheme_error.contains("non-HTTP"), "{scheme_error}");
    }

    #[test]
    fn the_window_and_event_names_are_stable() {
        // These strings are contract: the frontend and the sidecar rely on them.
        assert_eq!(HARNESS_WINDOW_LABEL, "harness");
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_eq!(READY_PREFIX, "SIDECAR_READY:");
        assert_eq!(EVENT_SIDECAR_READY, "sidecar:ready");
        assert_eq!(EVENT_SIDECAR_ERROR, "sidecar:error");
    }

    // --- release-build path resolution -------------------------------------
    //
    // These are the regression tests for the release blocker: the sidecar path
    // must be derived from the RUNNING binary, never from a compile-time
    // constant, so a build copied to another machine still finds its sidecar.

    /// Creates a fake checkout at `<tmp>/root` with `sidecar/index.js` present.
    fn make_fake_checkout(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dsh-dock-path-test-{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sidecar")).unwrap();
        std::fs::write(root.join("sidecar").join("index.js"), "// fixture\n").unwrap();
        root
    }

    #[test]
    fn resolves_the_root_from_a_release_binary_location() {
        let root = make_fake_checkout("release");
        // <root>/src-tauri/target/release/dsh-dock.exe -> 4 ancestors.
        let exe = root
            .join("src-tauri")
            .join("target")
            .join("release")
            .join("dsh-dock.exe");
        let resolved = resolve_repo_root_from(Some(exe)).expect("release layout must resolve");
        assert_eq!(resolved, root);

        // The debug layout must resolve identically, and the resolved directory
        // must be independent of where the binary lives.
        let debug_exe = root
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("dsh-dock.exe");
        assert_eq!(resolve_repo_root_from(Some(debug_exe)).unwrap(), root);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolution_does_not_depend_on_the_binary_path() {
        // The whole point of the fix: two different absolute locations, same
        // answer relative to their own tree.
        let root_a = make_fake_checkout("path-a");
        let root_b = make_fake_checkout("path-b-with-a-longer-name");

        let exe_a = root_a.join("src-tauri/target/release/dsh-dock.exe");
        let exe_b = root_b.join("src-tauri/target/release/dsh-dock.exe");

        assert_eq!(resolve_repo_root_from(Some(exe_a)).unwrap(), root_a);
        assert_eq!(resolve_repo_root_from(Some(exe_b)).unwrap(), root_b);

        let _ = std::fs::remove_dir_all(&root_a);
        let _ = std::fs::remove_dir_all(&root_b);
    }

    #[test]
    fn resolves_through_an_extra_directory_level() {
        // A copied tree with an extra wrapper directory still resolves, because
        // candidates are probed for sidecar/index.js rather than counted blindly.
        let root = make_fake_checkout("nested");
        let exe = root
            .join("extra")
            .join("src-tauri")
            .join("target")
            .join("release")
            .join("dsh-dock.exe");
        assert_eq!(resolve_repo_root_from(Some(exe)).unwrap(), root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_sidecar_is_reported_with_the_searched_paths() {
        let root = std::env::temp_dir().join("dsh-dock-path-test-missing");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src-tauri/target/release")).unwrap();

        let exe = root.join("src-tauri/target/release/dsh-dock.exe");
        let error = resolve_repo_root_from(Some(exe)).expect_err("must fail without a sidecar");

        // The message must be actionable: it names the file, and lists where it
        // looked, so a user can see exactly what the launcher expected.
        assert!(error.contains("sidecar/index.js"), "{error}");
        assert!(error.contains("release"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_or_absent_exe_never_panics() {
        // `current_exe()` can fail; the resolver must report, not panic.
        assert!(resolve_repo_root_from(None).is_err());
    }

    #[test]
    fn the_timestamp_formatter_produces_an_iso_like_utc_string() {
        let stamp = timestamp();
        // YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(stamp.len(), 20, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        // Sanity: the year is plausible, so the civil-date maths is not wildly wrong.
        let year: i32 = stamp[0..4].parse().expect("year");
        assert!((2024..2100).contains(&year), "{stamp}");
    }

    #[test]
    fn the_launcher_log_path_is_under_the_data_dir() {
        // Mirrors the sidecar's rule; a failure before the sidecar exists still
        // has somewhere to be written.
        let previous = std::env::var(DATA_DIR_ENV_VAR).ok();
        std::env::set_var(DATA_DIR_ENV_VAR, std::env::temp_dir().join("dsh-dock-log-test"));

        let path = launcher_log_path().expect("a data dir is resolvable");
        assert!(path.ends_with("logs/launcher.log") || path.ends_with("logs\\launcher.log"), "{path:?}");

        match previous {
            Some(value) => std::env::set_var(DATA_DIR_ENV_VAR, value),
            None => std::env::remove_var(DATA_DIR_ENV_VAR),
        }
    }

    #[test]
    fn the_launcher_log_is_append_only_and_survives_multiple_writes() {
        let dir = std::env::temp_dir().join("dsh-dock-log-append-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("launcher.log");

        // Two appends must both survive: the log is a timeline, not a snapshot.
        {
            use std::io::Write;
            let mut first = std::fs::OpenOptions::new().create(true).append(true).open(&file).unwrap();
            writeln!(first, "line one").unwrap();
        }
        {
            use std::io::Write;
            let mut second = std::fs::OpenOptions::new().create(true).append(true).open(&file).unwrap();
            writeln!(second, "line two").unwrap();
        }

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("line one"), "{text}");
        assert!(text.contains("line two"), "{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sidecar_stderr_is_never_inherited() {
        // Regression test for the visible-console bug.
        //
        // `stdio_inherit` is the source of truth: on a `windows_subsystem =
        // "windows"` binary, inheriting the parent's stderr makes Windows
        // allocate a console for the child, which showed up as a stray console
        // window in release builds. The sidecar's stderr must be PIPED so the
        // launcher can forward it into launcher.log instead.
        assert!(
            !SIDECAR_STDERR_INHERITED,
            "the sidecar's stderr must not be inherited"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_sidecar_spawn_uses_create_no_window() {
        // Piping stdio is NOT sufficient on Windows: without CREATE_NO_WINDOW,
        // Windows still allocates a console for the console-subsystem child, and
        // a black node.exe window appeared beside the launcher.
        //
        // This pins the value that `spawn_sidecar` applies via
        // `CommandExt::creation_flags`, and that must stay in sync with
        // `CREATE_NO_WINDOW` in sidecar/lib/harness-start.js (which the sidecar
        // test suite asserts separately).
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000, "CREATE_NO_WINDOW is 0x08000000");
    }

    #[test]
    fn the_release_subsystem_attribute_is_still_present_in_main() {
        // Bug 2 mentioned this as a possible second cause. It was never missing
        // - the console came from `Stdio::inherit()` - but this test keeps it
        // that way, since removing the attribute would show a console for the
        // launcher itself.
        let main_rs = include_str!("main.rs");
        assert!(
            main_rs.contains("windows_subsystem = \"windows\""),
            "main.rs must keep the windows_subsystem attribute"
        );
        assert!(
            main_rs.contains("not(debug_assertions)"),
            "the attribute must apply to release builds only"
        );
    }
}
