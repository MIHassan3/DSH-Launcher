//! First-run welcome wizard - the wizard's data, its window, and its hand-off.
//!
//! Sections 3.9 and 4 (Pause 4) of `docs/PROJECT_DSH-DOCK.md`: on first launch the
//! dashboard is HIDDEN and a small centered window asks which harness channel to
//! track. Answering it writes `auto_update_channel` and `first_run_completed = true`
//! in ONE atomic write ([`SettingsState::complete_first_run`]), hides the wizard,
//! and hands the user to the dashboard with the harness start flow already
//! running.
//!
//! THE SHAPE OF THIS FILE is the same plan/adapter split as `menu.rs`, and for the
//! same reason: everything that can be decided without a window is decided in a
//! pure function that a unit test can call, and the Tauri construction is a thin
//! adapter at the bottom. [`WizardOption`], [`welcome_options`],
//! [`preselected_channel`], [`gate_decision`] and [`InstallAndOpenPayload`] are the
//! pure part; [`build_welcome_window`] and [`submit_and_hand_off`] are the adapter.
//!
//! WHAT THIS WIZARD DELIBERATELY DOES NOT DO: start the harness itself, or decide
//! anything about versions. It records the user's channel and emits
//! [`EVENT_INSTALL_AND_OPEN`]; the dashboard owns "start the harness" (it has the
//! polling and the status handling already) and the sidecar owns version
//! resolution. See the note below on why the recorded channel does not yet change
//! what gets installed.
//!
//! THE RECORDED CHANNEL IS FOR PHASE 2. As of this build nothing in `sidecar/`
//! reads `auto_update_channel`, so "Install and Open Harness" installs whatever
//! the sidecar already installs regardless of the radio button. The choice is
//! persisted - that is the whole point of doing it in one atomic write now - and
//! Phase 2 makes it load-bearing. `NOTES.md` says so too, so a future reader is
//! not left assuming otherwise.

use serde::{Deserialize, Serialize};
use std::thread;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::log_line;
use crate::menu::{self, RebuildReason};
use crate::settings::{self, SettingsState};

/// Main-thread marshalling, re-exported from `menu` so `lib.rs`'s close handler
/// has one obvious import for the hand-off path.
///
/// It is not duplicated here: two implementations of "run this on the main thread"
/// is exactly the kind of thing that drifts, and the menu's version already logs
/// the failure to reach it.
pub(crate) use crate::menu::on_main;

/// Label of the first-run wizard window.
///
/// Distinct from `main` and `harness`; `capabilities/welcome.json` scopes the one
/// command this window may invoke to exactly this label.
pub const WELCOME_WINDOW_LABEL: &str = "welcome";

/// Event that tells the dashboard to install and open the harness.
///
/// Emitted to `main` ONLY. A broadcast would push a DOM event into the harness
/// page, which is the opaque black box this launcher never touches (the same rule
/// [`menu::EVENT_SETTINGS_CHANGED`] follows).
pub const EVENT_INSTALL_AND_OPEN: &str = "install-and-open";

/// Window title (section 3.9).
pub const WELCOME_TITLE: &str = "Welcome to DSH-Dock";

/// The wizard's client area, in logical pixels (section 3.9, "approximately
/// 500x300").
///
/// INNER, not outer: `inner_size` sets the client area, so the window a user sees
/// is about 39 logical pixels taller than this once the title bar is added. A spec
/// that says "500x300" is ambiguous about which box it means; this constant is the
/// client area, and `NOTES.md` records the distinction so the next reader does not
/// have to guess.
pub const WELCOME_INNER_SIZE: (f64, f64) = (500.0, 300.0);

/// The channel the wizard pre-selects, and the channel a dismissal records.
///
/// One source of truth: a dismissal defaults to `rc` (section 3.9), and `rc` is
/// also the option labelled "recommended", so the pre-selected radio button and
/// the dismissed outcome cannot disagree.
pub const PRESELECTED_CHANNEL: &str = settings::DEFAULT_CHANNEL;

/// Why [`EVENT_INSTALL_AND_OPEN`] was emitted.
///
/// Carried so the dashboard - and anyone reading `launcher.log` - can tell a real
/// choice from a dismissal. Section 3.9 requires a dismissal to proceed anyway, so
/// the two paths must be distinguishable AFTER the fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubmitReason {
    /// The user pressed "Install and Open Harness".
    Submitted,
    /// The user dismissed the wizard - the X, or "Skip for now". The default
    /// channel is recorded and the hand-off happens anyway (section 3.9).
    Dismissed,
}

impl SubmitReason {
    /// The token used in the event payload and the log line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Dismissed => "dismissed",
        }
    }
}

/// One radio button in the wizard (section 3.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WizardOption {
    /// The value written to `auto_update_channel` when this option is chosen.
    ///
    /// These are `settings::SELECTABLE_CHANNELS` values exactly - `all` is the
    /// value for "All channels", NOT the literal string "all channels".
    pub channel: &'static str,
    /// The option's primary text.
    pub label: &'static str,
    /// The explanatory tail, rendered after a dash.
    pub detail: &'static str,
    /// True for an option that is visible but cannot be chosen.
    pub disabled: bool,
}

impl WizardOption {
    /// The single-line text of this option, as section 3.9 renders it.
    pub fn text(self) -> String {
        format!("{} - {}", self.label, self.detail)
    }
}

/// The wizard's options, in the order section 3.9 lists them.
///
/// `stable` is present and DISABLED rather than absent, exactly as the menu's
/// Auto-update submenu does it (Q48): the option exists, the user can see it, and
/// it explains itself instead of silently missing. A disabled option here is also
/// why the wizard needs no "no release yet" error path.
pub fn welcome_options() -> [WizardOption; 4] {
    [
        WizardOption {
            channel: "rc",
            label: "RC",
            detail: "release candidates (recommended)",
            disabled: false,
        },
        WizardOption {
            channel: "alpha",
            label: "Alpha",
            detail: "bleeding edge, changes often",
            disabled: false,
        },
        WizardOption {
            channel: "all",
            label: "All channels",
            detail: "always newest",
            disabled: false,
        },
        WizardOption {
            channel: "stable",
            label: "Stable",
            detail: "not available yet",
            disabled: true,
        },
    ]
}

/// The channel the wizard should start with.
///
/// The current value when the user already has one, otherwise the recommended
/// default. A user whose settings file exists but whose flag is false - a
/// half-finished earlier run, or a hand-edited file - sees their own value
/// selected rather than being silently moved to `rc`.
///
/// The result is always a channel the wizard can actually submit, so a value the
/// file happens to hold which this build cannot select (say `beta`) cannot become
/// an un-submittable pre-selection.
pub fn preselected_channel(settings: &settings::Settings) -> &'static str {
    if settings::is_selectable_channel(&settings.auto_update_channel) {
        match settings.auto_update_channel.as_str() {
            "alpha" => "alpha",
            "all" => "all",
            // `rc` and anything else selectable that is not listed above.
            _ => PRESELECTED_CHANNEL,
        }
    } else {
        PRESELECTED_CHANNEL
    }
}

/// What `setup` should do about the first-run wizard.
///
/// Pure data so the decision is unit-testable without building an app: the gate
/// runs exactly once, during `setup`, and getting it wrong either hides the
/// dashboard behind a wizard that never appears or shows a wizard on every
/// launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateDecision {
    /// True when the wizard must be created and shown.
    pub show_welcome: bool,
    /// True when the dashboard must be hidden.
    pub hide_main: bool,
}

/// The first-run gate (section 3.9).
///
/// A completed first run leaves both windows alone: the dashboard is the app, and
/// hiding it for a wizard that is not coming would strand the user with no window
/// at all - so the two flags are always equal, and this function is where that
/// invariant lives.
pub fn gate_decision(first_run_completed: bool) -> GateDecision {
    GateDecision {
        show_welcome: !first_run_completed,
        hide_main: !first_run_completed,
    }
}

/// True when the first-run wizard should be shown.
///
/// A reading helper so `setup` can log the decision without unpacking the struct.
pub fn needs_first_run_wizard(state: &SettingsState) -> bool {
    gate_decision(state.first_run_completed()).show_welcome
}

/// Payload of [`EVENT_INSTALL_AND_OPEN`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallAndOpenPayload {
    /// The channel now recorded in `settings.json`.
    pub channel: String,
    /// True when the wizard was dismissed rather than answered.
    pub dismissed: bool,
}

impl InstallAndOpenPayload {
    /// Builds the payload for one hand-off.
    pub fn new(channel: impl Into<String>, reason: SubmitReason) -> Self {
        Self {
            channel: channel.into(),
            dismissed: reason == SubmitReason::Dismissed,
        }
    }
}

/// The wizard window's URL, with the pre-selected channel as a query parameter.
///
/// WHY A QUERY PARAMETER rather than a command: the wizard needs one string that
/// is already in the settings file, and a `get_settings` command would widen the
/// wizard's capability footprint for a cosmetic default. The URL is built by the
/// shell, so the value is launcher-controlled - the same trust boundary the
/// harness URL is validated against - and the frontend only reads it.
///
/// `index.html` is the dev server's document AND the bundled document, so the same
/// path resolves in both (`?preselect=` survives the dev server's own query
/// handling, and a release build serves `index.html?preselect=rc` from the asset
/// protocol).
pub fn welcome_url(channel: &str) -> String {
    format!("index.html?preselect={channel}")
}

/// The channel a wizard URL's `preselect` parameter names, or `None`.
///
/// The parsing half of [`welcome_url`], kept pure and separate so the frontend's
/// contract is testable and so a malformed or hostile value degrades to "no
/// preference" rather than to an un-selectable radio button.
pub fn channel_from_query(query: &str) -> Option<String> {
    let query = query.strip_prefix('?').unwrap_or(query);

    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or_default();
        if key != "preselect" {
            continue;
        }
        let value = parts.next().unwrap_or_default();
        // Only a value this build could actually submit is accepted. An
        // unknown channel must not become a pre-selected button that
        // `validate_channel` would then refuse.
        if settings::is_selectable_channel(value) {
            return Some(value.to_owned());
        }
        return None;
    }

    None
}

/// Validates and resolves the channel a `welcome_submit` call should record.
///
/// Two sources, one rule: an explicit choice must be selectable, and `None` -
/// which is what a dismissal passes - resolves to [`PRESELECTED_CHANNEL`]
/// (section 3.9: closing without choosing defaults to `rc` and proceeds anyway).
///
/// The returned value is what gets written, so `complete_first_run`'s own
/// validation becomes a belt-and-braces second check rather than the only one.
pub fn resolve_channel(requested: Option<&str>) -> Result<String, String> {
    match requested {
        Some(channel) => {
            settings::validate_channel(channel)?;
            Ok(channel.to_owned())
        }
        None => Ok(PRESELECTED_CHANNEL.to_owned()),
    }
}

// --- Window construction ----------------------------------------------------

/// Builds the wizard window, centered, at [`WELCOME_INNER_SIZE`].
///
/// WHY THE WINDOW IS CREATED HERE rather than declared in `tauri.conf.json`: a
/// config window exists from launch on EVERY run, and the wizard exists only when
/// the first run is not complete. Declaring it in the config would mean creating
/// and destroying a window on every normal launch just to keep the two shapes
/// identical, and the config file cannot express "only on first run".
///
/// The menu is cleared immediately after creation (C1 part A). Config windows and
/// windows created later inherit the app-wide menu, and `menu::rebuild_menu` has
/// not yet run again by the time this window appears, so without this the wizard
/// would carry a `Harness | Dock | Settings` bar whose clicks can only ever log
/// "could not deliver". [`menu::clear_welcome_menu`] is the one helper both this
/// and the rebuild guard call, so the two cannot drift.
pub fn build_welcome_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    preselect: &str,
) -> Result<tauri::WebviewWindow<R>, String> {
    let url = welcome_url(preselect);
    let started = std::time::Instant::now();

    let window = WebviewWindowBuilder::new(
        app,
        WELCOME_WINDOW_LABEL,
        WebviewUrl::App(url.clone().into()),
    )
    .title(WELCOME_TITLE)
    .inner_size(WELCOME_INNER_SIZE.0, WELCOME_INNER_SIZE.1)
    // The content is a fixed radio group and one button: letting the user resize
    // it would let them shrink the primary button out of reach.
    .resizable(false)
    .maximizable(false)
    .center()
    .build()
    .map_err(|error| {
        log_line(&format!("welcome: window build FAILED ({url}): {error}"));
        format!("Could not open the first-run window: {error}")
    })?;

    menu::clear_welcome_menu(app, "creation");

    log_line(&format!(
        "welcome: window built in {}ms at {url} (preselect={preselect})",
        started.elapsed().as_millis()
    ));

    Ok(window)
}

// --- Hand-off ---------------------------------------------------------------

/// True while a hand-off is in flight.
///
/// WHY THIS EXISTS, and it is not theoretical. `submit_and_hand_off` ends by
/// CLOSING the wizard window, and closing a window produces a `CloseRequested`
/// event - which `lib.rs` intercepts precisely so that the X counts as a
/// dismissal. Without this flag those two facts compose into a regress: the close
/// handler vetoes the close (so `close()` never takes effect), then submits again,
/// which closes again. The wizard would sit on screen with the app apparently
/// frozen, and no unit test can see it - it is a property of the event loop.
///
/// So the rule is simple: ONE hand-off at a time, and the close handler stands down
/// while one is running.
static SUBMIT_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Claims the one in-flight hand-off slot. False when another caller holds it.
///
/// The compare-exchange is what makes this safe against a click landing while the
/// diagnostic hook is already submitting: the second caller gets `false` and does
/// nothing, rather than racing the first one's `settings.json` write.
pub fn begin_submit() -> bool {
    SUBMIT_IN_FLIGHT
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
}

/// Releases the in-flight slot.
pub fn end_submit() {
    SUBMIT_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// True while a hand-off is in flight. Read by the close handler in `lib.rs`.
pub fn submit_in_flight() -> bool {
    SUBMIT_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst)
}

/// Records the wizard's outcome and hands the user to the dashboard.
///
/// ONE implementation for both entry points (C1 / A3): the `welcome_submit`
/// command and the window's own close request both land here, so a button click
/// and an X can never drift apart. `requested` is `None` for a dismissal.
///
/// ORDER MATTERS, and every step is here for a reason:
///
///   1. `complete_first_run` writes the channel AND the flag in one atomic write
///      (Q61). A failure returns early and the wizard STAYS OPEN - a wizard closed
///      over a failed write would vanish with nothing recorded, and the next
///      launch would show it again with no explanation (A9).
///   2. Re-read the snapshot rather than trusting the argument, so the menu, the
///      event and the log all report what is actually on disk.
///   3. Everything that touches a window or the menu runs inside `on_main`: the
///      menu rebuild is main-thread-only (section 2.8.3), and this function can be
///      reached from a command or from a close handler.
///   4. The dashboard is SHOWN BEFORE the hand-off intent is armed, so a dashboard
///      that is still loading is visible while it happens.
///   5. The emit itself is not done here: [`menu::arm_install_and_open`] delivers
///      it when `main` is actually listening (C2), because `main`'s page has been
///      loading while hidden and may not have registered its listener yet.
pub fn submit_and_hand_off<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    requested: Option<&str>,
    reason: SubmitReason,
) -> Result<(), String> {
    // Claimed BEFORE the write, so a dismissal that arrives mid-write is dropped
    // rather than starting a second one.
    if !begin_submit() {
        log_line(&format!(
            "welcome: a hand-off is already in flight - ignoring this {} request",
            reason.as_str()
        ));
        return Ok(());
    }

    let outcome = record_and_hand_off(app, requested, reason);

    // The slot is released by `record_and_hand_off`'s main-thread closure, AFTER
    // the window has been destroyed - NOT here.
    //
    // THAT ORDER IS THE SECOND HALF OF THE BUG. `record_and_hand_off` only QUEUES
    // its window work onto the main thread; it returns immediately. Releasing the
    // slot here therefore cleared the flag on the submitting thread while the
    // queued close had not run yet, so by the time `CloseRequested` reached the
    // handler the flag was false - and the handler treated the hand-off's OWN close
    // as a user's X. The log from the failed acceptance run shows the result: a
    // tight loop of `welcome CloseRequested` / `dismissed with the window close
    // button`, thousands of them in one second, with `close requested while a
    // hand-off is in flight` never appearing once.
    //
    // The one case that still has to release it here is the failure path: when the
    // work was never queued there is no closure to do it, and leaving the slot
    // claimed would make the wizard permanently unsubmittable.
    if outcome.is_err() {
        end_submit();
    }

    outcome
}

/// The body of [`submit_and_hand_off`], with the in-flight slot already claimed.
fn record_and_hand_off<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    requested: Option<&str>,
    reason: SubmitReason,
) -> Result<(), String> {
    let channel = resolve_channel(requested)?;

    let settings_state = app.state::<SettingsState>();
    let settings = settings_state.complete_first_run(&channel).map_err(|error| {
        // The wizard shows this verbatim. It names the file and the reason, so a
        // read-only data directory is diagnosable from the wizard itself rather
        // than from a log the user has no reason to find.
        log_line(&format!(
            "welcome: could not record the first run ({}): {error}",
            reason.as_str()
        ));
        error
    })?;

    log_line(&format!(
        "welcome: first run complete - reason={} channel={} first_run_completed={}",
        reason.as_str(),
        settings.auto_update_channel,
        settings.first_run_completed
    ));

    // Marshalled by hand rather than through `menu::on_main`, because the closing
    // of the in-flight slot has to happen inside the closure on the main thread.
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let app = &handle;

        // The menu is showing the pre-wizard channel; it must not keep doing so.
        if let Some(runtime) = app.try_state::<menu::MenuRuntime>() {
            runtime.apply_settings(&settings);
        }
        menu::rebuild_menu(app, RebuildReason::SettingsChange);

        if let Err(error) = app.emit_to(
            crate::MAIN_WINDOW_LABEL,
            menu::EVENT_SETTINGS_CHANGED,
            settings.clone(),
        ) {
            log_line(&format!(
                "welcome: could not emit {}: {error}",
                menu::EVENT_SETTINGS_CHANGED
            ));
        }

        dismiss_wizard(app, reason);
        show_dashboard(app);

        menu::arm_install_and_open(
            app,
            InstallAndOpenPayload::new(settings.auto_update_channel.clone(), reason),
        );

        // LAST, and on this thread: every window action above is finished, so a
        // `CloseRequested` can no longer be mistaken for the hand-off's own close.
        end_submit();
    }) {
        // Nothing was queued, so nothing will release the slot.
        log_line(&format!(
            "welcome: could not reach the main thread for the hand-off: {error}"
        ));
        return Err(format!(
            "the hand-off could not be delivered to the main thread: {error}"
        ));
    }

    Ok(())
}

/// Closes the wizard window, if it is still open.
///
/// Logged on both paths: "the wizard is gone" and "the wizard refused to close"
/// look identical from outside otherwise, and the second one leaves a user staring
/// at a window they already answered.
pub(crate) fn dismiss_wizard<R: tauri::Runtime>(app: &tauri::AppHandle<R>, reason: SubmitReason) {
    let Some(window) = app.get_webview_window(WELCOME_WINDOW_LABEL) else {
        log_line(&format!(
            "welcome: nothing to close ({}) - the window is already gone",
            reason.as_str()
        ));
        return;
    };

    match window_operation() {
        WindowOperation::Destroy => match window.destroy() {
            Ok(()) => log_line(&format!(
                "welcome: window destroyed ({}) - no close request is emitted for this",
                reason.as_str()
            )),
            Err(error) => log_line(&format!(
                "welcome: could not destroy the window ({}): {error}",
                reason.as_str()
            )),
        },
    }
}

/// Shows, unminimizes and focuses the dashboard (section 3.9).
///
/// All three, in this order, and each one logged: a hidden or minimized window
/// cannot take focus, and "the wizard vanished and nothing appeared" is the worst
/// possible outcome of a first run. `menu::open_control_panel` does the same three
/// calls for the same reason.
pub(crate) fn show_dashboard<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        log_line("welcome: the dashboard window is GONE - the hand-off cannot complete");
        return;
    };

    for (what, result) in [
        ("show", window.show()),
        ("unminimize", window.unminimize()),
        ("focus", window.set_focus()),
    ] {
        match result {
            Ok(()) => log_line(&format!("welcome: dashboard {what} ok")),
            Err(error) => log_line(&format!("welcome: could not {what} the dashboard: {error}")),
        }
    }
}

/// How the wizard window is taken off screen.
///
/// A ONE-VARIANT ENUM, deliberately: it exists so the decision is a value a test
/// can assert, because getting it wrong is an infinite loop in the event loop that
/// no unit test can reach by running the app.
///
/// WHY IT MUST BE `Destroy` AND NOT `Close`. `WebviewWindow::close()` is documented
/// as emitting `WindowEvent::CloseRequested` "first like a user-initiated close
/// request so you can intercept it" - and `lib.rs` intercepts exactly that event to
/// make the X count as a dismissal. So a programmatic `close()` is
/// INDISTINGUISHABLE from a user pressing X, and that is the whole bug:
///
///   1. the hand-off finishes by calling `close()`;
///   2. which raises `CloseRequested`;
///   3. which the handler vetoes and answers by calling `close()` again;
///   4. which raises `CloseRequested` again - forever, inside the event loop.
///
/// `WebviewWindow::destroy()` is documented as "similar to close but does NOT emit
/// any events and force close the window instead", which is exactly what a
/// hand-off that has already recorded the outcome needs: the window is being
/// discarded, not asked to consider closing. A real X still arrives as a
/// `CloseRequested` and is still vetoed and honoured as a dismissal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOperation {
    /// `destroy()`: remove the window without raising `CloseRequested`.
    Destroy,
}

/// The operation used to take the wizard window off screen. See [`WindowOperation`].
pub fn window_operation() -> WindowOperation {
    WindowOperation::Destroy
}

// --- The diagnostic auto-submit ---------------------------------------------

/// Environment variable that answers the wizard without a click.
///
/// DIAGNOSTIC ONLY, and it exists for the same reason `DSH_DOCK_AUTO_OPEN_HARNESS`
/// does: WebView2 exposes no accessibility tree here, so the wizard's controls
/// cannot be driven programmatically. Without this the one behaviour that matters
/// most on a first run - the install-and-open hand-off - is only reachable by a
/// human click, and `src-tauri/test/welcome-check.ps1` could not prove anything
/// below the window's existence.
///
/// Nothing sets it in production, and it is READ ONLY.
pub const WELCOME_ACTION_ENV_VAR: &str = "DSH_DOCK_WELCOME_ACTION";

/// How long the wizard is left on screen before the diagnostic answers it.
///
/// Long enough that the window is genuinely created, shown and painted first, so
/// the run exercises the same path a click would rather than racing construction.
/// The `Visible` event is the real synchronization point; this is the floor.
const WELCOME_ACTION_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

/// What [`WELCOME_ACTION_ENV_VAR`] asked for.
///
/// A trigger, never a second code path: both variants resolve to the same
/// [`submit_and_hand_off`] the button and the X use. If this ever grew its own
/// write-and-emit logic, the acceptance script would stop proving anything about
/// the real path - which is the entire reason it is shaped this way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoAction {
    /// Answer the wizard with this channel (a `SELECTABLE_CHANNELS` value).
    Submit(String),
    /// Dismiss the wizard, recording the default channel (section 3.9).
    Dismiss,
}

/// Parses the raw environment value, or `None` when it must be ignored.
///
/// PURE, so the fail-safe is testable without a window. The rule:
///
///   * unset, empty, or `0` -> `None`, i.e. the wizard behaves normally;
///   * one of the three selectable channels -> [`AutoAction::Submit`];
///   * `dismiss` (case-insensitive, trimmed) -> [`AutoAction::Dismiss`];
///   * ANYTHING ELSE -> `None`, and the caller logs the rejection.
///
/// WHY UNRECOGNISED INPUT IS IGNORED RATHER THAN AN ERROR: a stray exported
/// variable must never produce a wrong first run. Falling back to `rc` would write
/// a channel the user never chose; crashing would be worse. Leaving the wizard open
/// is the only outcome that cannot be wrong, because the user then answers it
/// themselves.
///
/// The value is NOT trimmed into the channel: `" rc "` is accepted as `rc` because
/// a trailing space from a shell is a fact of life, but the stored channel is
/// always the canonical token.
pub fn parse_auto_action(raw: Option<&str>) -> Option<AutoAction> {
    let value = raw?.trim();

    // `0` and empty mean "off", matching `dump_menu_plan_requested`'s convention
    // so the two diagnostics behave the same way.
    if value.is_empty() || value == "0" {
        return None;
    }

    if settings::is_selectable_channel(value) {
        // The canonical token, so `"rc"` is what gets written whatever the shell's
        // quoting did to the value.
        return Some(AutoAction::Submit(value.to_owned()));
    }

    if value.eq_ignore_ascii_case("dismiss") {
        return Some(AutoAction::Dismiss);
    }

    None
}

/// The message logged when [`parse_auto_action`] rejects a value.
///
/// Returned as data so the wording is asserted by a unit test and cannot drift
/// away from the valid values it names.
pub fn unrecognised_auto_action(value: &str) -> String {
    format!(
        "{WELCOME_ACTION_ENV_VAR}='{value}' not recognised; ignoring. Valid: {}, dismiss",
        settings::SELECTABLE_CHANNELS.join(", ")
    )
}

/// Answers the wizard after a delay, when [`WELCOME_ACTION_ENV_VAR`] asked for it.
///
/// A TIMER, not a subprocess: a plain thread that sleeps. It calls
/// [`submit_and_hand_off`] - the same function the button and the X call - so the
/// diagnostic cannot prove something the real paths do not do.
///
/// Never panics and never fails a caller: a diagnostic must not be able to take the
/// app down. An unrecognised value is logged and otherwise ignored, leaving the
/// wizard open exactly as if the variable were unset.
pub fn spawn_auto_submit_watcher<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let raw = std::env::var(WELCOME_ACTION_ENV_VAR).ok();
    let Some(action) = parse_auto_action(raw.as_deref()) else {
        if let Some(value) = raw.as_deref().map(str::trim).filter(|v| !v.is_empty() && *v != "0") {
            log_line(&format!("welcome: {}", unrecognised_auto_action(value)));
        }
        return;
    };

    // Only ever meaningful for a wizard that is on screen. Logged when it is not,
    // because "the diagnostic asked for something and nothing happened" is exactly
    // the kind of silence that wastes an afternoon.
    if !gate_decision(app.state::<SettingsState>().first_run_completed()).show_welcome {
        log_line(&format!(
            "welcome: {WELCOME_ACTION_ENV_VAR} is set but this is not a first run - ignoring"
        ));
        return;
    }

    log_line(&format!(
        "welcome: auto-submit ENABLED (diagnostic hook) - {action:?} in {}s",
        WELCOME_ACTION_DELAY.as_secs()
    ));

    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(WELCOME_ACTION_DELAY);

        // The wizard may have been answered by a human, or closed, while this
        // slept. Acting on a window that is gone would log a confusing failure and
        // could rewrite settings, so the window's existence is the precondition.
        if handle.get_webview_window(WELCOME_WINDOW_LABEL).is_none() {
            log_line("welcome: auto-submit skipped - the wizard window is already gone");
            return;
        }

        let requested = match &action {
            AutoAction::Submit(channel) => Some(channel.clone()),
            AutoAction::Dismiss => None,
        };
        let reason = match &action {
            AutoAction::Submit(_) => SubmitReason::Submitted,
            AutoAction::Dismiss => SubmitReason::Dismissed,
        };

        if let Err(error) = submit_and_hand_off(&handle, requested.as_deref(), reason) {
            log_line(&format!("welcome: auto-submit FAILED: {error}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_channel(channel: &str) -> settings::Settings {
        settings::Settings {
            auto_update_channel: channel.to_owned(),
            ..settings::Settings::default()
        }
    }

    // --- the options -------------------------------------------------------

    #[test]
    fn the_options_match_section_3_9_in_order() {
        let options = welcome_options();

        let shown: Vec<(&str, &str, bool)> = options
            .iter()
            .map(|option| (option.label, option.detail, option.disabled))
            .collect();

        assert_eq!(
            shown,
            vec![
                ("RC", "release candidates (recommended)", false),
                ("Alpha", "bleeding edge, changes often", false),
                ("All channels", "always newest", false),
                ("Stable", "not available yet", true),
            ]
        );
    }

    #[test]
    fn the_selectable_options_are_exactly_the_selectable_channels() {
        // The wizard and `settings.json` must agree on what a channel value is:
        // the wizard's radio VALUE is what `complete_first_run` validates.
        let selectable: Vec<&str> = welcome_options()
            .iter()
            .filter(|option| !option.disabled)
            .map(|option| option.channel)
            .collect();

        assert_eq!(selectable, settings::SELECTABLE_CHANNELS.to_vec());
    }

    #[test]
    fn every_option_value_is_a_channel_this_build_can_submit() {
        // `disabled` is the ONLY reason an option may not be submitted. A typo in
        // a channel string would otherwise become a radio button that fails on
        // click.
        for option in welcome_options() {
            assert_eq!(
                settings::is_selectable_channel(option.channel),
                !option.disabled,
                "{} has the wrong selectable/disabled pairing",
                option.label
            );
        }
    }

    #[test]
    fn all_channels_submits_the_policy_value_not_its_label() {
        // `all` is an update POLICY, not a registry channel (see
        // `settings::is_registry_channel`). Storing the label instead of the value
        // is the mistake this pins shut.
        let all = welcome_options()
            .into_iter()
            .find(|option| option.label == "All channels")
            .expect("the All channels option");

        assert_eq!(all.channel, "all");
        assert_ne!(all.channel, "all channels");
        assert!(!settings::is_registry_channel(all.channel));
    }

    #[test]
    fn the_stable_option_is_visible_but_disabled() {
        // Q48: the option stays on screen and explains itself rather than
        // disappearing. Its explanation is section 3.9's wording.
        let stable = welcome_options()
            .into_iter()
            .find(|option| option.channel == "stable")
            .expect("the Stable option");

        assert!(stable.disabled);
        assert_eq!(stable.detail, "not available yet");
        assert!(settings::validate_channel(stable.channel).is_err());
    }

    #[test]
    fn the_option_text_is_label_dash_detail() {
        let rc = welcome_options()[0];
        assert_eq!(rc.text(), "RC - release candidates (recommended)");
    }

    // --- the frontend cannot drift ----------------------------------------

    #[test]
    fn the_svelte_component_renders_every_option_value() {
        // The radio group lives in Svelte and the submittable values live here, so
        // a channel renamed on one side only would produce a button that a user can
        // press and the shell will refuse. Reading the source is a cheap way to
        // make that a build failure instead of a support report.
        let component = include_str!("../../src/lib/Welcome.svelte");

        for option in welcome_options() {
            assert!(
                component.contains(&format!("\"{}\"", option.channel)),
                "src/lib/Welcome.svelte does not render the {:?} option value",
                option.channel
            );
        }
    }

    #[test]
    fn the_dashboard_branches_on_the_wizard_label() {
        // `main.ts` mounts ONE component tree, so `App.svelte` is what decides
        // whether the dashboard or the wizard renders. That branch is load-bearing:
        // without it the dashboard's `onMount` would call `harness_status` from the
        // wizard window, where the capability grants only `welcome_submit` - the
        // exact failure the two-window design exists to prevent.
        let app = include_str!("../../src/App.svelte");

        assert!(
            app.contains(WELCOME_WINDOW_LABEL),
            "src/App.svelte no longer branches on the {WELCOME_WINDOW_LABEL} label"
        );
    }

    // --- pre-selection -----------------------------------------------------

    #[test]
    fn a_fresh_install_pre_selects_the_recommended_channel() {
        assert_eq!(preselected_channel(&settings::Settings::default()), "rc");
        assert_eq!(PRESELECTED_CHANNEL, "rc");
        // Section 3.9 calls RC "recommended"; section 3.11's default is the same
        // value, and this is the assertion that keeps them the same value.
        assert_eq!(PRESELECTED_CHANNEL, settings::DEFAULT_CHANNEL);
    }

    #[test]
    fn an_existing_choice_is_preserved_as_the_pre_selection() {
        for channel in settings::SELECTABLE_CHANNELS {
            assert_eq!(
                preselected_channel(&settings_with_channel(channel)),
                channel
            );
        }
    }

    #[test]
    fn an_unselectable_channel_falls_back_rather_than_pre_selecting_nothing() {
        // A hand-edited file (or a later phase's value) must not produce a wizard
        // with no valid button selected.
        assert_eq!(preselected_channel(&settings_with_channel("beta")), "rc");
        assert_eq!(preselected_channel(&settings_with_channel("stable")), "rc");
        assert_eq!(preselected_channel(&settings_with_channel("")), "rc");
    }

    // --- the gate ----------------------------------------------------------

    #[test]
    fn a_fresh_install_hides_the_dashboard_and_shows_the_wizard() {
        let decision = gate_decision(false);

        assert!(decision.show_welcome);
        assert!(decision.hide_main);
    }

    #[test]
    fn a_completed_first_run_touches_neither_window() {
        let decision = gate_decision(true);

        assert!(!decision.show_welcome);
        assert!(!decision.hide_main);
    }

    #[test]
    fn the_gate_never_hides_the_dashboard_without_showing_the_wizard() {
        // The invariant that matters: hiding `main` without creating the wizard
        // would leave the user with no window at all, on a first run, with no way
        // to recover. Both flags are always equal; this is where that is enforced.
        for completed in [false, true] {
            let decision = gate_decision(completed);
            assert_eq!(
                decision.show_welcome, decision.hide_main,
                "the gate disagreed with itself for first_run_completed={completed}"
            );
        }
    }

    // --- the query parameter ----------------------------------------------

    #[test]
    fn the_wizard_url_carries_the_pre_selection() {
        assert_eq!(welcome_url("rc"), "index.html?preselect=rc");
        assert_eq!(welcome_url("alpha"), "index.html?preselect=alpha");
    }

    #[test]
    fn the_url_round_trips_through_the_parser() {
        for channel in settings::SELECTABLE_CHANNELS {
            let url = welcome_url(channel);
            let query = url
                .split_once('?')
                .map(|(_, query)| query)
                .unwrap_or_default();

            assert_eq!(
                channel_from_query(query).as_deref(),
                Some(channel),
                "{channel} did not survive the round trip"
            );
        }

        // The leading `?` is optional, so a caller with either form works.
        assert_eq!(channel_from_query("?preselect=all").as_deref(), Some("all"));
    }

    #[test]
    fn a_malformed_or_unknown_pre_selection_is_ignored() {
        // Anything the build cannot submit resolves to "no preference" rather than
        // to a radio button whose value would be refused on submit.
        for query in [
            "",
            "?",
            "?other=rc",
            "?preselect=",
            "?preselect=beta",
            "?preselect=stable",
            "?preselect=RC",
        ] {
            assert_eq!(channel_from_query(query), None, "accepted {query:?}");
        }
    }

    #[test]
    fn the_parser_does_not_confuse_a_substring_key() {
        assert_eq!(channel_from_query("?preselectx=alpha"), None);
        assert_eq!(channel_from_query("?xpreselect=alpha"), None);
    }

    // --- resolving what to record -----------------------------------------

    #[test]
    fn a_dismissal_records_the_default_channel() {
        // Section 3.9: closing without choosing defaults to `rc` and proceeds.
        assert_eq!(
            resolve_channel(None).expect("a channel"),
            PRESELECTED_CHANNEL
        );
        assert_eq!(resolve_channel(None).expect("a channel"), "rc");
    }

    #[test]
    fn every_selectable_channel_resolves_and_nothing_else_does() {
        for channel in settings::SELECTABLE_CHANNELS {
            assert_eq!(resolve_channel(Some(channel)).expect("valid"), channel);
        }

        for channel in ["stable", "beta", "", "RC", "all channels"] {
            let error = resolve_channel(Some(channel)).expect_err("must be refused");
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn the_stable_option_is_refused_with_the_shared_reason() {
        // One message, from `settings.rs`: the wizard must not invent its own
        // explanation for why Stable is unavailable.
        let error = resolve_channel(Some("stable")).expect_err("stable is refused");
        assert!(error.contains("stable channel has no release"), "{error}");
    }

    // --- the payload -------------------------------------------------------

    #[test]
    fn the_payload_is_the_contract_the_dashboard_reads() {
        // `App.svelte` reads `payload.channel` and `payload.dismissed`.
        let submitted =
            serde_json::to_value(InstallAndOpenPayload::new("alpha", SubmitReason::Submitted))
                .expect("serialises");
        assert_eq!(
            submitted,
            serde_json::json!({ "channel": "alpha", "dismissed": false })
        );

        let dismissed =
            serde_json::to_value(InstallAndOpenPayload::new("rc", SubmitReason::Dismissed))
                .expect("serialises");
        assert_eq!(
            dismissed,
            serde_json::json!({ "channel": "rc", "dismissed": true })
        );
    }

    #[test]
    fn the_submit_reason_tokens_are_stable() {
        assert_eq!(SubmitReason::Submitted.as_str(), "submitted");
        assert_eq!(SubmitReason::Dismissed.as_str(), "dismissed");
    }

    #[test]
    fn the_window_and_event_names_are_contract() {
        // The label is what `capabilities/welcome.json` scopes to and what
        // `App.svelte` branches on; the event name is what the dashboard listens
        // for. Renaming either silently would break the wizard without a compile
        // error anywhere.
        assert_eq!(WELCOME_WINDOW_LABEL, "welcome");
        assert_eq!(EVENT_INSTALL_AND_OPEN, "install-and-open");
        assert_eq!(WELCOME_TITLE, "Welcome to DSH-Dock");
        assert_eq!(WELCOME_INNER_SIZE, (500.0, 300.0));
    }

    #[test]
    fn the_wizard_is_destroyed_and_never_closed() {
        // REGRESSION TEST for the infinite close loop. `close()` emits
        // `CloseRequested`, the handler vetoes it to make the X a dismissal, and
        // answering a vetoed close with another `close()` is a loop inside the event
        // loop - it hung the wizard on screen and filled launcher.log with thousands
        // of lines in one second. `destroy()` emits nothing, which is the property
        // this pins.
        //
        // The enum has one variant today; the assertion is here for the day someone
        // adds a second one, so that the choice is made deliberately and fails a
        // test rather than reverting to `close()` by habit.
        assert_eq!(window_operation(), WindowOperation::Destroy);

        // And the reason it cannot be `close()`, stated where the decision is.
        let source = include_str!("welcome.rs");
        assert!(
            source.contains("does NOT emit any events"),
            "the WindowOperation documentation no longer records why destroy is required"
        );
    }

    // --- the diagnostic auto-submit ----------------------------------------

    #[test]
    fn every_selectable_channel_parses_as_a_submit() {
        for channel in settings::SELECTABLE_CHANNELS {
            assert_eq!(
                parse_auto_action(Some(channel)),
                Some(AutoAction::Submit(channel.to_owned())),
                "{channel} must be accepted"
            );
        }
    }

    #[test]
    fn dismiss_parses_as_a_dismissal_whatever_its_case() {
        for value in ["dismiss", "DISMISS", "Dismiss", "  dismiss  "] {
            assert_eq!(
                parse_auto_action(Some(value)),
                Some(AutoAction::Dismiss),
                "{value:?} must be accepted"
            );
        }
    }

    #[test]
    fn unset_empty_and_zero_mean_off() {
        // The same convention `dump_menu_plan_requested` uses, so both diagnostics
        // behave identically.
        assert_eq!(parse_auto_action(None), None);
        assert_eq!(parse_auto_action(Some("")), None);
        assert_eq!(parse_auto_action(Some("   ")), None);
        assert_eq!(parse_auto_action(Some("0")), None);
    }

    #[test]
    fn unrecognised_input_is_ignored_rather_than_guessed_at() {
        // CONSTRAINT: a stray exported variable must never produce a wrong first
        // run. Falling back to `rc` would write a channel the user never chose, so
        // every one of these must leave the wizard open.
        for value in [
            "xyz",
            "stable",
            "beta",
            "RC",
            "ALPHA",
            "all channels",
            "latest",
            "1",
            "true",
            "dismissed",
            "rc;alpha",
            "rc alpha",
        ] {
            assert_eq!(
                parse_auto_action(Some(value)),
                None,
                "{value:?} must be ignored, not guessed at"
            );
        }
    }

    #[test]
    fn a_shell_quoted_value_is_trimmed_but_the_channel_is_canonical() {
        // A trailing space from a shell is a fact of life; what gets WRITTEN must
        // still be the token `validate_channel` accepts.
        assert_eq!(
            parse_auto_action(Some(" rc ")),
            Some(AutoAction::Submit("rc".to_owned()))
        );
        assert_eq!(
            parse_auto_action(Some("\talpha\n")),
            Some(AutoAction::Submit("alpha".to_owned()))
        );
    }

    #[test]
    fn the_rejection_message_names_the_variable_the_value_and_every_valid_input() {
        let message = unrecognised_auto_action("xyz");

        assert!(message.contains("DSH_DOCK_WELCOME_ACTION"), "{message}");
        assert!(message.contains("xyz"), "{message}");
        assert!(message.contains("not recognised; ignoring"), "{message}");
        for valid in ["rc", "alpha", "all", "dismiss"] {
            assert!(message.contains(valid), "{message} does not name {valid}");
        }
    }

    #[test]
    fn every_value_the_diagnostic_accepts_can_actually_be_submitted() {
        // The end-to-end property: whatever the diagnostic triggers must be a call
        // the real path would also accept. A value that parsed here but was refused
        // by `submit_and_hand_off` would make the acceptance run fail for a reason
        // that has nothing to do with the wizard.
        for channel in settings::SELECTABLE_CHANNELS {
            let action = parse_auto_action(Some(channel)).expect("parses");
            let AutoAction::Submit(channel) = action else {
                panic!("{channel} must parse as a submit");
            };
            assert!(resolve_channel(Some(&channel)).is_ok());
        }

        // And a dismissal resolves to a channel too.
        assert!(resolve_channel(None).is_ok());
    }
}
