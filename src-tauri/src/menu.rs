//! The native menu bar's structure, as data.
//!
//! Sections 2.7, 2.8, 3.8 and 5.1 of `docs/PROJECT_DSH-DOCK.md`. This module has
//! two halves:
//!
//!   * [`menu_plan`] - PURE. It reads a [`MenuState`] snapshot and a target OS,
//!     and returns a [`MenuPlan`]: a plain, serialisable description of the whole
//!     menu tree. No Tauri types, no window, no side effects.
//!   * the native adapter (`build_menu` / `rebuild_menu`, added in the next
//!     pause) - it turns a `MenuPlan` into a real `Menu` and installs it. It
//!     makes no decisions of its own.
//!
//! WHY THE SPLIT. Tauri's `MenuBuilder` needs a `Manager` and hops to the main
//! thread, so a "pure builder" cannot exist literally. Splitting the decision
//! (pure, unit-testable on any host, dumpable as JSON) from the construction
//! (thin, only exercisable in a running app) is what makes section 7.4's "unit
//! tests can verify the menu structure" achievable - and it is the same
//! pure-core/thin-adapter pattern as `resolve_sidecar_from` in `lib.rs`.
//!
//! WHY THE TARGET OS IS A PARAMETER. Section 2.8 claims the same menu works on
//! all three platforms. Two things break that claim: macOS renders the FIRST
//! submenu as the application menu (so an app menu must lead the tree there, and
//! About/Settings belong inside it), and Windows/Linux have no such notion. The
//! tree is therefore platform-SHAPED from one content definition, and taking the
//! OS as an argument means the macOS shape is asserted on Windows.
//!
//! WHAT THIS MODULE MUST NEVER DO
//!
//!   * It must not put anything from the harness status URL into the plan. That
//!     URL carries the harness's signed token; `MenuState` deliberately has no
//!     url field, and a test asserts the dumped plan contains no `token=`.
//!   * It must not invent menu content. Every item below traces to section 3.8
//!     or to a logged decision (Q45-Q55); placeholders that are not wired yet
//!     say so in their own label or are disabled, rather than silently doing
//!     nothing.

use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use tauri::menu::{
    AboutMetadata, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::{
    self, is_registry_channel, Settings, SettingsState, AUTO_UPDATE_OPTIONS, DEFAULT_CHANNEL,
};
use crate::{log_line, ProxiedResponse, SidecarState, MAIN_WINDOW_LABEL};

#[cfg(windows)]
use crate::CREATE_NO_WINDOW;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// The bullet that prefixes every status label (section 3.8).
const STATUS_BULLET: char = '●';

/// The middle dot that separates the status from the version (section 3.8).
const STATUS_VERSION_SEPARATOR: char = '·';

// --- Stable menu item ids ---------------------------------------------------
//
// These strings are contract: a click arrives back as an id, and
// [`MenuAction::from_id`] turns it into the action. Keeping them in one place
// means a typo shows up as a failing round-trip test rather than a dead menu
// item.

/// `Restart Harness`.
pub const ID_HARNESS_RESTART: &str = "harness.restart";
/// The status line. Never clicked (it is disabled), but named so the installed
/// item can be found again for an in-place text update.
pub const ID_HARNESS_STATUS: &str = "harness.status";
/// `Stop Harness`.
pub const ID_HARNESS_STOP: &str = "harness.stop";
/// `Open Logs Folder`.
pub const ID_HARNESS_OPEN_LOGS: &str = "harness.openLogs";
/// Prefix of the four `Auto-update` check items; the channel follows.
pub const ID_HARNESS_AUTO_UPDATE_PREFIX: &str = "harness.autoupdate.";
/// Prefix of the `Recent Versions` switch items; the version follows.
pub const ID_HARNESS_RECENT_PREFIX: &str = "harness.recent.";
/// `Show all versions…`.
pub const ID_HARNESS_SHOW_ALL_VERSIONS: &str = "harness.showAllVersions";
/// `Harness Update`.
pub const ID_HARNESS_UPDATE: &str = "harness.update";
/// `Dock Update`.
pub const ID_DOCK_UPDATE: &str = "dock.update";
/// `Show Control Panel`.
pub const ID_DOCK_CONTROL_PANEL: &str = "dock.controlPanel";
/// `Settings…`.
pub const ID_SETTINGS_OPEN: &str = "settings.open";

// --- Labels -----------------------------------------------------------------

const LABEL_HARNESS: &str = "Harness";
const LABEL_DOCK: &str = "Dock";
const LABEL_SETTINGS: &str = "Settings";
const LABEL_SETTINGS_ITEM: &str = "Settings…";
const LABEL_APP_MENU: &str = "DSH-Dock";
const LABEL_AUTO_UPDATE: &str = "Auto-update";
const LABEL_RECENT_VERSIONS: &str = "Recent Versions";
const LABEL_RESTART: &str = "Restart Harness";
const LABEL_STOP: &str = "Stop Harness";
const LABEL_OPEN_LOGS: &str = "Open Logs Folder";
const LABEL_HARNESS_UPDATE: &str = "Harness Update";
const LABEL_DOCK_UPDATE: &str = "Dock Update";
const LABEL_SHOW_CONTROL_PANEL: &str = "Show Control Panel";
const LABEL_ABOUT: &str = "About DSH-Dock";
const LABEL_HIDE: &str = "Hide DSH-Dock";
const LABEL_HIDE_OTHERS: &str = "Hide Others";
const LABEL_SHOW_ALL: &str = "Show All";
const LABEL_QUIT: &str = "Quit DSH-Dock";
const LABEL_CURRENT_VERSION_PREFIX: &str = "Current version: ";

/// Label of the version-manager entry.
///
/// The `(Phase 2)` suffix is gone in 2B, because the entry now opens a manager. A
/// disabled menu item cannot carry a tooltip, so the label has to say what it is;
/// the reason for a DISABLED state has to live in the label too, which is why the
/// older wording spelled the phase out.
const LABEL_SHOW_ALL_VERSIONS: &str = "Show all versions…";

/// Whether the version-manager entry is clickable.
///
/// PHASE 2B: flipped to `true`. The version manager exists (the dashboard's version
/// section and `/versions/status` behind it), so this entry now opens something. It
/// is still a menu-to-dashboard intent - the shell has no notion of a version
/// section, so when Phase 3 adds real tabs only the dashboard's routing changes.
const SHOW_ALL_VERSIONS_ENABLED: bool = true;

/// How many recent versions the submenu shows (section 3.8, Q49).
const RECENT_VERSIONS_LIMIT: usize = 5;

/// Which channels currently have a release on the registry.
///
/// PHASE 2 OWNER: replaced by the real probe (a `/registry/channels` route on
/// the sidecar). Verified 2026-09-10: `latest` points at a release candidate, so
/// no stable release exists; `next` (rc) and `alpha` both do.
///
/// `all` is deliberately absent: it is an update POLICY, not a channel. See
/// `settings::is_registry_channel`.
pub const AVAILABLE_CHANNELS: [&str; 2] = ["rc", "alpha"];

/// The platform whose menu shape should be produced.
///
/// Values follow `std::env::consts::OS`, with the same naming the sidecar's
/// `defaultDataDirFor` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetOs {
    /// Window-frame menu bar.
    Windows,
    /// Global menu bar, with an application menu as the first submenu.
    MacOs,
    /// Window-frame menu bar.
    Linux,
}

impl TargetOs {
    /// Every platform, in the order the dump reports them.
    pub const ALL: [TargetOs; 3] = [TargetOs::Windows, TargetOs::MacOs, TargetOs::Linux];

    /// Maps an OS name onto a menu shape.
    ///
    /// Anything that is neither Windows nor macOS gets the in-window menu bar,
    /// which is what section 2.9 assumes for the other Unix platforms.
    pub fn from_name(name: &str) -> Self {
        match name {
            "windows" | "win32" => Self::Windows,
            "macos" | "darwin" => Self::MacOs,
            _ => Self::Linux,
        }
    }

    /// The host's shape.
    pub fn current() -> Self {
        Self::from_name(std::env::consts::OS)
    }

    /// The canonical name, as it appears in the dump.
    pub fn as_name(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::MacOs => "macos",
            Self::Linux => "linux",
        }
    }
}

/// Observable harness lifecycle, mirroring `sidecar/lib/control.js`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessStatus {
    /// No harness is recorded.
    Stopped,
    /// A start is in flight.
    Starting,
    /// Recorded and answering.
    Running,
    /// Recorded but not answering, or the last start failed.
    Error,
    /// The sidecar has not reported anything yet.
    ///
    /// Distinct from [`HarnessStatus::Stopped`] so the shell can be honest about
    /// what it knows, while the LABEL stays `● Stopped` - see [`status_label`].
    Unavailable,
}

/// Everything the menu shows, captured at one moment.
///
/// Deliberately small and cheap to clone: a state change means a full menu
/// rebuild (section 2.7), so this is built and compared often. It carries NO
/// harness URL - that value holds the harness token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// Lifecycle state reported by the sidecar.
    pub harness_status: HarnessStatus,
    /// Version of the running harness, when known.
    pub harness_version: Option<String>,
    /// Process id of the running harness, when known.
    ///
    /// Not shown in the menu itself; the shell records it in the rebuild log line
    /// so a report can be tied to a specific process.
    pub harness_pid: Option<u32>,
    /// This launcher's own version.
    pub dsh_dock_version: String,
    /// The channel auto-update tracks (section 3.2).
    pub auto_update_channel: String,
    /// Which registry channels currently have a release.
    pub available_channels: Vec<String>,
    /// Known harness versions, newest-first, for the `Recent Versions` submenu.
    ///
    /// EMPTY until the sidecar reports a library (Phase 2B). The plan caps what it
    /// SHOWS at [`RECENT_VERSIONS_LIMIT`]; the list itself is the whole library,
    /// because "Show all versions…" must open a manager that holds every version
    /// rather than only the ones the submenu happened to display.
    pub recent_versions: Vec<RecentVersion>,
    /// The version currently installed/active, marked `(installed)` when it
    /// appears in `recent_versions`.
    pub installed_version: Option<String>,
    /// The sidecar's last error, when the status is `error`.
    ///
    /// NOT rendered in the menu: section 3.8 fixes the status label set to four
    /// values, and native menus have no tooltips. It exists so the shell can put
    /// the real cause in the launcher log instead of leaving "● Error" bare.
    pub last_error: Option<String>,
}

impl Default for MenuState {
    fn default() -> Self {
        Self {
            // Nothing has been heard from the sidecar yet, which is not the same
            // as "the harness is stopped".
            harness_status: HarnessStatus::Unavailable,
            harness_version: None,
            harness_pid: None,
            dsh_dock_version: env!("CARGO_PKG_VERSION").to_owned(),
            auto_update_channel: DEFAULT_CHANNEL.to_owned(),
            available_channels: AVAILABLE_CHANNELS.iter().map(|c| (*c).to_owned()).collect(),
            recent_versions: Vec::new(),
            installed_version: None,
            last_error: None,
        }
    }
}

impl MenuState {
    /// A menu state whose channel comes from the settings file, with nothing
    /// heard from the sidecar yet.
    ///
    /// Availability is deliberately NOT taken from the settings: `available_channels`
    /// is registry knowledge (Phase 2's probe), not a user preference.
    pub fn from_settings(settings: &crate::settings::Settings) -> Self {
        Self {
            auto_update_channel: settings.auto_update_channel.clone(),
            ..Self::default()
        }
    }
}

/// One installed version, as the menu shows it (section 3.8, Q49).
///
/// The submenu renders the version string; `installed_at` is carried because the
/// catalogue knows it and the Phase 3 version table will want it, but it is
/// deliberately NOT part of the change comparison below - see [`update_library`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVersion {
    /// The exact version, e.g. `0.2.0-rc.2`.
    pub version: String,
    /// When it was installed, from the advisory catalogue. `None` for a version
    /// the catalogue does not know about.
    pub installed_at: Option<String>,
}

impl RecentVersion {
    /// A version with no recorded install date.
    ///
    /// Exists so the scenario fixtures and tests read as `RecentVersion::bare("1.2.3")`
    /// rather than a struct literal repeated twenty times.
    pub fn bare(version: &str) -> Self {
        Self {
            version: version.to_owned(),
            installed_at: None,
        }
    }
}

/// The harness facts the menu renders, read from the control surface.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessSnapshot {
    /// Lifecycle state.
    pub status: HarnessStatus,
    /// Running version, when known.
    pub version: Option<String>,
    /// Running process id, when known.
    pub pid: Option<u32>,
    /// The sidecar's last error, when it reported one.
    pub last_error: Option<String>,
    /// Every installed version, newest-first, from the status payload.
    ///
    /// CARRIED ON THE SNAPSHOT rather than fetched separately, because the payload
    /// the 5s watcher already reads is where the sidecar puts it: one HTTP call
    /// serves both the status label and the version list, so the two can never
    /// describe different points in time.
    pub recent_versions: Vec<RecentVersion>,
}

/// A snapshot for "the sidecar could not be asked".
///
/// A recorded shell error means something is genuinely wrong and the menu says
/// `error`; no error at all means we simply have not heard yet, which the plan
/// renders as `stopped` (see [`status_label`]).
pub fn snapshot_unavailable(shell_error: Option<&str>) -> HarnessSnapshot {
    match shell_error {
        Some(error) if !error.trim().is_empty() => HarnessSnapshot {
            status: HarnessStatus::Error,
            version: None,
            pid: None,
            last_error: Some(error.to_owned()),
            recent_versions: Vec::new(),
        },
        _ => HarnessSnapshot {
            status: HarnessStatus::Unavailable,
            version: None,
            pid: None,
            last_error: None,
            recent_versions: Vec::new(),
        },
    }
}

/// Reads a snapshot out of a `/harness/status` payload.
///
/// Pure, so every mapping is unit-testable. Anything unrecognised becomes
/// [`HarnessStatus::Unavailable`] rather than a guess: a menu that invents a
/// state is worse than one that admits it does not know.
pub fn snapshot_from_status_payload(payload: &serde_json::Value) -> HarnessSnapshot {
    let status = match payload.get("status").and_then(|value| value.as_str()) {
        Some("running") => HarnessStatus::Running,
        Some("starting") => HarnessStatus::Starting,
        Some("stopped") => HarnessStatus::Stopped,
        Some("error") => HarnessStatus::Error,
        _ => HarnessStatus::Unavailable,
    };

    // An empty version string is the same as no version: the label would
    // otherwise read "● Running · v".
    let version = payload
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    // The sidecar sends a JSON number; anything else (including a negative or
    // oversized value) is treated as unknown rather than truncated silently.
    let pid = payload
        .get("pid")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);

    let last_error = payload
        .get("lastError")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        // The message is the fallback cause when no explicit error is set.
        .or_else(|| {
            payload
                .get("message")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        });

    // Every installed version, newest-first. Tolerant on purpose: a missing,
    // non-array, or malformed `recentVersions` yields an EMPTY list rather than
    // discarding the snapshot, because the status label is the menu's primary
    // information and a bad version list must not cost the user that as well.
    //
    // An entry with no usable `version` string is dropped: a menu item built from a
    // missing version would read `v` and, worse, would carry an id the click handler
    // could not match back to anything.
    let recent_versions = payload
        .get("recentVersions")
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let version = entry
                        .get("version")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    Some(RecentVersion {
                        version: version.to_owned(),
                        installed_at: entry
                            .get("installedAt")
                            .and_then(|value| value.as_str())
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    HarnessSnapshot {
        status,
        version,
        pid,
        last_error,
        recent_versions,
    }
}

/// Which control-panel tab an [`MenuAction::OpenControlPanel`] should reveal.
///
/// The hint travels with the action and with the `panel:open` event, so the
/// frontend never has to guess which entry was clicked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelTab {
    /// The dashboard / harness view.
    Harness,
    /// The Settings tab.
    Settings,
    /// The version manager (Phase 2/3).
    Versions,
}

impl PanelTab {
    /// The string carried in `panel:open` and shown in the dump.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Harness => "harness",
            Self::Settings => "settings",
            Self::Versions => "versions",
        }
    }
}

/// What a click on a menu item should do.
///
/// Serialised as `"restartHarness"` for unit variants and
/// `{"setAutoUpdateChannel":"rc"}` for the ones carrying data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MenuAction {
    /// Proxy `POST /harness/restart`.
    RestartHarness,
    /// Proxy `POST /harness/stop`.
    StopHarness,
    /// Open `<data-dir>/logs` in the OS file manager.
    OpenLogsFolder,
    /// Persist a new `auto_update_channel`.
    SetAutoUpdateChannel(String),
    /// Switch the active harness version.
    ///
    /// THE ONE ACTION THAT DOES NOT ROUTE THROUGH THE DASHBOARD (Q74). It is
    /// dispatched straight to the sidecar on a worker thread, because a switch is a
    /// stop and a boot - seconds to minutes - and must not depend on the dashboard
    /// window being open. See `switch_version` for the thread boundary.
    SwitchVersion(String),
    /// Focus the control panel, revealing `tab`.
    OpenControlPanel {
        /// Which tab to reveal.
        tab: PanelTab,
    },
    /// Check for a harness update now (Phase 2).
    HarnessUpdate,
    /// Check for a launcher update (Phase 3).
    DockUpdate,
}

impl MenuAction {
    /// The stable id this action is dispatched by.
    pub fn id(&self) -> String {
        match self {
            Self::RestartHarness => ID_HARNESS_RESTART.to_owned(),
            Self::StopHarness => ID_HARNESS_STOP.to_owned(),
            Self::OpenLogsFolder => ID_HARNESS_OPEN_LOGS.to_owned(),
            Self::SetAutoUpdateChannel(channel) => {
                format!("{ID_HARNESS_AUTO_UPDATE_PREFIX}{channel}")
            }
            Self::SwitchVersion(version) => format!("{ID_HARNESS_RECENT_PREFIX}{version}"),
            // Each id implies its tab: `settings.open` is the Settings entry,
            // `dock.controlPanel` is the plain control-panel entry, and
            // `harness.showAllVersions` is the version manager.
            Self::OpenControlPanel { tab: PanelTab::Settings } => ID_SETTINGS_OPEN.to_owned(),
            Self::OpenControlPanel { tab: PanelTab::Versions } => {
                ID_HARNESS_SHOW_ALL_VERSIONS.to_owned()
            }
            Self::OpenControlPanel { .. } => ID_DOCK_CONTROL_PANEL.to_owned(),
            Self::HarnessUpdate => ID_HARNESS_UPDATE.to_owned(),
            Self::DockUpdate => ID_DOCK_UPDATE.to_owned(),
        }
    }

    /// The tab this action would reveal, when it opens the control panel.
    pub fn panel_tab(&self) -> Option<PanelTab> {
        match self {
            Self::OpenControlPanel { tab } => Some(*tab),
            _ => None,
        }
    }

    /// True when handling this action performs I/O.
    ///
    /// THE MAIN THREAD RULE (Step C, R1): menu events are delivered on the main
    /// thread, which is also the thread that pumps both webviews, so an action
    /// that writes a file or spawns a process MUST run on a worker thread.
    ///
    /// Since Phase 2B (Q99) every harness action dispatches sidecar-side, so FIVE
    /// actions now reach outside this process: the three harness actions (each an HTTP
    /// call to the sidecar), opening the logs folder (a process spawn), and writing
    /// `settings.json`. Only `OpenControlPanel` and the two notice-only placeholders are
    /// main-thread work by construction.
    ///
    /// This is documentation and a test seam; the dispatcher's safety comes from
    /// its match arms, not from this method being consulted at runtime.
    pub fn needs_worker(&self) -> bool {
        match self {
            // Process spawn / disk write / HTTP to the sidecar.
            Self::OpenLogsFolder
            | Self::SetAutoUpdateChannel(_)
            | Self::RestartHarness
            | Self::StopHarness
            | Self::SwitchVersion(_) => true,

            // Event emission and window management only.
            Self::HarnessUpdate | Self::DockUpdate | Self::OpenControlPanel { .. } => false,
        }
    }

    /// Parses a menu event id back into an action.
    ///
    /// `None` means "not ours": an OS predefined item's id, or a string that
    /// merely looks like one of ours. The parameterised forms are validated
    /// rather than trusted, so a stray id cannot become a channel or a version.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            ID_HARNESS_RESTART => Some(Self::RestartHarness),
            ID_HARNESS_STOP => Some(Self::StopHarness),
            ID_HARNESS_OPEN_LOGS => Some(Self::OpenLogsFolder),
            ID_HARNESS_SHOW_ALL_VERSIONS => Some(Self::OpenControlPanel { tab: PanelTab::Versions }),
            ID_HARNESS_UPDATE => Some(Self::HarnessUpdate),
            ID_DOCK_UPDATE => Some(Self::DockUpdate),
            ID_DOCK_CONTROL_PANEL => Some(Self::OpenControlPanel { tab: PanelTab::Harness }),
            ID_SETTINGS_OPEN => Some(Self::OpenControlPanel { tab: PanelTab::Settings }),

            other => {
                if let Some(channel) = other.strip_prefix(ID_HARNESS_AUTO_UPDATE_PREFIX) {
                    return AUTO_UPDATE_OPTIONS
                        .contains(&channel)
                        .then(|| Self::SetAutoUpdateChannel(channel.to_owned()));
                }

                let version = other.strip_prefix(ID_HARNESS_RECENT_PREFIX)?;
                // VALIDATED, NOT JUST NON-EMPTY. `../../evil` is a non-empty suffix of
                // our prefix, so the empty check alone accepted it as a version - and
                // `switch_version` would then have had to refuse it (it does, through
                // the same predicate below). Refusing here as well means the parser and
                // the dispatcher cannot disagree about what a version is, and a stray
                // id becomes "not ours" rather than "ours but nonsense".
                //
                // The build metadata case (`1.2.3-rc.1+build.5`) is why this cannot be
                // a simple character check: the grammar has two optional suffixes, and
                // `is_switchable_version` implements it in one place.
                if !is_switchable_version(version) {
                    return None;
                }
                Some(Self::SwitchVersion(version.to_owned()))
            }
        }
    }
}

/// An OS-provided menu item.
///
/// These carry no action of ours: the OS owns their behaviour and their ids, so
/// the dispatcher never sees them. Section 2.8 lists them as the way to get
/// native About/Quit/Hide rather than reimplementing them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredefinedName {
    /// The native About panel.
    About,
    /// Hide the application (macOS).
    Hide,
    /// Hide every other application (macOS).
    HideOthers,
    /// Show every hidden application (macOS).
    ShowAll,
    /// Quit the application (macOS).
    Quit,
}

/// One node of the menu tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlanNode {
    /// A clickable item that dispatches [`MenuAction`].
    Action {
        /// Dispatch id.
        id: String,
        /// Menu label.
        label: String,
        /// What the click means.
        action: MenuAction,
        /// Whether it is clickable.
        enabled: bool,
    },
    /// A check item (the auto-update options).
    Check {
        /// Dispatch id.
        id: String,
        /// Menu label.
        label: String,
        /// What a click means.
        action: MenuAction,
        /// Whether it is ticked.
        checked: bool,
        /// Whether it is clickable.
        enabled: bool,
    },
    /// A disabled informational line (versions, or the launcher's own version).
    Label {
        /// The text shown.
        label: String,
    },
    /// The harness status line.
    ///
    /// A disabled label like the others, but it gets its own variant and a stable
    /// id because it is the ONE item whose text changes while the menu's structure
    /// does not. That is what lets `rebuild_menu` update it in place instead of
    /// rebuilding the whole menu - a full rebuild measured ~23 ms median on a
    /// release build, against section 7.4's 5 ms target, while one
    /// `SetMenuItemInfoW` plus one `DrawMenuBar` is well under a millisecond.
    StatusLabel {
        /// Stable id, so the installed item can be found again by name.
        id: String,
        /// The text shown.
        label: String,
    },
    /// A horizontal separator.
    Separator,
    /// A nested menu.
    Submenu {
        /// Menu label.
        label: String,
        /// Children, in display order.
        items: Vec<PlanNode>,
    },
    /// A predefined OS item.
    Predefined {
        /// Which OS item.
        name: PredefinedName,
        /// Menu label.
        label: String,
    },
}

/// A complete menu bar, as data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuPlan {
    /// The platform shape this plan was produced for.
    pub target_os: TargetOs,
    /// Top-level menus, in display order.
    pub top_level: Vec<PlanNode>,
}

/// The status label for `state` (section 3.8).
///
/// The four documented values are `● Running · v…`, `● Stopped`, `● Starting…`
/// and `● Error`.
///
/// [`HarnessStatus::Unavailable`] - no sidecar port yet and no recorded error -
/// maps to `● Stopped` deliberately: the port normally arrives in well under a
/// second, and a menu that flashes red on every cold start is a false alarm. A
/// real shell failure is reported as [`HarnessStatus::Error`] by the caller, so
/// that case still surfaces.
pub fn status_label(state: &MenuState) -> String {
    match state.harness_status {
        HarnessStatus::Running => match state.harness_version.as_deref() {
            Some(version) if !version.is_empty() => format!(
                "{STATUS_BULLET} Running {STATUS_VERSION_SEPARATOR} v{version}"
            ),
            // The sidecar can report `running` before it knows the version.
            _ => format!("{STATUS_BULLET} Running"),
        },
        HarnessStatus::Starting => format!("{STATUS_BULLET} Starting…"),
        HarnessStatus::Error => format!("{STATUS_BULLET} Error"),
        HarnessStatus::Stopped | HarnessStatus::Unavailable => {
            format!("{STATUS_BULLET} Stopped")
        }
    }
}

/// The `Auto-update` submenu (section 3.2, Q47, Q48).
///
/// One option is always active; `Stable only` stays visible and disabled while
/// no stable release exists; `All channels` is always enabled because it means
/// "whichever channel is newest" and needs no single channel to exist.
fn auto_update_submenu(state: &MenuState) -> PlanNode {
    let items = AUTO_UPDATE_OPTIONS
        .iter()
        .map(|channel| {
            let is_policy = !is_registry_channel(channel);
            PlanNode::Check {
                id: format!("{ID_HARNESS_AUTO_UPDATE_PREFIX}{channel}"),
                label: auto_update_label(channel).to_owned(),
                action: MenuAction::SetAutoUpdateChannel((*channel).to_owned()),
                checked: state.auto_update_channel == *channel,
                enabled: is_policy
                    || state.available_channels.iter().any(|known| known == channel),
            }
        })
        .collect();

    PlanNode::Submenu {
        label: LABEL_AUTO_UPDATE.to_owned(),
        items,
    }
}

/// The label for one auto-update option (section 3.2's table, section 3.8).
fn auto_update_label(channel: &str) -> &'static str {
    match channel {
        "stable" => "Stable only",
        "rc" => "RC only",
        "alpha" => "Alpha only",
        // `all` and any future option.
        _ => "All channels (newest)",
    }
}

/// The `Recent Versions` submenu (section 3.8, Q49).
///
/// `state.recent_versions` is the WHOLE library, newest-first; the cap lives here so
/// no caller has to know it. The list is deliberately longer than what is shown:
/// "Show all versions…" below must open a manager holding every version.
fn recent_versions_submenu(state: &MenuState) -> PlanNode {
    let mut items: Vec<PlanNode> = Vec::new();

    for entry in state.recent_versions.iter().take(RECENT_VERSIONS_LIMIT) {
        if Some(&entry.version) == state.installed_version.as_ref() {
            // THE RUNNING VERSION IS MARKED, AND NOT CLICKABLE (Q100).
            //
            // A native CHECK MARK rather than a bullet prefix, so the mark looks like a
            // mark on every platform instead of like part of the version string - and so
            // it cannot be confused with the `●` in the status label, which means "what
            // state is the harness in" rather than "which version is this".
            //
            // DISABLED, because switching to the version that is already running is not a
            // no-op: the sidecar stops the harness and starts it again, which would
            // restart a working harness for nothing. A checked item IS the natural
            // platform idiom for "this is the current one" in a radio-style list, and
            // `PlanNode::Check` already exists for the auto-update options.
            //
            // The `(installed)` suffix is gone: the tick says which one is RUNNING, and
            // every entry here is installed by definition (the list is enumerated from
            // the library), so the suffix was noise. It survives in the `Label` fallback
            // below only for the case where the running version is not in the list at
            // all - then there is nothing to tick, and saying so is the only information
            // available.
            items.push(PlanNode::Check {
                id: format!("{ID_HARNESS_RECENT_PREFIX}{}", entry.version),
                label: format!("v{}", entry.version),
                action: MenuAction::SwitchVersion(entry.version.clone()),
                checked: true,
                // Not clickable: see above. The tick is information, not an action.
                enabled: false,
            });
        } else {
            items.push(PlanNode::Action {
                id: format!("{ID_HARNESS_RECENT_PREFIX}{}", entry.version),
                label: format!("v{}", entry.version),
                action: MenuAction::SwitchVersion(entry.version.clone()),
                enabled: true,
            });
        }
    }

    items.push(PlanNode::Action {
        id: ID_HARNESS_SHOW_ALL_VERSIONS.to_owned(),
        label: LABEL_SHOW_ALL_VERSIONS.to_owned(),
        action: MenuAction::OpenControlPanel {
            tab: PanelTab::Versions,
        },
        enabled: SHOW_ALL_VERSIONS_ENABLED,
    });

    PlanNode::Submenu {
        label: LABEL_RECENT_VERSIONS.to_owned(),
        items,
    }
}

/// The `Harness` submenu (section 3.8).
///
/// Identical on all three platforms - this is where content parity matters, and
/// a test asserts the three plans agree on it.
fn harness_menu(state: &MenuState) -> PlanNode {
    // NOTE ON `&`: muda treats `&` as a Windows mnemonic marker, so a literal
    // ampersand in a label needs doubling. No label here contains one, and the
    // only interpolated value is a version string from the registry, which
    // cannot contain one either.
    PlanNode::Submenu {
        label: LABEL_HARNESS.to_owned(),
        items: vec![
            PlanNode::StatusLabel {
                id: ID_HARNESS_STATUS.to_owned(),
                label: status_label(state),
            },
            PlanNode::Separator,
            // Restart and Stop are always clickable: section 3.8 lists them as
            // plain actions, and the sidecar's routes are idempotent and
            // state-correcting (a restart while stopped starts; a stop while
            // stopped is a no-op that reports `stopped`). Adding enabled-state
            // policy here would be inventing behaviour the spec does not state.
            PlanNode::Action {
                id: ID_HARNESS_RESTART.to_owned(),
                label: LABEL_RESTART.to_owned(),
                action: MenuAction::RestartHarness,
                enabled: true,
            },
            PlanNode::Action {
                id: ID_HARNESS_STOP.to_owned(),
                label: LABEL_STOP.to_owned(),
                action: MenuAction::StopHarness,
                enabled: true,
            },
            PlanNode::Action {
                id: ID_HARNESS_OPEN_LOGS.to_owned(),
                label: LABEL_OPEN_LOGS.to_owned(),
                action: MenuAction::OpenLogsFolder,
                enabled: true,
            },
            PlanNode::Separator,
            auto_update_submenu(state),
            recent_versions_submenu(state),
            PlanNode::Separator,
            // A placeholder until Phase 2: labelless hooks would be worse, and
            // the click reports why rather than doing nothing.
            PlanNode::Action {
                id: ID_HARNESS_UPDATE.to_owned(),
                label: LABEL_HARNESS_UPDATE.to_owned(),
                action: MenuAction::HarnessUpdate,
                enabled: true,
            },
        ],
    }
}

/// The `Dock` submenu (section 3.8).
///
/// On macOS the About entry is NOT here: macOS convention mandates exactly one
/// About, in the application menu, so the platform shape drops it. This is the
/// only content divergence between platforms, and a test pins it.
fn dock_menu(state: &MenuState, target_os: TargetOs) -> PlanNode {
    let mut items = vec![
        PlanNode::Label {
            label: format!("{LABEL_CURRENT_VERSION_PREFIX}{}", state.dsh_dock_version),
        },
        PlanNode::Separator,
        PlanNode::Action {
            id: ID_DOCK_UPDATE.to_owned(),
            label: LABEL_DOCK_UPDATE.to_owned(),
            action: MenuAction::DockUpdate,
            enabled: true,
        },
        PlanNode::Action {
            id: ID_DOCK_CONTROL_PANEL.to_owned(),
            label: LABEL_SHOW_CONTROL_PANEL.to_owned(),
            action: MenuAction::OpenControlPanel {
                tab: PanelTab::Harness,
            },
            enabled: true,
        },
    ];

    if target_os != TargetOs::MacOs {
        items.push(PlanNode::Predefined {
            name: PredefinedName::About,
            label: LABEL_ABOUT.to_owned(),
        });
    }

    PlanNode::Submenu {
        label: LABEL_DOCK.to_owned(),
        items,
    }
}

/// The `Settings` top-level menu.
///
/// A menu bar cannot have a clickable top-level entry, so section 3.8's
/// "top-level item" is a one-item submenu here. macOS does not get this menu at
/// all - Settings moves into the application menu, which is where macOS users
/// expect it.
fn settings_menu() -> PlanNode {
    PlanNode::Submenu {
        label: LABEL_SETTINGS.to_owned(),
        items: vec![PlanNode::Action {
            id: ID_SETTINGS_OPEN.to_owned(),
            label: LABEL_SETTINGS_ITEM.to_owned(),
            action: MenuAction::OpenControlPanel {
                tab: PanelTab::Settings,
            },
            enabled: true,
        }],
    }
}

/// The macOS application menu.
///
/// It must come FIRST: macOS renders the first submenu of the main menu as the
/// application menu, and its title is what the menu bar shows. Leading with
/// `Harness` would swallow the Harness submenu into that slot.
fn application_menu() -> PlanNode {
    PlanNode::Submenu {
        label: LABEL_APP_MENU.to_owned(),
        items: vec![
            PlanNode::Predefined {
                name: PredefinedName::About,
                label: LABEL_ABOUT.to_owned(),
            },
            PlanNode::Separator,
            PlanNode::Action {
                id: ID_SETTINGS_OPEN.to_owned(),
                label: LABEL_SETTINGS_ITEM.to_owned(),
                action: MenuAction::OpenControlPanel {
                    tab: PanelTab::Settings,
                },
                enabled: true,
            },
            PlanNode::Separator,
            PlanNode::Predefined {
                name: PredefinedName::Hide,
                label: LABEL_HIDE.to_owned(),
            },
            PlanNode::Predefined {
                name: PredefinedName::HideOthers,
                label: LABEL_HIDE_OTHERS.to_owned(),
            },
            PlanNode::Predefined {
                name: PredefinedName::ShowAll,
                label: LABEL_SHOW_ALL.to_owned(),
            },
            PlanNode::Separator,
            PlanNode::Predefined {
                name: PredefinedName::Quit,
                label: LABEL_QUIT.to_owned(),
            },
        ],
    }
}

/// Builds the complete menu plan for one platform.
///
/// Pure: same state and platform in, same plan out. The shell uses that property
/// for its rebuild gate - a rebuild happens only when this result actually
/// changes (section 2.7, section 7.4).
pub fn menu_plan(state: &MenuState, target_os: TargetOs) -> MenuPlan {
    let mut top_level = Vec::with_capacity(3);

    if target_os == TargetOs::MacOs {
        top_level.push(application_menu());
    }

    top_level.push(harness_menu(state));
    top_level.push(dock_menu(state, target_os));

    if target_os != TargetOs::MacOs {
        top_level.push(settings_menu());
    }

    MenuPlan { target_os, top_level }
}

// --- Diagnostic dump --------------------------------------------------------

/// One scenario's plan on one platform, as reported by the dump flag.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpEntry<'a> {
    scenario: &'a str,
    target_os: TargetOs,
    state: &'a MenuState,
    plan: MenuPlan,
}

/// The scenario fixtures behind the dump flag and the structural tests.
///
/// One list, used by both, so a scenario cannot exist in the dump but not in the
/// tests (or the reverse). `recent-versions` is a Phase 2 preview: nothing
/// populates that list yet, but the plan must already handle it.
pub fn dump_scenarios() -> Vec<(&'static str, MenuState)> {
    let running = MenuState {
        harness_status: HarnessStatus::Running,
        harness_version: Some("0.1.5-rc.2".to_owned()),
        harness_pid: Some(4242),
        ..MenuState::default()
    };

    vec![
        ("running", running.clone()),
        (
            "running-no-version",
            MenuState {
                // The sidecar can report `running` before it knows the version.
                harness_version: None,
                ..running.clone()
            },
        ),
        (
            "stopped",
            MenuState {
                harness_status: HarnessStatus::Stopped,
                ..MenuState::default()
            },
        ),
        (
            "starting",
            MenuState {
                harness_status: HarnessStatus::Starting,
                ..MenuState::default()
            },
        ),
        (
            "error",
            MenuState {
                harness_status: HarnessStatus::Error,
                harness_pid: Some(4242),
                last_error: Some(
                    "The recorded harness (pid 4242) is not answering on its URL \
                     (probe timed out after 1500ms). Stop it and start again."
                        .to_owned(),
                ),
                ..MenuState::default()
            },
        ),
        (
            "unavailable",
            MenuState {
                harness_status: HarnessStatus::Unavailable,
                ..MenuState::default()
            },
        ),
        (
            "recent-versions",
            MenuState {
                // Newest-first, with dates, exactly as the sidecar's payload orders
                // them. The sixth entry exists so the fixture proves the submenu CAPS
                // what it shows at RECENT_VERSIONS_LIMIT while the state keeps all of
                // it - which is what "Show all versions…" depends on.
                recent_versions: vec![
                    RecentVersion {
                        version: "0.1.5-rc.2".to_owned(),
                        installed_at: Some("2026-10-03T00:00:00Z".to_owned()),
                    },
                    RecentVersion {
                        version: "0.1.5-rc.1".to_owned(),
                        installed_at: Some("2026-10-02T00:00:00Z".to_owned()),
                    },
                    RecentVersion::bare("0.1.5-alpha.2"),
                    RecentVersion::bare("0.1.4-rc.3"),
                    RecentVersion::bare("0.1.4-rc.2"),
                    RecentVersion::bare("0.1.4-rc.1"),
                ],
                installed_version: Some("0.1.5-rc.2".to_owned()),
                ..running.clone()
            },
        ),
        (
            // The real-world case where the active version has aged out of the
            // five shown: nothing is marked `(installed)`, and the only route to
            // it is the version manager entry.
            "recent-versions-installed-not-listed",
            MenuState {
                recent_versions: vec![
                    RecentVersion::bare("0.1.6-rc.1"),
                    RecentVersion::bare("0.1.5-rc.2"),
                    RecentVersion::bare("0.1.5-rc.1"),
                    RecentVersion::bare("0.1.5-alpha.2"),
                    RecentVersion::bare("0.1.4-rc.3"),
                    RecentVersion::bare("0.1.4-rc.2"),
                ],
                installed_version: Some("0.1.3-rc.1".to_owned()),
                harness_version: Some("0.1.3-rc.1".to_owned()),
                ..running.clone()
            },
        ),
    ]
}

/// The menu plan for every scenario on every platform, as pretty JSON.
///
/// DIAGNOSTIC ONLY. `DSH_DOCK_DUMP_MENU_PLAN=1` prints this and exits before the
/// Tauri builder runs, so it opens no window, spawns no sidecar and touches no
/// data directory. It is also what `src-tauri/test/menu-check.ps1` asserts
/// against, which is why it must stay free of the harness URL: the plan carries
/// no token, and a test proves it.
pub fn dump_json() -> String {
    let scenarios = dump_scenarios();
    let mut entries = Vec::new();

    for (scenario, state) in &scenarios {
        for target_os in TargetOs::ALL {
            entries.push(DumpEntry {
                scenario,
                target_os,
                state,
                plan: menu_plan(state, target_os),
            });
        }
    }

    serde_json::to_string_pretty(&entries)
        .unwrap_or_else(|error| format!("{{\"error\": \"could not serialise the menu plan: {error}\"}}"))
}

// ============================================================================
// Native adapter
// ============================================================================
//
// Everything above this line is pure data. This half touches Tauri, and its job
// is construction and dispatch only: every decision was already made by
// `menu_plan`.
//
// THE MAIN-THREAD RULE (Step C, R1). Tauri delivers menu events through the
// event loop, which is also the thread that pumps both webviews. A handler that
// talked to the sidecar over the network, wrote the settings file, or spawned a
// process would freeze every window until it finished - the same failure class
// as the 3m19s `navigate()` freeze this project already has scar tissue for. So:
//
//   * `handle_menu_event` resolves the action and returns;
//   * `OpenControlPanel` is pure window management and is the ONLY arm allowed
//     to run inline;
//   * every other action is moved to a worker thread, which marshals any UI work
//     or rebuild back through `run_on_main_thread`.
//
// `rebuild_menu` must itself run on the main thread. Calling it from the main
// thread makes every one of its internal `run_on_main_thread` hops run inline
// (tauri-runtime-wry's `send_user_message`), which both keeps the rebuild inside
// a single event-loop message - so Windows cannot repaint a menu-less bar
// between the detach and the attach - and removes ~50 blocking round trips.

/// Event that asks the control panel to come forward on a given tab.
pub const EVENT_PANEL_OPEN: &str = "panel:open";

/// Event that asks the dashboard to PERFORM a menu action.
///
/// This is the only channel by which the menu makes something happen, and it
/// exists so there is exactly one implementation of each action: the menu emits
/// the intent, and the dashboard runs the same function its own button runs.
/// Before this, the menu called the sidecar over HTTP while the dashboard kept
/// its own view of the world - and the two drifted, so a menu "Stop Harness"
/// stopped the harness without the dashboard noticing.
pub const EVENT_MENU_ACTION: &str = "menu:action";

/// An action the dashboard knows how to perform.
///
/// `Start` and `Refresh` are part of the channel but no menu item emits them
/// today: section 3.8's menu has Restart and Stop but no Start (a restart from
/// stopped starts the harness), and no Refresh. They are here because the
/// dashboard's handlers exist and a future menu item should not need a new event
/// shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashboardAction {
    /// Start the harness (dashboard's `startHarness`).
    Start,
    /// Stop the harness (dashboard's `stopHarness`).
    Stop,
    /// Stop then start (dashboard's `restartHarness`).
    Restart,
    /// Re-read the status now (dashboard's `refresh`).
    Refresh,
    /// Reveal the logs folder. Emitted for consistency; the shell performs it,
    /// because it has no dashboard state to keep in step.
    OpenLogs,
}

impl DashboardAction {
    /// The token carried in the event payload and written to the log.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Refresh => "refresh",
            Self::OpenLogs => "open-logs",
        }
    }
}

/// Payload of [`EVENT_MENU_ACTION`]: `{ "action": "stop" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MenuActionRequest {
    /// What the dashboard should do.
    pub action: DashboardAction,
}

/// Event emitted after any settings mutation (section 3.11, Q53 step 4).
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";

/// Environment variable that overrides the menu status poll interval.
pub const POLL_INTERVAL_ENV_VAR: &str = "DSH_DOCK_MENU_POLL_MS";

/// Product facts for the About panel. Kept here rather than duplicated in the
/// label constants so the dialog and the menu cannot disagree.
const PRODUCT_NAME: &str = "DSH-Dock";
const TAGLINE: &str = "Your launchpad for the DeepSeek Harness.";
const AUTHORS: &str = "DSH-Dock contributors";
const REPO_URL: &str = "https://github.com/MIHassan3/DSH-Launcher";

/// How often the status watcher asks the sidecar, when nothing overrides it.
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Floor for the diagnostic override: below this the poll would be a busy loop.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Payload of [`EVENT_PANEL_OPEN`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelOpenPayload {
    /// Which tab to reveal.
    pub tab: PanelTab,
    /// Why the panel was opened, when the reason is worth showing.
    pub message: Option<String>,
}

/// Why a rebuild happened. Recorded so the log says what moved the menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildReason {
    /// The first attach, during `setup`.
    Initial,
    /// A harness state change, from the watcher or a control call.
    StatusChange,
    /// The tracked channel changed.
    SettingsChange,
    /// The periodic status poll.
    Poll,
}

impl RebuildReason {
    /// The token used in the rebuild log line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::StatusChange => "status-change",
            Self::SettingsChange => "settings-change",
            Self::Poll => "poll",
        }
    }
}

/// What one rebuild did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RebuildOutcome {
    /// True when a new menu was built AND installed.
    pub installed: bool,
    /// How long the attempt took, in milliseconds.
    pub duration_ms: u128,
}

/// Menu state plus the plan currently on screen.
///
/// The two facts are kept apart on purpose: the state is what the menu SHOULD
/// show, and the installed plan is what it DOES show. The rebuild gate compares a
/// freshly built plan against the installed one, which is what makes "menus are
/// immutable, so rebuild them" (section 2.7) affordable: a poll that finds the
/// same state rebuilds nothing at all.
pub struct MenuRuntime {
    inner: Mutex<MenuRuntimeInner>,
}

struct MenuRuntimeInner {
    state: MenuState,
    installed: Option<MenuPlan>,
}

impl MenuRuntime {
    /// A runtime with no menu installed yet.
    pub fn new(state: MenuState) -> Self {
        Self {
            inner: Mutex::new(MenuRuntimeInner {
                state,
                installed: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MenuRuntimeInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The current menu state.
    pub fn snapshot(&self) -> MenuState {
        self.lock().state.clone()
    }

    /// The plan believed to be on screen.
    pub fn last_installed(&self) -> Option<MenuPlan> {
        self.lock().installed.clone()
    }

    /// Records a plan that was successfully installed.
    pub fn remember_installed(&self, plan: MenuPlan) {
        self.lock().installed = Some(plan);
    }

    /// Applies harness facts. True when anything stored changed.
    ///
    /// A pid-only change reports `true` here even though the menu does not
    /// render the pid; the rebuild gate is the plan comparison, so the extra
    /// report costs a plan build and nothing else.
    pub fn update_harness(&self, snapshot: &HarnessSnapshot) -> bool {
        let mut inner = self.lock();

        let unchanged = inner.state.harness_status == snapshot.status
            && inner.state.harness_version == snapshot.version
            && inner.state.harness_pid == snapshot.pid
            && inner.state.last_error == snapshot.last_error;
        if unchanged {
            return false;
        }

        inner.state.harness_status = snapshot.status;
        inner.state.harness_version = snapshot.version.clone();
        inner.state.harness_pid = snapshot.pid;
        inner.state.last_error = snapshot.last_error.clone();
        true
    }

    /// Applies the installed-version list. True when the menu's view of it changed.
    ///
    /// WHY THIS IS A SEPARATE GUARD, AND WHY IT IS NOT OPTIONAL. `update_harness`
    /// returns `false` whenever its four fields are unchanged, and the watcher only
    /// asks for a rebuild when SOMETHING reports a change. Without this second guard
    /// a version list that changed while the harness did not - which is exactly what
    /// an install or a delete is - would never reach `rebuild_menu` at all: the
    /// submenu would silently never populate, and no error would be logged. That is
    /// 2B's version of the "computed but never applied" bug this phase keeps meeting.
    ///
    /// COMPARED BY CONTENT, NOT BY REFERENCE. The payload is rebuilt on every poll, so
    /// `recent_versions` is a fresh `Vec` each time; a reference or pointer comparison
    /// would report "different" every 5 seconds and trigger a full structural rebuild
    /// (~37 ms) forever. `Vec<RecentVersion>` derives `PartialEq` and each field is a
    /// `String`/`Option<String>`, so this is an element-wise content comparison.
    ///
    /// ONLY THE VERSION STRINGS ARE COMPARED, and that is the second half of the same
    /// concern: `installed_at` is NOT rendered by the submenu, so a catalogue rewrite
    /// that moved dates without moving the list would trigger a 37 ms rebuild for a
    /// menu that looks identical. Comparing what is DISPLAYED is what keeps the guard
    /// honest in both directions - it fires when the menu would change, and not
    /// otherwise. (`installed_at` is still stored, for Phase 3's version table.)
    pub fn update_library(&self, snapshot: &HarnessSnapshot) -> bool {
        let mut inner = self.lock();

        let same = inner.state.recent_versions.len() == snapshot.recent_versions.len()
            && inner
                .state
                .recent_versions
                .iter()
                .zip(snapshot.recent_versions.iter())
                .all(|(current, next)| current.version == next.version);
        if same {
            return false;
        }

        inner.state.recent_versions = snapshot.recent_versions.clone();
        true
    }

    /// Applies a whole snapshot: harness facts AND the version list.
    ///
    /// The ONE entry point the watcher and the control commands should call, so a
    /// caller cannot remember one guard and forget the other. Returns true when
    /// anything the menu renders changed.
    pub fn update_snapshot(&self, snapshot: &HarnessSnapshot) -> bool {
        // Both are evaluated: `|` rather than `||`, because short-circuiting would
        // skip the library update whenever the harness facts moved too - and the two
        // are independent facts about different parts of the menu.
        let harness = self.update_harness(snapshot);
        let library = self.update_library(snapshot);
        harness | library
    }

    /// Applies the settings the menu renders. True when it changed.
    pub fn apply_settings(&self, settings: &Settings) -> bool {
        let mut inner = self.lock();
        if inner.state.auto_update_channel == settings.auto_update_channel {
            return false;
        }
        inner.state.auto_update_channel = settings.auto_update_channel.clone();
        true
    }
}

/// Builds a real menu from a plan.
///
/// THIN BY DESIGN. What exists, what is enabled, what is ticked, what each label
/// says and which platform shape applies were all decided by [`menu_plan`]. This
/// function constructs and nothing else, which is why the interesting behaviour
/// is unit-testable without a window.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, plan: &MenuPlan) -> tauri::Result<Menu<R>> {
    let mut builder = MenuBuilder::new(app);

    for node in &plan.top_level {
        match node {
            PlanNode::Submenu { label, items } => {
                let submenu = build_submenu(app, label, items)?;
                builder = builder.item(&submenu);
            }
            // A menu bar can only hold submenus. `menu_plan` never emits anything
            // else at the top level, so this is reported rather than skipped:
            // silence here would hide a structural mistake.
            other => log_line(&format!(
                "menu: ignoring a top-level node that is not a submenu: {other:?}"
            )),
        }
    }

    builder.build()
}

/// Constructs one submenu and its children.
fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    items: &[PlanNode],
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, label);

    for node in items {
        match node {
            PlanNode::Action {
                id,
                label,
                enabled,
                ..
            } => {
                let item = MenuItemBuilder::with_id(id.clone(), label)
                    .enabled(*enabled)
                    .build(app)?;
                builder = builder.item(&item);
            }
            PlanNode::Check {
                id,
                label,
                checked,
                enabled,
                ..
            } => {
                let item = CheckMenuItemBuilder::with_id(id.clone(), label)
                    .checked(*checked)
                    .enabled(*enabled)
                    .build(app)?;
                builder = builder.item(&item);
            }
            PlanNode::Label { label } => {
                // No id: a disabled informational line is never dispatched.
                let item = MenuItemBuilder::new(label).enabled(false).build(app)?;
                builder = builder.item(&item);
            }
            PlanNode::StatusLabel { id, label } => {
                // Same disabled label as above, but WITH an id: the fast path in
                // `rebuild_menu` looks this item up by name to retitle it without
                // rebuilding anything.
                let item = MenuItemBuilder::with_id(id.clone(), label)
                    .enabled(false)
                    .build(app)?;
                builder = builder.item(&item);
            }
            PlanNode::Separator => {
                builder = builder.separator();
            }
            PlanNode::Submenu { label, items } => {
                let submenu = build_submenu(app, label, items)?;
                builder = builder.item(&submenu);
            }
            PlanNode::Predefined { name, label } => {
                let item = predefined_item(app, *name, label)?;
                builder = builder.item(&item);
            }
        }
    }

    builder.build()
}

/// Constructs one OS-provided item.
fn predefined_item<R: Runtime>(
    app: &AppHandle<R>,
    name: PredefinedName,
    label: &str,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match name {
        PredefinedName::About => about_item(app, label),
        PredefinedName::Hide => PredefinedMenuItem::hide(app, Some(label)),
        PredefinedName::HideOthers => PredefinedMenuItem::hide_others(app, Some(label)),
        PredefinedName::ShowAll => PredefinedMenuItem::show_all(app, Some(label)),
        PredefinedName::Quit => PredefinedMenuItem::quit(app, Some(label)),
    }
}

/// Metadata rendered by the native About panel.
///
/// Field-by-field rationale is in [`about_item`].
fn about_metadata(icon: Option<tauri::image::Image<'_>>) -> AboutMetadata<'_> {
    AboutMetadata {
        name: Some(PRODUCT_NAME.to_owned()),
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        comments: Some(TAGLINE.to_owned()),
        authors: Some(vec![AUTHORS.to_owned()]),
        license: Some("MIT".to_owned()),
        website: Some(REPO_URL.to_owned()),
        website_label: Some("GitHub".to_owned()),
        icon,
        ..Default::default()
    }
}

/// The About item, with metadata that actually produces a dialog.
///
/// THE WINDOWS TRAP, verified against muda 0.19.3: the Windows backend handles
/// `About(Some(metadata))` and does nothing at all for `About(None)` - the item
/// is clickable and dead. The same dialog renders only the fields that are SET,
/// so empty metadata would produce an empty box. Both are why the metadata above
/// is populated field by field.
///
/// Deliberately omitted: `copyright` (no rights holder is defined yet),
/// `short_version` (Windows/Linux append it as "0.5.1 (0.5)", which reads
/// badly), and `credits` (macOS-only, nothing meaningful to put there yet).
///
/// The icon is best-effort: converting an image into muda's icon type can fail,
/// and a bad icon must not cost us the About item, so the conversion is retried
/// without it.
fn about_item<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<PredefinedMenuItem<R>> {
    let icon = app.default_window_icon().cloned();

    match PredefinedMenuItem::about(app, Some(label), Some(about_metadata(icon))) {
        Ok(item) => Ok(item),
        Err(error) => {
            log_line(&format!(
                "menu: the About panel rejected its icon ({error}); retrying without it"
            ));
            PredefinedMenuItem::about(app, Some(label), Some(about_metadata(None)))
        }
    }
}

/// The text of the status line in `plan`, if it has one.
fn status_label_in(plan: &MenuPlan) -> Option<&str> {
    fn walk(nodes: &[PlanNode]) -> Option<&str> {
        for node in nodes {
            match node {
                PlanNode::StatusLabel { label, .. } => return Some(label),
                PlanNode::Submenu { items, .. } => {
                    if let Some(found) = walk(items) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        None
    }

    walk(&plan.top_level)
}

/// Rewrites the status text in `plan`. False when there is no status node.
fn set_status_label_in(plan: &mut MenuPlan, text: &str) -> bool {
    fn walk(nodes: &mut [PlanNode], text: &str) -> bool {
        for node in nodes {
            match node {
                PlanNode::StatusLabel { label, .. } => {
                    *label = text.to_owned();
                    return true;
                }
                PlanNode::Submenu { items, .. } => {
                    if walk(items, text) {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    walk(&mut plan.top_level, text)
}

/// Detects the one change that can be applied without a rebuild.
///
/// Returns the new status text when `candidate` differs from `installed` ONLY in
/// the status line's text, and `None` otherwise.
///
/// Implemented by normalising a copy of the candidate back to the installed text
/// and comparing the two plans: that catches every other difference - labels,
/// enabled flags, tick marks, ordering, added or removed items - without a
/// hand-written field-by-field comparison that could silently stop covering a
/// field that gets added later.
fn status_only_change(installed: &MenuPlan, candidate: &MenuPlan) -> Option<String> {
    let previous = status_label_in(installed)?;
    let next = status_label_in(candidate)?;
    if previous == next {
        return None;
    }

    let mut normalised = candidate.clone();
    if !set_status_label_in(&mut normalised, previous) {
        return None;
    }

    (normalised == *installed).then(|| next.to_owned())
}

/// `pid=<n|none> version=<v|none>` for the menu log lines.
///
/// One place, so the rebuild line and the fast-path line cannot drift apart -
/// the whole point of this round was removing a second implementation of the same
/// fact.
fn log_identity(state: &MenuState) -> String {
    format!(
        "pid={} version={}",
        state
            .harness_pid
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "none".to_owned()),
        state
            .harness_version
            .clone()
            .unwrap_or_else(|| "none".to_owned()),
    )
}

/// The installed menu's item with this id, searching SUBMENUS as well.
///
/// WHY NOT `Menu::get`: it searches only the menu's DIRECT children
/// (`self.items().find(|i| i.id() == &id)`), and this menu's direct children are
/// the top-level submenus - Harness, Dock, Settings. `harness.status` lives one
/// level down inside Harness, so `Menu::get` returned `None` every single time and
/// the fast path fell back to a full rebuild on every attempt. `Submenu::get` has
/// the same direct-children semantics, so the walk is recursive instead: the lookup
/// then does not depend on WHERE in the tree the item currently lives.
fn installed_item<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<MenuItem<R>> {
    fn find<R: Runtime>(items: &[MenuItemKind<R>], id: &str) -> Option<MenuItem<R>> {
        for kind in items {
            match kind {
                MenuItemKind::MenuItem(item) => {
                    if item.id() == id {
                        return Some(item.clone());
                    }
                }
                MenuItemKind::Submenu(submenu) => {
                    if let Ok(children) = submenu.items() {
                        if let Some(found) = find(&children, id) {
                            return Some(found);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }

    find(&app.menu()?.items().ok()?, id)
}

/// Every id reachable from the installed menu, for the failure message.
///
/// Computed ONLY when a lookup fails, so it costs nothing on the happy path - and
/// when it does run it answers "is the id there at all, and what IS there" from the
/// log, without another build. That is exactly the question this module got wrong
/// once already.
fn installed_ids<R: Runtime>(app: &AppHandle<R>) -> String {
    fn collect<R: Runtime>(items: &[MenuItemKind<R>], found: &mut Vec<String>) {
        for kind in items {
            let id: &str = kind.id().as_ref();
            found.push(id.to_owned());

            if let MenuItemKind::Submenu(submenu) = kind {
                if let Ok(children) = submenu.items() {
                    collect(&children, found);
                }
            }
        }
    }

    let mut found = Vec::new();
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            collect(&items, &mut found);
        }
    }

    found.sort();
    found.join(", ")
}

/// Rebuilds and installs the menu when it differs from what is on screen.
///
/// MUST run on the main thread: see the module-level note above. Use
/// [`request_rebuild`] from anywhere else.
pub fn rebuild_menu<R: Runtime>(app: &AppHandle<R>, reason: RebuildReason) -> RebuildOutcome {
    let started = std::time::Instant::now();

    let Some(runtime) = app.try_state::<MenuRuntime>() else {
        log_line("menu rebuild: skipped - the menu runtime is not registered");
        return RebuildOutcome {
            installed: false,
            duration_ms: started.elapsed().as_millis(),
        };
    };

    let state = runtime.snapshot();
    let plan = menu_plan(&state, TargetOs::current());
    let installed = runtime.last_installed();

    if installed.as_ref() == Some(&plan) {
        // Nothing the menu renders changed. This is the common case for the poll,
        // and it is deliberately SILENT: the absence of rebuild lines in the log
        // is itself the evidence that the gate works.
        return RebuildOutcome {
            installed: false,
            duration_ms: started.elapsed().as_millis(),
        };
    }

    // FAST PATH. A status transition changes one line of text and nothing else,
    // and a full rebuild costs a detach/attach of the menu bar per window (~23 ms
    // median measured, against a 5 ms target) plus a client-area resize. Retitling
    // the single installed item is one `SetMenuItemInfoW` and one `DrawMenuBar`.
    //
    // It is a NARROW path on purpose: anything else - a tick mark, an enabled
    // flag, the version list - falls through to a full rebuild, so structural
    // change keeps exactly one code path and cannot drift.
    if let Some(installed) = installed.as_ref() {
        if let Some(text) = status_only_change(installed, &plan) {
            // Both non-installing arms fall through to the full rebuild below;
            // the reason is logged, because a fast path that silently does nothing
            // would be the hardest failure to notice.
            let refused = match installed_item(app, ID_HARNESS_STATUS) {
                Some(item) => match item.set_text(&text) {
                    Ok(()) => {
                        runtime.remember_installed(plan);
                        let duration_ms = started.elapsed().as_millis();
                        log_line(&format!(
                            "menu update: reason={} duration_ms={duration_ms} status={} {} \
                             (status label only, no rebuild)",
                            reason.as_str(),
                            status_label(&state),
                            log_identity(&state),
                        ));
                        return RebuildOutcome {
                            installed: true,
                            duration_ms,
                        };
                    }
                    Err(error) => format!("could not retitle the status item ({error})"),
                },
                None => format!(
                    "'{}' is not in the installed menu (ids present: {})",
                    ID_HARNESS_STATUS,
                    installed_ids(app)
                ),
            };

            log_line(&format!(
                "menu update: {refused}; falling back to a full rebuild"
            ));
        }
    }

    let menu = match build_menu(app, &plan) {
        Ok(menu) => menu,
        Err(error) => {
            log_line(&format!("menu rebuild: could not build the menu: {error}"));
            return RebuildOutcome {
                installed: false,
                duration_ms: started.elapsed().as_millis(),
            };
        }
    };

    if let Err(error) = app.set_menu(menu) {
        log_line(&format!("menu rebuild: set_menu failed: {error}"));
        return RebuildOutcome {
            installed: false,
            duration_ms: started.elapsed().as_millis(),
        };
    }

    // WHICH WINDOWS THE APP-WIDE ATTACH ACTUALLY REACHED, MEASURED BY MENU IDENTITY.
    //
    // `AppHandle::set_menu` iterates the window map and attaches only where
    // `has_app_wide_menu() || menu().is_none()` holds. `has_app_wide_menu` is
    // `pub(crate)` in tauri, so it CANNOT be read from here - but its EFFECT can, and
    // more directly: compare the id of the menu a window holds with the id of the menu
    // that was just installed app-wide.
    //
    //   app_wide:<id>   the window received this rebuild's menu
    //   OTHER:<id>      the window holds a DIFFERENT menu, so the attach SKIPPED it
    //   none            the window has no menu at all
    //
    // This is the diagnostic that names the "harness window has no menu bar after a
    // switch" bug without guessing at the flag: a window reported as OTHER is one that
    // will keep a stale menu forever, because nothing else in the app sets one.
    let installed_id = app.menu().map(|menu| menu.id().clone());
    let mut reached: Vec<String> = Vec::new();
    for (label, window) in app.webview_windows() {
        let state = match window.menu() {
            Some(menu) if Some(menu.id()) == installed_id.as_ref() => format!("app_wide:{}", menu.id().as_ref()),
            Some(menu) => format!("OTHER:{}", menu.id().as_ref()),
            None => "none".to_owned(),
        };
        reached.push(format!("{label}={state}"));
    }
    reached.sort();
    log_line(&format!("menu app-wide attach: {}", reached.join(" ")));
    if reached.iter().any(|entry| entry.contains("=OTHER:") || entry.ends_with("=none")) {
        // Named loudly, because it is the difference between "this window has the menu"
        // and "this window will never be updated again".
        log_line("menu: WARNING - a window did not receive the app-wide menu; it will keep a stale menu");
    }

    // C1 part B. `AppHandle::set_menu` is app-wide and attaches to every window
    // that has none, so this very call just handed the menu bar BACK to the
    // first-run wizard if it is open - and the wizard deliberately has no menu
    // (its capability grants one command, so a menu click could only ever log
    // "could not deliver"). Clearing at creation alone would therefore survive
    // only until the next rebuild; this is what makes it durable.
    clear_welcome_menu(app, "rebuild");

    // Only now is the plan what is actually on screen.
    runtime.remember_installed(plan);

    let duration_ms = started.elapsed().as_millis();
    log_line(&format!(
        "menu rebuild: reason={} duration_ms={duration_ms} status={} {}",
        reason.as_str(),
        status_label(&state),
        log_identity(&state),
    ));

    // Attach check (Step C, R8). Tauri swallows platform attach errors, so a
    // window can silently end up with no menu bar. Naming every window, whether
    // it holds a menu AND whether the OS considers it visible turns that into a
    // log line instead of a mystery: "the menu was recorded" is not the same
    // fact as "the window is on screen".
    let mut attached: Vec<String> = app
        .webview_windows()
        .iter()
        .map(|(label, window)| {
            let visible = match window.is_visible() {
                Ok(visible) => visible.to_string(),
                Err(error) => format!("error({error})"),
            };
            format!("{label}=menu:{} visible:{visible}", window.menu().is_some())
        })
        .collect();
    attached.sort();
    log_line(&format!("menu attached: {}", attached.join(" ")));

    RebuildOutcome {
        installed: true,
        duration_ms,
    }
}

/// Asks for a rebuild on the main thread, from any thread.
pub fn request_rebuild<R: Runtime>(app: &AppHandle<R>, reason: RebuildReason) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        rebuild_menu(&handle, reason);
    }) {
        log_line(&format!(
            "menu: could not reach the main thread for a rebuild: {error}"
        ));
    }
}

/// Runs `work` on the main thread, from any thread.
///
/// `pub(crate)` because the first-run wizard's hand-off runs from a command or a
/// close handler and must marshal the same way the menu does.
pub(crate) fn on_main<R: Runtime, F: FnOnce(&AppHandle<R>) + Send + 'static>(
    app: &AppHandle<R>,
    work: F,
) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || work(&handle)) {
        log_line(&format!("menu: could not reach the main thread: {error}"));
    }
}

// --- The first-run wizard's window and hand-off -----------------------------
//
// These three live here rather than in `welcome.rs` for one reason: they are menu
// and event-plumbing concerns, and `welcome.rs` already depends on `menu.rs`.
// Putting them the other way round would make the two modules mutually dependent.
// What belongs to the wizard - the options, the gate, the payload - is in
// `welcome.rs` as pure data.

/// Removes the menu bar from the first-run wizard window, if it is open.
///
/// WHY THE WIZARD HAS NO MENU: every window inherits the app-wide menu
/// (`AppHandle::set_menu`), and the wizard's capability grants exactly one command.
/// A `Stop Harness` or `Settings…` click from that window could therefore only log
/// "could not deliver" - a poor first impression, on the one screen a brand-new
/// user sees. Section 2.9's durable surfaces are the dashboard and the harness
/// window; the wizard is neither.
///
/// Called from TWO places, which is why it is a function rather than an inline
/// call: at creation (the initial rebuild happened before the wizard existed, so
/// nothing else would cover it) and at the end of every rebuild (which re-attaches
/// the menu to every window that has none). One helper, so the two cannot drift.
pub(crate) fn clear_welcome_menu<R: Runtime>(app: &AppHandle<R>, stage: &str) {
    let Some(window) = app.get_webview_window(crate::welcome::WELCOME_WINDOW_LABEL) else {
        return;
    };

    // An EMPTY menu is the platform's "no menu bar" for this window; there is no
    // `set_menu(None)` shape on a window in tauri 2.
    let empty = match Menu::new(app) {
        Ok(menu) => menu,
        Err(error) => {
            log_line(&format!(
                "welcome: could not build an empty menu for the wizard window ({stage}): {error}"
            ));
            return;
        }
    };

    // `set_menu` returns the menu it REPLACED (`Some` when the window had one),
    // not a unit. The value is discarded on purpose: the app-wide menu is owned by
    // `rebuild_menu` and must not be restored from here.
    match window.set_menu(empty) {
        Ok(_) => log_line(&format!("welcome: menu cleared on the wizard window ({stage})")),
        Err(error) => log_line(&format!(
            "welcome: could not clear the wizard window's menu ({stage}): {error}"
        )),
    }
}

/// Whether `main`'s page has finished loading, and any hand-off not yet delivered.
///
/// STATIC RATHER THAN MANAGED STATE, deliberately: `on_page_load` is registered on
/// the `Builder` and its very first invocation can happen BEFORE the `setup` hook
/// runs, so anything `setup` manages would not exist yet. A `OnceLock` is created
/// on first use from whichever thread gets there first and needs no ordering
/// guarantee at all.
struct MainPageState {
    /// Set once `main`'s page load has finished at least once.
    finished: AtomicBool,
    /// The `install-and-open` payload awaiting delivery, if any.
    pending: Mutex<Option<crate::welcome::InstallAndOpenPayload>>,
}

static MAIN_PAGE_STATE: OnceLock<MainPageState> = OnceLock::new();

/// The process-wide [`MainPageState`], created on first use.
fn main_page_state() -> &'static MainPageState {
    MAIN_PAGE_STATE.get_or_init(|| MainPageState {
        finished: AtomicBool::new(false),
        pending: Mutex::new(None),
    })
}

/// Records that `main` finished a page load, and delivers any waiting hand-off.
///
/// Called from the app-wide `on_page_load` hook for the `main` window only. The
/// payload is delivered on a LATER turn of the event loop rather than inline:
/// `Finished` fires when the document is complete, and the dashboard's listener is
/// registered by its Svelte `onMount`, which runs as part of that same document's
/// script evaluation. Posting the emit means the listener wins the race even when
/// the two are microseconds apart.
pub(crate) fn mark_main_page_finished<R: Runtime>(app: &AppHandle<R>) {
    main_page_state()
        .finished
        .store(true, std::sync::atomic::Ordering::SeqCst);

    // Queued, not inline: see the note above. `on_main` clones the handle itself.
    on_main(app, deliver_pending_install_and_open);
}
/// Arms the hand-off and delivers it as soon as `main` can receive it (C2).
///
/// WHY THIS EXISTS AT ALL: `main` is created during startup and its page loads
/// while the window is HIDDEN, so by the time a human answers the wizard the page
/// may or may not be listening. Emitting blind would, on a genuine first run,
/// silently lose the one thing the wizard promised - and the user would be looking
/// at a stopped dashboard wondering why "Install and Open Harness" did nothing.
///
/// The intent is therefore stored, delivered immediately when the page is known to
/// have finished loading, and otherwise delivered from
/// [`mark_main_page_finished`]. The stored intent is CLEARED once the emit
/// succeeds, so a later page load cannot re-fire a hand-off the user already
/// received.
pub(crate) fn arm_install_and_open<R: Runtime>(
    app: &AppHandle<R>,
    payload: crate::welcome::InstallAndOpenPayload,
) {
    let state = main_page_state();
    {
        let mut pending = state.pending.lock().unwrap_or_else(PoisonError::into_inner);
        // A second arm replaces the first rather than queueing: the wizard can only
        // complete once, and two hand-offs would start the harness twice.
        *pending = Some(payload);
    }

    if state.finished.load(std::sync::atomic::Ordering::SeqCst) {
        deliver_pending_install_and_open(app);
    } else {
        log_line(
            "welcome: the dashboard page has not finished loading - the install-and-open \
             hand-off will be delivered when it does",
        );
    }
}

/// Emits the stored hand-off, exactly once, if it is ready to be delivered.
fn deliver_pending_install_and_open<R: Runtime>(app: &AppHandle<R>) {
    let state = main_page_state();

    if !state.finished.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    let Some(payload) = state
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    else {
        // The normal case: nothing is waiting. Silent on purpose - this runs on
        // every page load.
        return;
    };

    // The same question `deliver` asks, for the same reason: the dashboard is the
    // action surface, but the launcher keeps running when `main` is closed. An
    // undeliverable action is reported, never swallowed.
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        log_line(
            "welcome: could not deliver 'install-and-open' - the control panel is not open",
        );
        return;
    }

    match app.emit_to(MAIN_WINDOW_LABEL, crate::welcome::EVENT_INSTALL_AND_OPEN, &payload) {
        Ok(()) => log_line(&format!(
            "welcome: install-and-open delivered (channel={} dismissed={})",
            payload.channel, payload.dismissed
        )),
        Err(error) => {
            // Put it back: a failed emit is exactly the case the pending slot
            // exists for, and it will be retried at the next page load.
            log_line(&format!(
                "welcome: could not emit {}: {error} - it will be retried",
                crate::welcome::EVENT_INSTALL_AND_OPEN
            ));
            *state.pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(payload);
        }
    }
}

/// Reads the harness facts from the control surface.
///
/// Blocking: it calls the sidecar, which may probe the harness. Callers decide
/// which thread that happens on - the watcher's, or a click's worker thread.
/// NEVER call this from a menu handler on the main thread.
pub fn current_harness_snapshot<R: Runtime>(app: &AppHandle<R>) -> HarnessSnapshot {
    let Some(state) = app.try_state::<SidecarState>() else {
        return snapshot_unavailable(None);
    };

    if state.port_now().is_none() {
        // Either the handshake has not landed yet or the sidecar failed to
        // start; `snapshot_unavailable` distinguishes the two by the shell error.
        let error = state.error();
        return snapshot_unavailable(error.as_deref());
    }

    let response = crate::proxy_control(&state, "GET", "/harness/status");
    snapshot_from_response(&response)
}

/// Maps a control response onto a harness snapshot.
pub fn snapshot_from_response(response: &ProxiedResponse) -> HarnessSnapshot {
    if response.error.is_some() || response.code == 0 {
        return snapshot_unavailable(response.shell_error.as_deref());
    }
    snapshot_from_status_payload(&response.data)
}

/// Dispatches one menu click.
///
/// Runs on the main thread.
///
/// THE ONE-IMPLEMENTATION RULE. The dashboard owns what "stop the harness"
/// MEANS - it updates the badge, stops its timers, refreshes, and knows which
/// window to close. This handler therefore does NOT call the sidecar for those
/// actions; it forwards the intent and the dashboard runs the same function its
/// own button runs. Two parallel implementations of "stop" is exactly how the
/// menu's label and the dashboard's view drifted apart in the first place.
///
/// Only two things still happen in the shell, and both because no dashboard
/// state is involved:
///
///   * focusing the control panel (`OpenControlPanel`), which is window
///     management;
///   * opening the logs folder, which is a process spawn and stays on a worker.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_owned();

    let Some(action) = MenuAction::from_id(&id) else {
        // Predefined OS items (About, Quit, Hide) are handled by the OS itself.
        // Anything else reaching here means an id drifted out of sync with
        // `from_id`, which is worth a line rather than silence.
        log_line(&format!("menu: ignoring a click on an id that is not ours: {id}"));
        return;
    };

    log_line(&format!("menu click: {id}"));

    match action {
        // Pure window management: no network, no disk, no process spawn.
        MenuAction::OpenControlPanel { tab } => open_control_panel(app, tab, None),

        // Q99: harness actions dispatch SIDECAR-SIDE, unconditionally - see the block
        // comment on `menu_dispatch`. A menu item that does nothing when the dashboard
        // is closed is worse than the scope expansion, and the dashboard recovers its
        // state from the status poll, which now runs continuously (Q95's fix).
        MenuAction::RestartHarness => restart_harness(app),
        MenuAction::StopHarness => stop_harness(app),

        // Emitted for consistency with every other actionable item, AND performed
        // here: revealing a folder has no state that could drift, so a dashboard
        // round trip would add a failure mode for nothing.
        MenuAction::OpenLogsFolder => {
            deliver(app, DashboardAction::OpenLogs);

            let handle = app.clone();
            spawn_worker(app, "dsh-dock-menu-logs", move |_| match open_logs_folder() {
                Ok(path) => {
                    log_line(&format!("menu: opened the logs folder at {}", path.display()))
                }
                Err(error) => {
                    log_line(&format!("menu: {error}"));
                    on_main(&handle, move |app| {
                        open_control_panel(app, PanelTab::Harness, Some(error))
                    });
                }
            });
        }

        // Writes settings.json, so it stays on a worker.
        MenuAction::SetAutoUpdateChannel(channel) => {
            spawn_worker(app, "dsh-dock-menu-settings", move |app| {
                set_auto_update_channel(&app, channel)
            });
        }

        MenuAction::SwitchVersion(version) => switch_version(app, version),
        MenuAction::HarnessUpdate => notice(
            app,
            PanelTab::Harness,
            "Checking for a harness update arrives with the version library (Phase 2).".to_owned(),
        ),
        MenuAction::DockUpdate => notice(
            app,
            PanelTab::Harness,
            "Launcher updates arrive in Phase 3.".to_owned(),
        ),
    }
}

/// Forwards one action to the dashboard, which owns its implementation.
///
/// The control panel is the launcher's action surface, but the app keeps running
/// when that window is closed (the harness window can outlive it). A click that
/// cannot be delivered is therefore REPORTED and never swallowed: a menu item
/// that silently does nothing is the failure mode this channel exists to remove.
fn deliver<R: Runtime>(app: &AppHandle<R>, action: DashboardAction) {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        log_line(&format!(
            "menu: could not deliver '{}' - the control panel is not open",
            action.as_str()
        ));
        return;
    }

    let request = MenuActionRequest { action };
    if let Err(error) = app.emit_to(MAIN_WINDOW_LABEL, EVENT_MENU_ACTION, request) {
        log_line(&format!("menu: could not emit {EVENT_MENU_ACTION}: {error}"));
    }
}

// --- The switch: the ONE action that does not route through the dashboard -----
//
// Q74, EXTENDED IN 2B TO EVERY HARNESS ACTION (Q99).
//
// `Stop`, `Restart` and `Switch` all dispatch straight to the sidecar on a worker
// thread, UNCONDITIONALLY - not only when the dashboard happens to be closed. The
// earlier rule ("menu items forward their intent, and the dashboard performs it")
// assumed a fast action performed by a surface that is always there. Neither holds:
// the control panel is a window the user is expected to close, and a menu item that
// does NOTHING when clicked is the worst available outcome - worse than the scope
// expansion, and worse than a disabled item, which at least shows intent.
//
// The rule it replaces was stated as "one implementation per action, reached from two
// entry points". That is still true, and now true in BOTH directions: the SAME sidecar
// route serves the menu and the dashboard's button, so the dashboard is OPTIONAL for
// every harness action rather than required.
//
// The dashboard recovers its state from the status poll, which after the Bug 1 fix runs
// continuously - so a stop or a restart it did not perform is reflected within one idle
// cadence. That fix is what makes this expansion safe; without a steady poll, moving
// these actions off the dashboard would have left the card stale instead.
//
// `SwitchVersion` alone keeps its own entry point, because it validates a version name
// first; `Stop` and `Restart` take no argument.

/// What a menu-driven harness action should do, decided without touching the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwitchDispatch {
    /// Ask the sidecar for this route. Runs on a worker thread.
    Dispatch(String),
    /// Refuse, with the message the user is shown.
    Unavailable(String),
}

/// The routes the menu's harness actions reach.
pub mod menu_routes {
    /// `POST /harness/stop`.
    pub const STOP: &str = "/harness/stop";
    /// `POST /harness/restart`.
    pub const RESTART: &str = "/harness/restart";
}

/// Decides whether a harness action can be dispatched, and to where.
///
/// PURE, so every refusal is unit-testable without a window, a sidecar or a menu. The
/// dead-sidecar case is decided here for all three actions (Q91): when the sidecar never
/// came up, or has not reported its port yet, the click cannot become an HTTP call at
/// all, and the shell's recorded startup error is shown rather than a generic message -
/// it names the actual cause (a missing `sidecar/index.js`, for instance), which is the
/// same reason `ProxiedResponse` carries `shellError`.
pub fn action_dispatch(
    route: &str,
    action_label: &str,
    port: Option<u16>,
    shell_error: Option<&str>,
) -> SwitchDispatch {
    if port.is_none() {
        return match shell_error.map(str::trim).filter(|value| !value.is_empty()) {
            Some(error) => SwitchDispatch::Unavailable(format!(
                "Cannot {action_label}: the DSH-Dock core is not running, so there is nothing to \
                 reach. {error}"
            )),
            None => SwitchDispatch::Unavailable(format!(
                "Cannot {action_label}: the DSH-Dock core has not reported a port yet. If this \
                 persists, the core failed to start - check the launcher log."
            )),
        };
    }

    SwitchDispatch::Dispatch(route.to_owned())
}

/// Decides what a switch click should do, given what the shell knows.
///
/// The switch is `action_dispatch` plus ONE thing the other two do not need: the target
/// version must be a name that could address a directory in the library, so a malformed
/// menu id never becomes an HTTP request and the user gets the reason rather than a 400
/// from a service they did not know was involved.
pub fn switch_dispatch(
    version: &str,
    port: Option<u16>,
    shell_error: Option<&str>,
) -> SwitchDispatch {
    if !is_switchable_version(version) {
        return SwitchDispatch::Unavailable(format!(
            "Cannot switch to {version:?}: it is not an exact version, so it cannot name a version \
             in the library. Expected something like \"0.2.0-rc.2\"."
        ));
    }

    if port.is_none() {
        return match shell_error.map(str::trim).filter(|value| !value.is_empty()) {
            Some(error) => SwitchDispatch::Unavailable(format!(
                "Cannot switch to v{version}: the DSH-Dock core is not running, so there is nothing \
                 to switch. {error}"
            )),
            None => SwitchDispatch::Unavailable(format!(
                "Cannot switch to v{version}: the DSH-Dock core has not reported a port yet. \
                 If this persists, the core failed to start - check the launcher log."
            )),
        };
    }

    SwitchDispatch::Dispatch(format!("/versions/switch?version={version}"))
}

/// Mirrors `sidecar/lib/library.js`'s `isSafeVersionName`.
///
/// The sidecar validates this again and is the authority - this copy exists so a
/// malformed menu id cannot become an HTTP request, and so the user gets the reason
/// rather than a 400 from a service they did not know was involved. It is
/// deliberately the same shape the sidecar enforces: an exact version, optionally
/// with a pre-release AND a build suffix, either or both.
///
/// WHY THE FIRST VERSION OF THIS WAS WRONG. It split the string once on `-` or `+`,
/// which handled `1.2.3-rc.1` and `1.2.3+build.5` but refused
/// `1.2.3-rc.1+build.5` - a version with BOTH, which is legal and which the
/// pre-release and build identifier grammars explicitly allow together. The suffix
/// is therefore split at the FIRST `-` and then at the FIRST `+` after it, and each
/// part is checked separately.
fn is_switchable_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 128 {
        return false;
    }

    // Split off build metadata first (`+` cannot appear before it in a valid version),
    // then the pre-release, leaving the bare release.
    let (before_build, build) = match version.split_once('+') {
        Some((head, tail)) => (head, Some(tail)),
        None => (version, None),
    };
    let (release, pre) = match before_build.split_once('-') {
        Some((head, tail)) => (head, Some(tail)),
        None => (before_build, None),
    };

    let identifier = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    };

    // The release: exactly three dot-separated numeral-only components.
    let numbers: Vec<&str> = release.split('.').collect();
    if numbers.len() != 3
        || !numbers
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }

    // A pre-release may not contain `+` (already split off) and must be a real
    // identifier sequence; the same for build metadata.
    pre.is_none_or(identifier) && build.is_none_or(identifier)
}

/// Runs one menu action's HTTP request. WORKER THREAD ONLY - no UI work here.
///
/// Kept as the single request hop every menu-dispatched action goes through, so there
/// is ONE place that talks to the sidecar from a worker rather than four. The name says
/// what it may do and, by omission, what it may not.
fn run_menu_request<R: Runtime>(app: &AppHandle<R>, path: &str) -> crate::ProxiedResponse {
    crate::proxy_control_app(app, "POST", path)
}

/// Decides, dispatches and reports for one menu action.
///
/// THE SHARED SHAPE FOR ALL THREE HARNESS ACTIONS (Q99). `switch_version`, `stop_harness`
/// and `restart_harness` differ only in the route, the wording, and whether a version
/// name had to be validated first - so the threading boundary lives here once.
///
/// THREADING (section 2.8.3's rule, in BOTH directions):
///
///   * `handle_menu_event` runs ON THE MAIN THREAD. It must not block. A switch is
///     minutes; a stop and a restart are seconds but still block on HTTP, and the main
///     thread is where the menu itself lives, so even a fast request is marshalled off.
///   * A WORKER MUST NOT TOUCH THE MENU. `set_menu`, `MenuItem::set_text`, window focus
///     and `emit` are all main-thread work; calling them from a worker either silently
///     does nothing or panics. The worker's ONLY job is the HTTP call, and everything
///     visible is marshalled back with [`on_main`].
///
/// `test_only_probe` is the seam the worker-boundary tests use: they assert this
/// function performs exactly one HTTP call and no menu work.
fn run_menu_action<R, F>(
    app: &AppHandle<R>,
    dispatch: SwitchDispatch,
    panel: PanelTab,
    worker_name: &str,
    detail: String,
    outcome: F,
) where
    R: Runtime,
    F: FnOnce(&crate::ProxiedResponse) -> String + Send + 'static,
{
    match dispatch {
        // Nothing to do on a worker: there is no HTTP request to make. Reported through
        // the SAME channel every other refusal uses, so a dead sidecar always produces a
        // sentence rather than silence.
        SwitchDispatch::Unavailable(message) => notice(app, panel, message),
        SwitchDispatch::Dispatch(path) => {
            log_line(&format!("menu: {detail} (sidecar {path})"));
            let handle = app.clone();
            spawn_worker(app, worker_name, move |worker_app| {
                // The worker does the HTTP hop and NOTHING else.
                let response = run_menu_request(&worker_app, &path);
                let message = outcome(&response);
                on_main(&handle, move |app| {
                    log_line(&format!("menu: {detail}: {message}"));
                    // The action changed the harness's state, so the status label and the
                    // recent list both need re-reading. Asking for a rebuild re-runs
                    // `menu_plan` from the state the watcher will refresh, and the gate
                    // drops it if nothing moved.
                    request_rebuild(app, RebuildReason::StatusChange);
                    open_control_panel(app, panel, Some(message));
                });
            });
        }
    }
}

/// Performs a switch from the menu: decide, dispatch on a worker, report on main.
fn switch_version<R: Runtime>(app: &AppHandle<R>, version: String) {
    let (port, shell_error) = match app.try_state::<crate::SidecarState>() {
        Some(state) => (state.port_now(), state.error()),
        None => (None, None),
    };

    let dispatch = switch_dispatch(&version, port, shell_error.as_deref());
    let for_message = version.clone();
    run_menu_action(
        app,
        dispatch,
        PanelTab::Versions,
        "dsh-dock-menu-switch",
        format!("switching to v{version}"),
        move |response| switch_outcome_message(&for_message, response),
    );
}

/// Performs a stop from the menu.
fn stop_harness<R: Runtime>(app: &AppHandle<R>) {
    let dispatch = harness_action_dispatch(app, menu_routes::STOP, "stop the harness");
    run_menu_action(
        app,
        dispatch,
        PanelTab::Harness,
        "dsh-dock-menu-stop",
        "stopping the harness".to_owned(),
        harness_action_outcome,
    );
}

/// Performs a restart from the menu.
///
/// A restart is `stop` then `start` on the sidecar's own route, so this needs no
/// sequencing here even though the dashboard's button deliberately calls the two halves
/// separately to keep its own state in step - the sidecar's `/harness/restart` is
/// literally those two calls, and the menu has no per-half state to keep.
fn restart_harness<R: Runtime>(app: &AppHandle<R>) {
    let dispatch = harness_action_dispatch(app, menu_routes::RESTART, "restart the harness");
    run_menu_action(
        app,
        dispatch,
        PanelTab::Harness,
        "dsh-dock-menu-restart",
        "restarting the harness".to_owned(),
        harness_action_outcome,
    );
}

/// Reads the sidecar facts and decides, for a parameterless harness action.
fn harness_action_dispatch<R: Runtime>(
    app: &AppHandle<R>,
    route: &str,
    label: &str,
) -> SwitchDispatch {
    let (port, shell_error) = match app.try_state::<crate::SidecarState>() {
        Some(state) => (state.port_now(), state.error()),
        None => (None, None),
    };
    action_dispatch(route, label, port, shell_error.as_deref())
}

/// Turns a stop/restart response into the one line the user is shown.
///
/// PURE, so all three outcomes are testable without an app: the sidecar's own message
/// when it gave one, the shell error when the sidecar could not be reached, and an
/// explicit note when a 2xx arrived with no body to quote.
fn harness_action_outcome(response: &crate::ProxiedResponse) -> String {
    let sidecar_message = response
        .data
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(error) = response.error.as_deref() {
        return match response.shell_error.as_deref() {
            Some(shell) if !shell.trim().is_empty() => format!("{error} ({shell})"),
            _ => error.to_owned(),
        };
    }

    match sidecar_message {
        // The sidecar's own wording is more specific than anything the shell could
        // invent ("Harness stopped." vs "No running harness to stop."), so it is used
        // verbatim.
        Some(message) => message.to_owned(),
        None => match response.code {
            200..=299 => "The DSH-Dock core accepted the request, but returned no message.".to_owned(),
            _ => format!("The DSH-Dock core answered HTTP {} with no explanation.", response.code),
        },
    }
}

/// Turns a switch response into the one line the user is shown.
///
/// Split out and pure so the three outcomes - accepted, refused with a body, and
/// the sidecar being unreachable - are unit-testable without an app. The
/// distinction matters: "202 accepted" is not "switched", and a refusal carries the
/// sidecar's own explanation (another operation in flight, or the library locked by
/// a process outside this launcher).
fn switch_outcome_message(version: &str, response: &crate::ProxiedResponse) -> String {
    if let Some(error) = response.error.as_deref() {
        return match response.shell_error.as_deref() {
            Some(shell) if !shell.trim().is_empty() => {
                format!("Could not start switching to v{version}: {error} ({shell})")
            }
            _ => format!("Could not start switching to v{version}: {error}"),
        };
    }

    let sidecar_message = response
        .data
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match response.code {
        202 => format!(
            "Switching to v{version}. The harness stops and starts again, so this can take a few \
             minutes; the version list refreshes when it finishes."
        ),
        // 409 is the documented refusal (another operation in flight, or the
        // library locked). The sidecar's own wording is more specific than anything
        // the shell could invent, so it is used verbatim when present.
        _ => match sidecar_message {
            Some(message) => format!("Could not switch to v{version}: {message}"),
            None => format!(
                "Could not switch to v{version}: the DSH-Dock core answered HTTP {} with no \
                 explanation.",
                response.code
            ),
        },
    }
}

/// Runs `work` on a worker thread, so the main thread never performs I/O.
fn spawn_worker<R: Runtime, F>(app: &AppHandle<R>, name: &str, work: F)
where
    F: FnOnce(AppHandle<R>) + Send + 'static,
{
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || work(handle));

    if let Err(error) = spawned {
        log_line(&format!("menu: could not start a worker thread: {error}"));
    }
}

/// Persists the auto-update channel, rebuilds, and tells the settings UI.
fn set_auto_update_channel<R: Runtime>(app: &AppHandle<R>, channel: String) {
    let settings_state = app.state::<SettingsState>();

    match settings_state.set_auto_update_channel(&channel) {
        Ok(settings) => {
            log_line(&format!(
                "menu: auto-update channel set to {}",
                settings.auto_update_channel
            ));

            on_main(app, move |app| {
                if let Some(runtime) = app.try_state::<MenuRuntime>() {
                    runtime.apply_settings(&settings);
                }
                rebuild_menu(app, RebuildReason::SettingsChange);

                // Section 3.11 / Q53 step 4. Emitted to `main` ONLY: a broadcast
                // would push a DOM event into the harness page, which is the
                // opaque black box this launcher never touches.
                if let Err(error) =
                    app.emit_to(MAIN_WINDOW_LABEL, EVENT_SETTINGS_CHANGED, settings.clone())
                {
                    log_line(&format!(
                        "menu: could not emit {EVENT_SETTINGS_CHANGED}: {error}"
                    ));
                }
            });
        }
        Err(error) => {
            log_line(&format!("menu: refusing the channel change: {error}"));
            on_main(app, move |app| {
                open_control_panel(app, PanelTab::Settings, Some(error))
            });
        }
    }
}

/// Reports a placeholder action.
///
/// The log line comes first, then the control panel is brought forward with the
/// reason: an item that silently does nothing is worse than a disabled one, and
/// a disabled one is worse than one that explains itself.
fn notice<R: Runtime>(app: &AppHandle<R>, tab: PanelTab, message: String) {
    log_line(&format!("menu: {message}"));
    on_main(app, move |app| {
        open_control_panel(app, tab, Some(message))
    });
}

/// Brings the control panel forward and tells it which tab to reveal.
///
/// MAIN THREAD ONLY. Pure window management plus an event - no I/O.
fn open_control_panel<R: Runtime>(app: &AppHandle<R>, tab: PanelTab, message: Option<String>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log_line("menu: the control panel window is gone");
        return;
    };

    // Show before focus: a hidden or minimised window cannot take focus, and
    // "nothing happened" is the worst possible response to a click.
    for (what, result) in [
        ("show", window.show()),
        ("unminimize", window.unminimize()),
        ("focus", window.set_focus()),
    ] {
        match result {
            Ok(()) => log_line(&format!("menu: control panel {what} ok")),
            Err(error) => log_line(&format!("menu: could not {what} the control panel: {error}")),
        }
    }

    let payload = PanelOpenPayload { tab, message };
    if let Err(error) = app.emit_to(MAIN_WINDOW_LABEL, EVENT_PANEL_OPEN, payload) {
        log_line(&format!("menu: could not emit {EVENT_PANEL_OPEN}: {error}"));
    }
}

/// Opens `<data-dir>/logs` in the OS file manager.
///
/// NO SHELL INTERPOLATION: the path is launcher-owned (it comes from the shared
/// state-dir resolver) and is passed as a single argv entry to a fixed program,
/// with no shell in between. `CREATE_NO_WINDOW` is applied even though the opener
/// is itself a GUI program, because section 2.7's rule for every new spawn site
/// is unconditional.
fn open_logs_folder() -> Result<std::path::PathBuf, String> {
    let dir = settings::data_dir()
        .ok_or_else(|| {
            "the launcher data directory could not be resolved, so there is no logs folder to open"
                .to_owned()
        })?
        .join("logs");

    if !dir.is_dir() {
        return Err(format!(
            "the logs folder does not exist yet: {}",
            dir.display()
        ));
    }

    #[cfg(windows)]
    let command = {
        let mut command = Command::new("explorer");
        command.arg(&dir).creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("open");
        command.arg(&dir);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let command = {
        let mut command = Command::new("xdg-open");
        command.arg(&dir);
        command
    };

    let mut command = command;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match command.spawn() {
        Ok(_) => Ok(dir),
        Err(error) => Err(format!("could not open {}: {error}", dir.display())),
    }
}

/// Parses the poll interval, returning the value and a warning when the input was
/// rejected or clamped.
///
/// Never fails. A diagnostic knob must not be able to stop the watcher from
/// starting, and an absurd value must not turn the poll into a busy loop.
pub fn poll_interval_from(raw: Option<&str>) -> (Duration, Option<String>) {
    let Some(raw) = raw else {
        return (DEFAULT_POLL_INTERVAL, None);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (DEFAULT_POLL_INTERVAL, None);
    }

    match trimmed.parse::<u64>() {
        Ok(ms) if ms >= MIN_POLL_INTERVAL.as_millis() as u64 => (Duration::from_millis(ms), None),
        Ok(ms) => (
            MIN_POLL_INTERVAL,
            Some(format!(
                "{POLL_INTERVAL_ENV_VAR}={ms} is below the {}ms floor; using the floor",
                MIN_POLL_INTERVAL.as_millis()
            )),
        ),
        Err(_) => (
            DEFAULT_POLL_INTERVAL,
            Some(format!(
                "{POLL_INTERVAL_ENV_VAR}={raw:?} is not a number of milliseconds; using the \
                 {}ms default",
                DEFAULT_POLL_INTERVAL.as_millis()
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::SELECTABLE_CHANNELS;

    // --- helpers -----------------------------------------------------------

    fn state_for(scenario: &str) -> MenuState {
        dump_scenarios()
            .into_iter()
            .find(|(name, _)| *name == scenario)
            .map(|(_, state)| state)
            .unwrap_or_else(|| panic!("no scenario named {scenario}"))
    }

    /// Every top-level label, in order.
    fn top_labels(plan: &MenuPlan) -> Vec<&str> {
        plan.top_level
            .iter()
            .map(|node| match node {
                PlanNode::Submenu { label, .. } => label.as_str(),
                other => panic!("a top-level node that is not a submenu: {other:?}"),
            })
            .collect()
    }

    /// The children of the top-level submenu with this label.
    fn submenu<'a>(plan: &'a MenuPlan, label: &str) -> &'a [PlanNode] {
        plan.top_level
            .iter()
            .find_map(|node| match node {
                PlanNode::Submenu { label: found, items } if found == label => Some(items.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no submenu labelled {label}; found {:?}", top_labels(plan)))
    }

    /// The children of a nested submenu found anywhere in `nodes`.
    fn nested<'a>(nodes: &'a [PlanNode], label: &str) -> &'a [PlanNode] {
        find_nested(nodes, label)
            .unwrap_or_else(|| panic!("no nested submenu labelled {label} in {nodes:#?}"))
    }

    fn find_nested<'a>(nodes: &'a [PlanNode], label: &str) -> Option<&'a [PlanNode]> {
        for node in nodes {
            if let PlanNode::Submenu { label: found, items } = node {
                if found == label {
                    return Some(items.as_slice());
                }
                if let Some(found) = find_nested(items, label) {
                    return Some(found);
                }
            }
        }
        None
    }

    /// Visits every node, depth first.
    fn walk<'a>(nodes: &'a [PlanNode], visit: &mut impl FnMut(&'a PlanNode)) {
        for node in nodes {
            visit(node);
            if let PlanNode::Submenu { items, .. } = node {
                walk(items, visit);
            }
        }
    }

    fn walk_plan<'a>(plan: &'a MenuPlan, visit: &mut impl FnMut(&'a PlanNode)) {
        walk(&plan.top_level, visit);
    }

    /// Every dispatch id in the plan, depth first.
    fn ids(plan: &MenuPlan) -> Vec<String> {
        let mut found = Vec::new();
        walk_plan(plan, &mut |node| match node {
            PlanNode::Action { id, .. } | PlanNode::Check { id, .. } => found.push(id.clone()),
            _ => {}
        });
        found
    }

    fn find_by_id<'a>(plan: &'a MenuPlan, id: &str) -> Option<&'a PlanNode> {
        let mut found = None;
        walk_plan(plan, &mut |node| match node {
            PlanNode::Action { id: node_id, .. } | PlanNode::Check { id: node_id, .. }
                if node_id == id =>
            {
                found = Some(node)
            }
            _ => {}
        });
        found
    }

    fn node_label(node: &PlanNode) -> &str {
        match node {
            PlanNode::Action { label, .. }
            | PlanNode::Check { label, .. }
            | PlanNode::Label { label }
            | PlanNode::StatusLabel { label, .. }
            | PlanNode::Submenu { label, .. }
            | PlanNode::Predefined { label, .. } => label,
            PlanNode::Separator => "",
        }
    }

    fn every_platform() -> [TargetOs; 3] {
        TargetOs::ALL
    }

    // --- platform shape ----------------------------------------------------

    #[test]
    fn windows_and_linux_have_exactly_the_three_documented_top_level_menus() {
        // Section 3.8 and Q46: Harness | Dock | Settings, in that order.
        for target_os in [TargetOs::Windows, TargetOs::Linux] {
            let plan = menu_plan(&state_for("running"), target_os);
            assert_eq!(top_labels(&plan), vec!["Harness", "Dock", "Settings"], "{target_os:?}");
            assert_eq!(plan.target_os, target_os);
        }
    }

    #[test]
    fn macos_leads_with_the_application_menu_and_has_no_top_level_settings() {
        // macOS renders the FIRST submenu as the application menu, so `Harness`
        // cannot lead there; and Settings belongs inside it by convention.
        let plan = menu_plan(&state_for("running"), TargetOs::MacOs);

        assert_eq!(top_labels(&plan), vec!["DSH-Dock", "Harness", "Dock"]);
        assert!(
            !top_labels(&plan).contains(&"Settings"),
            "macOS must not have a separate top-level Settings menu"
        );
    }

    #[test]
    fn the_settings_action_appears_exactly_once_on_every_platform() {
        for target_os in every_platform() {
            let plan = menu_plan(&state_for("running"), target_os);
            let matches = ids(&plan).into_iter().filter(|id| id == ID_SETTINGS_OPEN).count();
            assert_eq!(matches, 1, "{target_os:?} has {matches} settings entries");
        }
    }

    #[test]
    fn about_appears_exactly_once_per_platform() {
        // The correction from the Step B review: one About per platform. In Dock
        // on Windows/Linux; in the application menu on macOS.
        for target_os in every_platform() {
            let plan = menu_plan(&state_for("running"), target_os);

            let mut about_nodes = Vec::new();
            walk_plan(&plan, &mut |node| {
                if let PlanNode::Predefined { name: PredefinedName::About, .. } = node {
                    about_nodes.push(node_label(node).to_owned());
                }
            });

            assert_eq!(about_nodes.len(), 1, "{target_os:?} has {about_nodes:?}");

            let in_dock = submenu(&plan, "Dock")
                .iter()
                .any(|node| matches!(node, PlanNode::Predefined { name: PredefinedName::About, .. }));
            assert_eq!(
                in_dock,
                target_os != TargetOs::MacOs,
                "{target_os:?}: About in Dock should be {}",
                target_os != TargetOs::MacOs
            );
        }
    }

    #[test]
    fn the_macos_application_menu_has_the_documented_order() {
        let plan = menu_plan(&state_for("running"), TargetOs::MacOs);
        let items = submenu(&plan, "DSH-Dock");

        let described: Vec<String> = items
            .iter()
            .map(|node| match node {
                PlanNode::Separator => "---".to_owned(),
                PlanNode::Predefined { name, .. } => format!("predefined:{name:?}"),
                PlanNode::Action { id, .. } => format!("action:{id}"),
                other => format!("unexpected:{other:?}"),
            })
            .collect();

        assert_eq!(
            described,
            vec![
                "predefined:About",
                "---",
                "action:settings.open",
                "---",
                "predefined:Hide",
                "predefined:HideOthers",
                "predefined:ShowAll",
                "---",
                "predefined:Quit",
            ]
        );
    }

    #[test]
    fn the_harness_menu_is_identical_on_all_three_platforms() {
        // Content parity where it matters: only the About/Settings placement is
        // allowed to differ, and neither of those is in the Harness menu.
        let state = state_for("running");
        let windows = menu_plan(&state, TargetOs::Windows);
        let macos = menu_plan(&state, TargetOs::MacOs);
        let linux = menu_plan(&state, TargetOs::Linux);

        assert_eq!(submenu(&windows, "Harness"), submenu(&macos, "Harness"));
        assert_eq!(submenu(&windows, "Harness"), submenu(&linux, "Harness"));
    }

    #[test]
    fn the_dock_menu_differs_only_by_about() {
        let state = state_for("running");
        let windows = submenu(&menu_plan(&state, TargetOs::Windows), "Dock").to_vec();
        let macos = submenu(&menu_plan(&state, TargetOs::MacOs), "Dock").to_vec();

        assert_eq!(windows.len(), macos.len() + 1, "macOS should drop exactly the About entry");
        assert_eq!(&windows[..macos.len()], macos.as_slice());
        assert!(matches!(
            windows.last(),
            Some(PlanNode::Predefined { name: PredefinedName::About, .. })
        ));
    }

    // --- section 3.8 structure --------------------------------------------

    #[test]
    fn the_harness_menu_matches_section_38_item_for_item() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = submenu(&plan, "Harness");

        // Status label, separator, Restart, Stop, Open Logs, separator,
        // Auto-update, Recent Versions, separator, Harness Update.
        assert_eq!(items.len(), 10, "{items:#?}");

        assert!(
            matches!(&items[0], PlanNode::StatusLabel { .. }),
            "the status label comes first"
        );
        assert!(matches!(items[1], PlanNode::Separator));
        assert_eq!(node_label(&items[2]), "Restart Harness");
        assert_eq!(node_label(&items[3]), "Stop Harness");
        assert_eq!(node_label(&items[4]), "Open Logs Folder");
        assert!(matches!(items[5], PlanNode::Separator));
        assert_eq!(node_label(&items[6]), "Auto-update");
        assert_eq!(node_label(&items[7]), "Recent Versions");
        assert!(matches!(items[8], PlanNode::Separator));
        assert_eq!(node_label(&items[9]), "Harness Update");
    }

    #[test]
    fn the_dock_menu_matches_section_38_item_for_item() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = submenu(&plan, "Dock");

        assert_eq!(items.len(), 5, "{items:#?}");
        assert_eq!(node_label(&items[0]), "Current version: 0.5.1");
        assert!(matches!(items[1], PlanNode::Separator));
        assert_eq!(node_label(&items[2]), "Dock Update");
        assert_eq!(node_label(&items[3]), "Show Control Panel");
        assert!(matches!(
            &items[4],
            PlanNode::Predefined { name: PredefinedName::About, .. }
        ));
    }

    #[test]
    fn the_settings_menu_opens_the_settings_tab() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = submenu(&plan, "Settings");

        assert_eq!(items.len(), 1, "{items:#?}");
        assert_eq!(node_label(&items[0]), "Settings…");
        assert_eq!(
            MenuAction::from_id(ID_SETTINGS_OPEN),
            Some(MenuAction::OpenControlPanel {
                tab: PanelTab::Settings
            })
        );
    }

    #[test]
    fn the_launcher_version_comes_from_the_state_not_a_constant() {
        // The version shown must be whatever the shell put in the state, so the
        // menu can never disagree with `Cargo.toml`.
        let state = MenuState {
            dsh_dock_version: "9.9.9".to_owned(),
            ..state_for("running")
        };

        let plan = menu_plan(&state, TargetOs::Windows);
        assert_eq!(node_label(&submenu(&plan, "Dock")[0]), "Current version: 9.9.9");
    }

    // --- the status label -------------------------------------------------

    #[test]
    fn the_status_label_covers_every_documented_state() {
        let label = |status: HarnessStatus, version: Option<&str>| {
            status_label(&MenuState {
                harness_status: status,
                harness_version: version.map(str::to_owned),
                ..MenuState::default()
            })
        };

        assert_eq!(label(HarnessStatus::Running, Some("0.1.5-rc.2")), "● Running · v0.1.5-rc.2");
        assert_eq!(label(HarnessStatus::Running, None), "● Running");
        assert_eq!(label(HarnessStatus::Running, Some("")), "● Running");
        assert_eq!(label(HarnessStatus::Stopped, None), "● Stopped");
        assert_eq!(label(HarnessStatus::Starting, None), "● Starting…");
        assert_eq!(label(HarnessStatus::Error, None), "● Error");
    }

    #[test]
    fn an_unavailable_sidecar_reads_as_stopped_rather_than_an_alarm() {
        // Micro-decision: the port normally arrives in well under a second, so a
        // menu that flashed `● Error` on every cold start would cry wolf. A real
        // shell failure arrives as `Error` instead.
        let unavailable = status_label(&MenuState {
            harness_status: HarnessStatus::Unavailable,
            ..MenuState::default()
        });
        let stopped = status_label(&MenuState {
            harness_status: HarnessStatus::Stopped,
            ..MenuState::default()
        });

        assert_eq!(unavailable, "● Stopped");
        assert_eq!(unavailable, stopped);
    }

    #[test]
    fn the_status_label_is_the_first_item_in_the_harness_menu() {
        // Section 3.8 places it above the first separator.
        for target_os in every_platform() {
            let plan = menu_plan(&state_for("running"), target_os);
            let first = &submenu(&plan, "Harness")[0];
            assert!(
                matches!(first, PlanNode::StatusLabel { .. }),
                "{target_os:?}: {first:?}"
            );
            assert_eq!(node_label(first), "● Running · v0.1.5-rc.2");
        }
    }

    #[test]
    fn an_error_state_keeps_the_documented_label_and_never_leaks_the_message() {
        // Section 3.8 fixes four status labels and native menus have no
        // tooltips, so the sidecar's message must NOT be smuggled into the menu:
        // it goes to the launcher log. This test pins that decision.
        let state = state_for("error");
        let message = state.last_error.clone().expect("the fixture has a message");

        let plan = menu_plan(&state, TargetOs::Windows);
        assert_eq!(node_label(&submenu(&plan, "Harness")[0]), "● Error");

        let mut leaked = Vec::new();
        walk_plan(&plan, &mut |node| {
            if node_label(node).contains("probe timed out") {
                leaked.push(node_label(node).to_owned());
            }
        });
        assert!(leaked.is_empty(), "the error text reached the menu: {leaked:?}");
        assert!(!message.is_empty());
    }

    // --- auto-update ------------------------------------------------------

    #[test]
    fn the_auto_update_submenu_has_the_four_documented_options_in_order() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Auto-update");

        assert_eq!(items.len(), 4, "{items:#?}");
        assert_eq!(node_label(&items[0]), "Stable only");
        assert_eq!(node_label(&items[1]), "RC only");
        assert_eq!(node_label(&items[2]), "Alpha only");
        assert_eq!(node_label(&items[3]), "All channels (newest)");

        for (index, channel) in ["stable", "rc", "alpha", "all"].iter().enumerate() {
            assert_eq!(ids_in(items)[index], format!("{ID_HARNESS_AUTO_UPDATE_PREFIX}{channel}"));
        }
    }

    /// Ids of one node slice, in order (no recursion).
    fn ids_in(nodes: &[PlanNode]) -> Vec<String> {
        nodes
            .iter()
            .filter_map(|node| match node {
                PlanNode::Action { id, .. } | PlanNode::Check { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    fn check_state(nodes: &[PlanNode], id: &str) -> (bool, bool) {
        for node in nodes {
            if let PlanNode::Check { id: node_id, checked, enabled, .. } = node {
                if node_id == id {
                    return (*checked, *enabled);
                }
            }
        }
        panic!("no check item {id} in {nodes:#?}");
    }

    #[test]
    fn stable_is_disabled_while_rc_and_alpha_and_all_are_enabled() {
        // Q48: the option stays visible but is not clickable while no stable
        // release exists. `All channels` never depends on one channel existing.
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Auto-update");

        assert_eq!(check_state(items, "harness.autoupdate.stable"), (false, false));
        assert_eq!(check_state(items, "harness.autoupdate.rc"), (true, true));
        assert_eq!(check_state(items, "harness.autoupdate.alpha"), (false, true));
        assert_eq!(check_state(items, "harness.autoupdate.all"), (false, true));
    }

    #[test]
    fn exactly_the_tracked_channel_is_checked() {
        for channel in SELECTABLE_CHANNELS {
            let state = MenuState {
                auto_update_channel: channel.to_owned(),
                ..state_for("running")
            };
            let plan = menu_plan(&state, TargetOs::Windows);
            let items = nested(submenu(&plan, "Harness"), "Auto-update");

            for option in ["stable", "rc", "alpha", "all"] {
                let id = format!("{ID_HARNESS_AUTO_UPDATE_PREFIX}{option}");
                let (checked, _) = check_state(items, &id);
                assert_eq!(
                    checked,
                    option == channel,
                    "channel {channel}: {option} checked={checked}"
                );
            }
        }
    }

    #[test]
    fn an_unrecognised_channel_leaves_every_option_unchecked() {
        // A hand-edited settings.json must not light up an arbitrary option.
        let state = MenuState {
            auto_update_channel: "beta".to_owned(),
            ..state_for("running")
        };
        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Auto-update");

        for option in ["stable", "rc", "alpha", "all"] {
            let (checked, _) = check_state(items, &format!("{ID_HARNESS_AUTO_UPDATE_PREFIX}{option}"));
            assert!(!checked, "{option} must not be checked for an unknown channel");
        }
    }

    #[test]
    fn stable_re_enables_itself_once_the_registry_has_one() {
        // The Q48 "re-enables when a stable release appears" half, without
        // changing any code path: availability is data.
        let state = MenuState {
            available_channels: vec!["stable".to_owned(), "rc".to_owned(), "alpha".to_owned()],
            auto_update_channel: "stable".to_owned(),
            ..state_for("running")
        };

        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Auto-update");

        assert_eq!(check_state(items, "harness.autoupdate.stable"), (true, true));
        assert_eq!(check_state(items, "harness.autoupdate.rc"), (false, true));
    }

    #[test]
    fn the_available_channel_constant_only_names_real_channels() {
        // A typo here would silently disable an option forever.
        for channel in AVAILABLE_CHANNELS {
            assert!(
                crate::settings::is_registry_channel(channel),
                "{channel} is not a registry channel"
            );
        }
        assert!(!AVAILABLE_CHANNELS.contains(&"all"), "`all` is a policy, not a channel");
    }

    // --- recent versions --------------------------------------------------

    #[test]
    fn recent_versions_contains_only_the_manager_entry_when_the_library_is_empty() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert_eq!(items.len(), 1, "{items:#?}");
        let show_all = &items[0];
        // PHASE 2B CHANGED THIS ASSERTION, and the change is the point of the phase.
        // It used to read "Show all versions… (Phase 2)" and require `enabled: false`,
        // because the version manager did not exist. It does now: the dashboard has a
        // version section and the sidecar serves `/versions/status` behind it. So the
        // label loses the phase suffix and the entry becomes clickable.
        assert_eq!(node_label(show_all), "Show all versions…");
        assert!(
            matches!(show_all, PlanNode::Action { enabled: true, .. }),
            "the version manager exists as of 2B, so the entry must be clickable: {show_all:?}"
        );
        assert!(
            matches!(
                show_all,
                PlanNode::Action {
                    action: MenuAction::OpenControlPanel {
                        tab: PanelTab::Versions
                    },
                    ..
                }
            ),
            "the entry must open the version section, not just the panel: {show_all:?}"
        );
        // An empty library still gets the entry: with nothing installed, "Show all
        // versions…" is the only route to the download UI.
        assert_eq!(
            state_for("running").recent_versions.len(),
            0,
            "this fixture is meant to have an empty library"
        );
    }

    #[test]
    fn recent_versions_shows_at_most_five_by_date_plus_the_manager_entry() {
        // The fixture has six versions; Q49 says show five.
        let state = state_for("recent-versions");
        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert_eq!(items.len(), 6, "five versions plus Show all versions…: {items:#?}");
        // PHASE 2B (Q100) REMOVED THE `(installed)` SUFFIX. The running version is now
        // marked with a native CHECK instead, and the suffix was noise: every entry in
        // this list is installed by definition, since it is enumerated from the library.
        assert_eq!(node_label(&items[0]), "v0.1.5-rc.2");
        assert_eq!(node_label(&items[1]), "v0.1.5-rc.1");
        assert_eq!(node_label(&items[4]), "v0.1.4-rc.2");
        assert_eq!(node_label(&items[5]), "Show all versions…");

        let labels: Vec<&str> = items.iter().map(node_label).collect();
        assert!(
            !labels.contains(&"v0.1.4-rc.1"),
            "the sixth version must be dropped: {labels:?}"
        );

        // THE STATE KEEPS ALL SIX even though the submenu shows five. That split is
        // what "Show all versions…" depends on: the manager must open with the sixth
        // version available, not merely the five the menu happened to display.
        assert_eq!(
            state.recent_versions.len(),
            6,
            "the state must keep the whole library: {:#?}",
            state.recent_versions
        );
    }

    #[test]
    fn the_running_version_is_checked_and_the_others_are_switch_actions() {
        let plan = menu_plan(&state_for("recent-versions"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        // THE RUNNING VERSION IS A CHECK ITEM, checked and not clickable (Q100).
        //
        // Disabled because switching to the version already running is NOT a no-op: the
        // sidecar stops the harness and starts it again, so a click would restart a
        // working harness for nothing. The tick is information.
        match &items[0] {
            PlanNode::Check {
                id,
                checked,
                enabled,
                action,
                ..
            } => {
                assert!(*checked, "the running version must be ticked: {id}");
                assert!(
                    !*enabled,
                    "and must not be clickable, or a click restarts a working harness: {id}"
                );
                // The id still round-trips: the tick must not cost the item its identity,
                // because `every_action_id_in_every_plan_round_trips` walks the plan and
                // a `Check` whose id did not parse would be a dead entry.
                assert_eq!(MenuAction::from_id(id).as_ref(), Some(action), "{id}");
            }
            other => panic!("expected a checked item for the running version, got {other:?}"),
        }

        // And EXACTLY ONE entry is checked, which is the assertion that catches a mark
        // applied to the wrong node.
        let checked: Vec<&str> = items
            .iter()
            .filter_map(|node| match node {
                PlanNode::Check { label, checked: true, .. } => Some(label.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(checked, vec!["v0.1.5-rc.2"], "exactly one tick: {checked:?}");

        for node in &items[1..5] {
            match node {
                PlanNode::Action { action, enabled, id, .. } => {
                    assert!(matches!(action, MenuAction::SwitchVersion(_)), "{node:?}");
                    assert!(enabled, "{node:?}");
                    assert!(MenuAction::from_id(id) == Some(action.clone()), "{node:?}");
                }
                other => panic!("expected a switch action, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_tick_moves_when_the_running_version_changes() {
        // The regression this catches: a mark computed from a field that never updates,
        // or baked into the label so it cannot move.
        let base = state_for("recent-versions");

        let running_rc2 = MenuState {
            installed_version: Some("0.1.5-rc.2".to_owned()),
            ..base.clone()
        };
        let running_rc1 = MenuState {
            installed_version: Some("0.1.5-rc.1".to_owned()),
            ..base.clone()
        };

        let checked_in = |state: &MenuState| -> Vec<String> {
            let plan = menu_plan(state, TargetOs::Windows);
            nested(submenu(&plan, "Harness"), "Recent Versions")
                .iter()
                .filter_map(|node| match node {
                    PlanNode::Check { label, checked: true, .. } => Some(label.clone()),
                    _ => None,
                })
                .collect()
        };

        assert_eq!(checked_in(&running_rc2), vec!["v0.1.5-rc.2".to_owned()]);
        assert_eq!(
            checked_in(&running_rc1),
            vec!["v0.1.5-rc.1".to_owned()],
            "the tick must follow the running version, not stay where it was"
        );

        // The version that LOST the tick must be clickable again - otherwise the mark
        // would move while the disabled state stayed behind.
        let plan = menu_plan(&running_rc1, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");
        assert!(
            items.iter().any(|node| matches!(
                node,
                PlanNode::Action { id, enabled: true, .. }
                    if id == "harness.recent.0.1.5-rc.2"
            )),
            "the previously-running version must be switchable again: {items:#?}"
        );
    }

    #[test]
    fn nothing_is_ticked_when_nothing_is_running() {
        let state = MenuState {
            harness_status: HarnessStatus::Stopped,
            harness_version: None,
            installed_version: None,
            ..state_for("recent-versions")
        };

        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert!(
            !items
                .iter()
                .any(|node| matches!(node, PlanNode::Check { checked: true, .. })),
            "a stopped harness must leave every entry unticked: {items:#?}"
        );
        // And every version is still clickable - with nothing running, nothing is
        // information-only.
        let ids: Vec<&str> = items
            .iter()
            .filter_map(|node| match node {
                PlanNode::Action { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        for version in [
            "0.1.5-rc.2",
            "0.1.5-rc.1",
            "0.1.5-alpha.2",
            "0.1.4-rc.3",
            "0.1.4-rc.2",
        ] {
            assert!(
                ids.contains(&format!("harness.recent.{version}").as_str()),
                "{version} must be switchable with nothing running: {ids:?}"
            );
        }
        assert!(
            ids.contains(&ID_HARNESS_SHOW_ALL_VERSIONS),
            "the manager entry must still be an action: {ids:?}"
        );
        assert_eq!(ids.len(), 6, "five versions plus the manager entry: {ids:?}");
    }

    #[test]
    fn a_running_version_outside_the_shown_five_ticks_nothing_but_stays_findable() {
        // Designated in the fixture: the running version has aged out of the five most
        // recent. There is no entry to tick, so nothing may appear ticked - a tick on a
        // DIFFERENT version would be a lie about which one is running.
        let state = state_for("recent-versions-installed-not-listed");
        assert_eq!(state.installed_version.as_deref(), Some("0.1.3-rc.1"));

        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert!(
            !items
                .iter()
                .any(|node| matches!(node, PlanNode::Check { checked: true, .. })),
            "nothing may be ticked when the running version is not listed: {items:#?}"
        );
        assert!(
            !items.iter().any(|node| node_label(node).contains("0.1.3")),
            "the running version must not be smuggled into the five: {items:#?}"
        );
    }

    #[test]
    fn an_installed_version_older_than_the_shown_five_is_reachable_only_by_the_manager() {
        // The real-world case: the active version has aged out of the five most
        // recent, so nothing is marked `(installed)` and the only route to it is
        // "Show all versions…".
        let state = state_for("recent-versions-installed-not-listed");
        assert_eq!(state.installed_version.as_deref(), Some("0.1.3-rc.1"));

        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert_eq!(items.len(), 6, "five versions plus the manager entry: {items:#?}");

        let labels: Vec<&str> = items.iter().map(node_label).collect();
        assert!(
            !labels.iter().any(|label| label.contains("(installed)")),
            "the installed version is not in the list, so nothing may be marked: {labels:?}"
        );
        assert!(
            !labels.iter().any(|label| label.contains("0.1.3")),
            "the installed version must not be smuggled in: {labels:?}"
        );

        // Every shown entry is a switch action, and the manager entry is the
        // only route to the version that is running.
        for node in &items[..5] {
            assert!(matches!(node, PlanNode::Action { enabled: true, .. }), "{node:?}");
        }
        assert_eq!(labels[5], "Show all versions…");
        assert!(matches!(
            &items[5],
            PlanNode::Action {
                action: MenuAction::OpenControlPanel { tab: PanelTab::Versions },
                enabled: true,
                ..
            }
        ));
    }

    #[test]
    fn an_installed_version_absent_from_the_list_marks_nothing() {
        let state = MenuState {
            installed_version: Some("0.1.3".to_owned()),
            ..state_for("recent-versions")
        };
        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        let labels: Vec<&str> = items.iter().map(node_label).collect();
        assert!(!labels.iter().any(|label| label.contains("(installed)")), "{labels:?}");
        assert!(matches!(&items[0], PlanNode::Action { .. }));
    }

    // --- ids and dispatch -------------------------------------------------

    #[test]
    fn every_action_id_in_every_plan_round_trips() {
        // The safety net for the click dispatcher: a typo in an id becomes a
        // failing test rather than a menu item that does nothing.
        for (scenario, state) in dump_scenarios() {
            for target_os in every_platform() {
                let plan = menu_plan(&state, target_os);
                walk_plan(&plan, &mut |node| {
                    if let PlanNode::Action { id, action, .. } | PlanNode::Check { id, action, .. } =
                        node
                    {
                        assert_eq!(
                            MenuAction::from_id(id).as_ref(),
                            Some(action),
                            "{scenario}/{target_os:?}: {id} did not round-trip"
                        );
                    }
                });
            }
        }
    }

    #[test]
    fn every_dispatch_id_is_unique_within_a_plan() {
        for (scenario, state) in dump_scenarios() {
            for target_os in every_platform() {
                let found = ids(&menu_plan(&state, target_os));
                let mut sorted = found.clone();
                sorted.sort();
                sorted.dedup();
                assert_eq!(
                    sorted.len(),
                    found.len(),
                    "{scenario}/{target_os:?}: duplicate ids in {found:?}"
                );
            }
        }
    }

    #[test]
    fn only_actionable_nodes_carry_ids_and_labels_never_do() {
        for target_os in every_platform() {
            let plan = menu_plan(&state_for("recent-versions"), target_os);
            walk_plan(&plan, &mut |node| match node {
                PlanNode::Action { id, .. } | PlanNode::Check { id, .. } => {
                    assert!(!id.is_empty(), "an actionable node without an id: {node:?}");
                }
                // The status line is the one exception, and only so the fast path
                // can find it again. It is disabled, so its id can never arrive in
                // a menu event.
                PlanNode::StatusLabel { id, .. } => {
                    assert_eq!(id, ID_HARNESS_STATUS, "the status id is contract");
                }
                PlanNode::Label { .. } | PlanNode::Separator | PlanNode::Submenu { .. }
                | PlanNode::Predefined { .. } => {}
            });
        }
    }

    // --- the status-label fast path ---------------------------------------

    #[test]
    fn an_unchanged_plan_is_not_a_change() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        assert_eq!(status_only_change(&plan, &plan), None);
    }

    #[test]
    fn a_status_only_change_is_detected_in_both_directions() {
        let running = menu_plan(&state_for("running"), TargetOs::Windows);
        let stopped = menu_plan(&state_for("stopped"), TargetOs::Windows);

        assert_eq!(
            status_only_change(&running, &stopped),
            Some("● Stopped".to_owned())
        );
        assert_eq!(
            status_only_change(&stopped, &running),
            Some("● Running · v0.1.5-rc.2".to_owned())
        );
    }

    #[test]
    fn a_version_appearing_is_also_status_only() {
        // The sidecar can report `running` before it knows the version, so this
        // transition happens on every real start.
        let without = menu_plan(&state_for("running-no-version"), TargetOs::Windows);
        let with = menu_plan(&state_for("running"), TargetOs::Windows);

        assert_eq!(
            status_only_change(&without, &with),
            Some("● Running · v0.1.5-rc.2".to_owned())
        );
    }

    #[test]
    fn anything_other_than_the_status_text_falls_back_to_a_rebuild() {
        // A tick mark moving: same structure, different checkbox.
        let rc = menu_plan(&state_for("running"), TargetOs::Windows);
        let alpha = menu_plan(
            &MenuState {
                auto_update_channel: "alpha".to_owned(),
                ..state_for("running")
            },
            TargetOs::Windows,
        );
        assert_eq!(status_only_change(&rc, &alpha), None);

        // A structural change: the version list gains entries.
        let populated = menu_plan(&state_for("recent-versions"), TargetOs::Windows);
        assert_eq!(status_only_change(&rc, &populated), None);

        // A different platform shape.
        let macos = menu_plan(&state_for("stopped"), TargetOs::MacOs);
        let windows = menu_plan(&state_for("stopped"), TargetOs::Windows);
        assert_eq!(status_only_change(&windows, &macos), None);
    }

    #[test]
    fn a_status_change_combined_with_anything_else_is_not_fast_pathed() {
        let before = state_for("running");
        let after = MenuState {
            auto_update_channel: "alpha".to_owned(),
            harness_status: HarnessStatus::Stopped,
            harness_version: None,
            ..state_for("running")
        };

        assert_eq!(
            status_only_change(
                &menu_plan(&before, TargetOs::Windows),
                &menu_plan(&after, TargetOs::Windows)
            ),
            None,
            "a label change plus a checkbox change must take the full rebuild"
        );
    }

    #[test]
    fn rewriting_the_status_text_touches_nothing_else() {
        let mut plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let before = plan.clone();

        assert!(set_status_label_in(&mut plan, "● Probe"));
        assert_eq!(status_label_in(&plan), Some("● Probe"));

        assert_eq!(status_only_change(&before, &plan), Some("● Probe".to_owned()));
        assert_eq!(plan.target_os, before.target_os);
        assert_eq!(submenu(&plan, "Harness").len(), submenu(&before, "Harness").len());
        assert_eq!(submenu(&plan, "Dock").len(), submenu(&before, "Dock").len());
    }

    #[test]
    fn predefined_items_are_not_ours_to_dispatch() {
        // The OS owns their behaviour and their ids; the dispatcher must ignore
        // anything it did not build.
        assert_eq!(MenuAction::from_id("about"), None);
        assert_eq!(MenuAction::from_id("quit"), None);
        assert_eq!(MenuAction::from_id("hide"), None);
        assert_eq!(MenuAction::from_id(""), None);
        assert_eq!(MenuAction::from_id("harness."), None);
        assert_eq!(MenuAction::from_id("harness.autoupdate."), None);
        assert_eq!(MenuAction::from_id("harness.autoupdate.beta"), None);
        assert_eq!(MenuAction::from_id("harness.recent."), None);
        assert_eq!(MenuAction::from_id("harness.restart.extra"), None);
        assert_eq!(MenuAction::from_id("dock.updates"), None);
    }

    #[test]
    fn the_action_ids_are_the_documented_contract_strings() {
        // These strings travel through the event loop; renaming one silently
        // would break a click.
        assert_eq!(MenuAction::RestartHarness.id(), "harness.restart");
        assert_eq!(MenuAction::StopHarness.id(), "harness.stop");
        assert_eq!(MenuAction::OpenLogsFolder.id(), "harness.openLogs");
        assert_eq!(MenuAction::HarnessUpdate.id(), "harness.update");
        assert_eq!(
            MenuAction::OpenControlPanel {
                tab: PanelTab::Versions
            }
            .id(),
            "harness.showAllVersions"
        );
        assert_eq!(MenuAction::DockUpdate.id(), "dock.update");
        assert_eq!(
            MenuAction::OpenControlPanel {
                tab: PanelTab::Harness
            }
            .id(),
            "dock.controlPanel"
        );
        assert_eq!(
            MenuAction::OpenControlPanel {
                tab: PanelTab::Settings
            }
            .id(),
            "settings.open"
        );
        assert_eq!(MenuAction::SetAutoUpdateChannel("alpha".to_owned()).id(), "harness.autoupdate.alpha");
        assert_eq!(MenuAction::SwitchVersion("0.1.5-rc.1".to_owned()).id(), "harness.recent.0.1.5-rc.1");
    }

    #[test]
    fn restart_stop_and_open_logs_are_always_clickable() {
        // Deliberate: section 3.8 lists them as plain actions, and the sidecar's
        // routes are idempotent. This test makes the choice explicit rather than
        // accidental, so a future "disable Stop while stopped" change is a
        // conscious edit.
        for status in [
            HarnessStatus::Running,
            HarnessStatus::Starting,
            HarnessStatus::Stopped,
            HarnessStatus::Error,
            HarnessStatus::Unavailable,
        ] {
            let state = MenuState {
                harness_status: status,
                ..state_for("running")
            };
            let plan = menu_plan(&state, TargetOs::Windows);

            for id in [ID_HARNESS_RESTART, ID_HARNESS_STOP, ID_HARNESS_OPEN_LOGS] {
                match find_by_id(&plan, id) {
                    Some(PlanNode::Action { enabled, .. }) => {
                        assert!(*enabled, "{id} disabled while {status:?}")
                    }
                    other => panic!("{id} is not an action: {other:?}"),
                }
            }
        }
    }

    // --- purity and the rebuild gate --------------------------------------

    #[test]
    fn the_plan_is_deterministic() {
        // Section 2.7: a rebuild happens only when the plan actually changes, so
        // the same state must always produce the same value.
        for (scenario, state) in dump_scenarios() {
            for target_os in every_platform() {
                assert_eq!(
                    menu_plan(&state, target_os),
                    menu_plan(&state, target_os),
                    "{scenario}/{target_os:?} is not deterministic"
                );
            }
        }
    }

    #[test]
    fn a_status_change_changes_the_plan_and_a_pid_change_does_not() {
        // The rebuild gate's two halves: the plan must react to what the menu
        // shows, and must NOT rebuild over values it does not render.
        let stopped = state_for("stopped");
        let running = state_for("running");
        assert_ne!(menu_plan(&stopped, TargetOs::Windows), menu_plan(&running, TargetOs::Windows));

        let other_pid = MenuState {
            harness_pid: Some(9999),
            ..running.clone()
        };
        assert_eq!(
            menu_plan(&running, TargetOs::Windows),
            menu_plan(&other_pid, TargetOs::Windows),
            "the pid is not rendered, so it must not trigger a rebuild"
        );
    }

    // --- the dump ---------------------------------------------------------

    #[test]
    fn the_dump_covers_every_scenario_on_every_platform() {
        let json = dump_json();
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(&json).expect("the dump must be valid JSON");

        let expected = dump_scenarios().len() * TargetOs::ALL.len();
        assert_eq!(entries.len(), expected, "expected {expected} entries");

        for (scenario, _) in dump_scenarios() {
            for target_os in TargetOs::ALL {
                assert!(
                    entries.iter().any(|entry| {
                        entry.get("scenario").and_then(|v| v.as_str()) == Some(scenario)
                            && entry.get("targetOs").and_then(|v| v.as_str())
                                == Some(target_os.as_name())
                    }),
                    "the dump is missing {scenario}/{target_os:?}"
                );
            }
        }
    }

    #[test]
    fn the_dump_carries_no_harness_token_and_no_url() {
        // The status payload's `url` holds the harness's signed token. The plan
        // has no url field by construction; this guards a future field being
        // added carelessly.
        let json = dump_json();

        assert!(!json.contains("token="), "the dump leaked a token");
        assert!(!json.contains("http://"), "the dump leaked a URL");
        assert!(!json.contains("127.0.0.1"), "the dump leaked a loopback address");
    }

    #[test]
    fn the_dump_round_trips_back_into_plans() {
        // The dump is what the PowerShell gate asserts against, so it must be
        // reconstructible rather than merely well-formed.
        let json = dump_json();
        let entries: Vec<serde_json::Value> = serde_json::from_str(&json).expect("valid JSON");

        for entry in entries {
            let plan: MenuPlan =
                serde_json::from_value(entry.get("plan").expect("a plan").clone())
                    .expect("the plan must deserialise");

            let state: MenuState =
                serde_json::from_value(entry.get("state").expect("a state").clone())
                    .expect("the state must deserialise");

            assert_eq!(plan, menu_plan(&state, plan.target_os));
        }
    }

    #[test]
    fn the_dump_includes_the_state_that_produced_each_plan() {
        // The dump is a review artifact: without the state, "why is this label
        // what it is" is unanswerable.
        let json = dump_json();
        assert!(json.contains("\"harnessStatus\""), "{json}");
        assert!(json.contains("\"lastError\""), "{json}");
    }

    // --- platform names ---------------------------------------------------

    #[test]
    fn the_platform_names_map_the_way_the_rest_of_the_project_spells_them() {
        assert_eq!(TargetOs::from_name("windows"), TargetOs::Windows);
        assert_eq!(TargetOs::from_name("win32"), TargetOs::Windows);
        assert_eq!(TargetOs::from_name("macos"), TargetOs::MacOs);
        assert_eq!(TargetOs::from_name("darwin"), TargetOs::MacOs);
        assert_eq!(TargetOs::from_name("linux"), TargetOs::Linux);
        // Section 2.9: anything else gets the in-window menu bar.
        assert_eq!(TargetOs::from_name("freebsd"), TargetOs::Linux);

        for target_os in TargetOs::ALL {
            assert_eq!(TargetOs::from_name(target_os.as_name()), target_os);
        }
        assert_eq!(TargetOs::current(), TargetOs::from_name(std::env::consts::OS));
    }

    #[test]
    fn the_default_state_is_honest_about_not_knowing_yet() {
        let state = MenuState::default();

        assert_eq!(state.harness_status, HarnessStatus::Unavailable);
        assert_eq!(state.harness_version, None);
        assert_eq!(state.dsh_dock_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(state.auto_update_channel, DEFAULT_CHANNEL);
        assert!(state.recent_versions.is_empty());
        assert_eq!(status_label(&state), "● Stopped");
    }

    // --- the tab hint ------------------------------------------------------

    #[test]
    fn every_control_panel_entry_carries_its_tab() {
        assert_eq!(
            MenuAction::from_id(ID_SETTINGS_OPEN).and_then(|action| action.panel_tab()),
            Some(PanelTab::Settings)
        );
        assert_eq!(
            MenuAction::from_id(ID_DOCK_CONTROL_PANEL).and_then(|action| action.panel_tab()),
            Some(PanelTab::Harness)
        );
        assert_eq!(
            MenuAction::from_id(ID_HARNESS_SHOW_ALL_VERSIONS).and_then(|action| action.panel_tab()),
            Some(PanelTab::Versions)
        );

        // And the tab travels nowhere else: the other actions do not open it.
        for id in [ID_HARNESS_RESTART, ID_HARNESS_STOP, ID_HARNESS_UPDATE, ID_DOCK_UPDATE] {
            assert_eq!(
                MenuAction::from_id(id).and_then(|action| action.panel_tab()),
                None,
                "{id} must not carry a panel tab"
            );
        }
    }

    #[test]
    fn the_three_tabs_are_distinct_and_keep_their_ids() {
        // The tab is part of the action's identity, so the three ids must map to
        // three DIFFERENT actions - not one action that lost its tab.
        let tabs = [
            (ID_SETTINGS_OPEN, PanelTab::Settings),
            (ID_DOCK_CONTROL_PANEL, PanelTab::Harness),
            (ID_HARNESS_SHOW_ALL_VERSIONS, PanelTab::Versions),
        ];

        let mut actions = Vec::new();
        for (id, tab) in tabs {
            let action = MenuAction::from_id(id).expect("a known id");
            assert_eq!(action.panel_tab(), Some(tab));
            assert_eq!(action.id(), id, "the tab must round-trip through the id");
            actions.push(action);
        }

        assert_eq!(actions.len(), 3);
        assert_ne!(actions[0], actions[1]);
        assert_ne!(actions[1], actions[2]);
        assert_eq!(PanelTab::Harness.as_str(), "harness");
        assert_eq!(PanelTab::Settings.as_str(), "settings");
        assert_eq!(PanelTab::Versions.as_str(), "versions");
    }

    #[test]
    fn the_plan_shows_which_tab_each_entry_opens() {
        // The dump is the review artifact, so the tab has to be visible in it.
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let json = serde_json::to_value(&plan).expect("the plan serialises");

        let mut tabs = Vec::new();
        fn collect(value: &serde_json::Value, tabs: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    if let Some(tab) = map
                        .get("openControlPanel")
                        .and_then(|panel| panel.get("tab"))
                        .and_then(|tab| tab.as_str())
                    {
                        tabs.push(tab.to_owned());
                    }
                    for nested in map.values() {
                        collect(nested, tabs);
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        collect(item, tabs);
                    }
                }
                _ => {}
            }
        }
        collect(&json, &mut tabs);

        tabs.sort();
        assert_eq!(tabs, vec!["harness", "settings", "versions"], "found {tabs:?}");
    }

    // --- the main-thread rule ---------------------------------------------

    #[test]
    fn only_the_actions_that_touch_the_world_use_a_worker() {
        // Step C, R1: menu events arrive on the main thread, which also pumps
        // both webviews. Anything that spawns a process, writes a file, or makes an HTTP
        // call must be moved to a worker, and the dispatcher's structure depends on this
        // list being exactly right.
        //
        // PHASE 2B (Q99) CHANGED THIS LIST. Restart, Stop and Switch now dispatch to the
        // sidecar from the shell - unconditionally, so a menu click works with the
        // dashboard closed - which makes all three HTTP calls and therefore all three
        // worker actions. The earlier version of this test expected exactly two workers
        // precisely BECAUSE the harness actions went through the dashboard; that is the
        // assumption the acceptance run disproved.
        let actions = vec![
            MenuAction::RestartHarness,
            MenuAction::StopHarness,
            MenuAction::OpenLogsFolder,
            MenuAction::SetAutoUpdateChannel("alpha".to_owned()),
            MenuAction::SwitchVersion("0.1.5-rc.1".to_owned()),
            MenuAction::OpenControlPanel {
                tab: PanelTab::Harness,
            },
            MenuAction::OpenControlPanel {
                tab: PanelTab::Settings,
            },
            MenuAction::OpenControlPanel {
                tab: PanelTab::Versions,
            },
            MenuAction::HarnessUpdate,
            MenuAction::DockUpdate,
        ];

        for action in &actions {
            let expected_worker = matches!(
                action,
                MenuAction::OpenLogsFolder
                    | MenuAction::SetAutoUpdateChannel(_)
                    // Q99: the three harness actions reach the sidecar over HTTP.
                    | MenuAction::RestartHarness
                    | MenuAction::StopHarness
                    | MenuAction::SwitchVersion(_)
            );
            assert_eq!(
                action.needs_worker(),
                expected_worker,
                "{action:?} has the wrong threading classification"
            );
        }

        // Exactly five worker actions: the three harness actions, the logs spawn, and
        // the settings write.
        let workers: Vec<&MenuAction> =
            actions.iter().filter(|action| action.needs_worker()).collect();
        assert_eq!(workers.len(), 5, "{workers:?}");

        // And the ones that must stay on the main thread are window management alone.
        for action in &actions {
            if matches!(action, MenuAction::OpenControlPanel { .. }) {
                assert!(
                    !action.needs_worker(),
                    "{action:?} is window management and must stay main-thread"
                );
            }
        }
    }

    // --- the dashboard action channel -------------------------------------

    #[test]
    fn the_dashboard_action_tokens_are_the_contract() {
        // These strings are what `App.svelte` switches on. Renaming one silently
        // would make a menu item do nothing.
        assert_eq!(DashboardAction::Start.as_str(), "start");
        assert_eq!(DashboardAction::Stop.as_str(), "stop");
        assert_eq!(DashboardAction::Restart.as_str(), "restart");
        assert_eq!(DashboardAction::Refresh.as_str(), "refresh");
        assert_eq!(DashboardAction::OpenLogs.as_str(), "open-logs");
    }

    #[test]
    fn the_action_payload_is_an_object_with_one_token() {
        // The dashboard reads `event.payload.action`.
        let json = serde_json::to_value(MenuActionRequest {
            action: DashboardAction::Stop,
        })
        .expect("the payload serialises");

        assert_eq!(json, serde_json::json!({ "action": "stop" }));
    }

    #[test]
    fn the_harness_actions_dispatch_sidecar_side_rather_than_through_the_dashboard() {
        // Q99 REPLACED THE EARLIER RULE HERE, and this test is the record of it.
        //
        // The previous version asserted the opposite - that Restart and Stop were
        // FORWARDED to the dashboard and therefore needed no worker. That was correct
        // while the dashboard was assumed to be open. The acceptance run showed the cost:
        // with the dashboard closed, a menu Stop or Restart logged "could not deliver"
        // and did nothing at all.
        //
        // Now all three harness actions reach the sidecar directly, so all three are
        // worker actions. `needs_worker` is the test seam for exactly this classification.
        for id in [ID_HARNESS_RESTART, ID_HARNESS_STOP] {
            let action = MenuAction::from_id(id).expect("a known id");
            assert!(
                action.needs_worker(),
                "{id} performs HTTP to the sidecar now, so it must run on a worker"
            );
        }
        assert!(
            MenuAction::SwitchVersion("0.2.0-rc.2".to_owned()).needs_worker(),
            "the switch has always been a worker action"
        );

        // The two single-argument forms are classified by their payload, so a version
        // that is not a version is still classified the same way - `needs_worker` is
        // about the KIND of work, not about the argument's validity.
        assert!(MenuAction::SetAutoUpdateChannel("rc".to_owned()).needs_worker());
        assert!(MenuAction::OpenLogsFolder.needs_worker());

        // And the actions that genuinely are main-thread-only stay that way.
        for action in [
            MenuAction::OpenControlPanel { tab: PanelTab::Harness },
            MenuAction::HarnessUpdate,
            MenuAction::DockUpdate,
        ] {
            assert!(!action.needs_worker(), "{action:?} must stay on the main thread");
        }
    }

    #[test]
    fn only_open_logs_is_still_forwarded_to_the_dashboard() {
        // `deliver()` survives for the one action that genuinely belongs to the
        // dashboard's own surface: revealing the logs folder is emitted for consistency,
        // but the shell performs it too (Q58), so it has no dashboard state to keep in
        // step. Every HARNESS action has left this path.
        let dispatcher = production_function("handle_menu_event");
        let delivered: Vec<&str> = dispatcher
            .lines()
            .filter(|line| line.contains("deliver("))
            .map(str::trim)
            .collect();

        assert_eq!(
            delivered.len(),
            1,
            "exactly one action may still go through the dashboard: {delivered:?}"
        );
        assert!(
            delivered[0].contains("OpenLogs"),
            "and it must be OpenLogs: {delivered:?}"
        );
    }

    // --- Q99: the three harness actions dispatch sidecar-side -----------------

    /// The body of a named function in the non-test half of `menu.rs`.
    ///
    /// Used by the worker-boundary tests, which have to inspect the shape of the
    /// dispatch rather than run it: `spawn_worker` needs a live `AppHandle`, and the
    /// property under test ("this code never touches the menu") is a property of the
    /// SOURCE, not of a value it returns.
    fn production_function(name: &str) -> String {
        let source = include_str!("menu.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("menu.rs has a non-test section");
        let start = production
            .find(&format!("fn {name}<"))
            .or_else(|| production.find(&format!("fn {name}(")))
            .unwrap_or_else(|| panic!("function {name} exists"));
        let rest = &production[start..];
        let end = rest.find("\n}\n").unwrap_or(rest.len());
        rest[..end].to_owned()
    }

    /// Every menu-touching or main-thread-only call in `menu.rs`, by name.
    ///
    /// A worker calling ANY of these either silently does nothing or panics, which is
    /// the rule section 2.8.3 states in both directions. Listed in one place so a new
    /// main-thread helper has to be considered here too.
    const MENU_ONLY_CALLS: [&str; 6] = [
        "set_menu",
        "clear_welcome_menu",
        "request_rebuild",
        "open_control_panel",
        "on_main",
        "installed_item",
    ];

    #[test]
    fn the_worker_hop_touches_no_menu_and_only_makes_the_request() {
        // THE BOUNDARY, PINNED BY SOURCE SHAPE. Everything inside the closure
        // `spawn_worker` is handed runs OFF the main thread, so the hop is allowed to do
        // exactly one thing.
        let hop = production_function("run_menu_request");
        assert!(
            hop.contains("proxy_control_app"),
            "the worker hop must perform the HTTP call: {hop}"
        );
        for forbidden in MENU_ONLY_CALLS {
            assert!(
                !hop.contains(forbidden),
                "the worker hop must not call {forbidden}: {hop}"
            );
        }
    }

    #[test]
    fn every_dispatched_action_marshals_its_result_back_to_the_main_thread() {
        // The complement: the worker does the I/O, and everything VISIBLE happens inside
        // `on_main`. Without this, a successful action would produce no visible change at
        // all - the failure mode the whole Q74/Q99 design exists to avoid.
        let shared = production_function("run_menu_action");
        for required in ["spawn_worker", "run_menu_request", "on_main", "request_rebuild"] {
            assert!(
                shared.contains(required),
                "the shared dispatch must call {required}: {shared}"
            );
        }
        assert!(
            shared.contains("SwitchDispatch::Unavailable"),
            "and it must handle the refusal branch: {shared}"
        );
        // The main-thread work must be INSIDE the marshalled closure, not before it: a
        // `request_rebuild` outside `on_main` would touch the menu from the worker.
        let marshal = shared.find("on_main(").expect("on_main is called");
        let rebuild = shared.find("request_rebuild").expect("request_rebuild is called");
        assert!(
            rebuild > marshal,
            "the rebuild must be inside the marshalled closure: {shared}"
        );
    }

    #[test]
    fn stop_dispatches_to_the_sidecar_route_without_the_dashboard() {
        // 1a: the decision.
        assert_eq!(menu_routes::STOP, "/harness/stop");
        assert_eq!(
            action_dispatch(menu_routes::STOP, "stop the harness", Some(54321), None),
            SwitchDispatch::Dispatch("/harness/stop".to_owned()),
        );

        let refused = action_dispatch(menu_routes::STOP, "stop the harness", None, None);
        match refused {
            SwitchDispatch::Unavailable(message) => {
                assert!(message.contains("stop the harness"), "{message}");
                assert!(message.contains("not reported a port yet"), "{message}");
            }
            other => panic!("a missing port must refuse: {other:?}"),
        }

        // 1b: the boundary. Stop goes through the shared dispatch rather than spawning its
        // own worker, so there is ONE place that touches the menu.
        let body = production_function("stop_harness");
        assert!(body.contains("run_menu_action"), "{body}");
        assert!(body.contains("menu_routes::STOP"), "{body}");
        for forbidden in ["spawn_worker", "set_menu", "run_menu_request"] {
            assert!(
                !body.contains(forbidden),
                "stop_harness must delegate {forbidden} to the shared helpers: {body}"
            );
        }
    }

    #[test]
    fn restart_dispatches_to_the_sidecar_route_without_the_dashboard() {
        assert_eq!(menu_routes::RESTART, "/harness/restart");
        assert_eq!(
            action_dispatch(menu_routes::RESTART, "restart the harness", Some(54321), None),
            SwitchDispatch::Dispatch("/harness/restart".to_owned()),
        );

        let refused = action_dispatch(
            menu_routes::RESTART,
            "restart the harness",
            None,
            Some("Could not find sidecar/index.js"),
        );
        match refused {
            SwitchDispatch::Unavailable(message) => {
                assert!(message.contains("restart the harness"), "{message}");
                assert!(
                    message.contains("Could not find sidecar/index.js"),
                    "the shell's real reason must be shown: {message}"
                );
            }
            other => panic!("a recorded shell error must refuse: {other:?}"),
        }

        let body = production_function("restart_harness");
        assert!(body.contains("run_menu_action"), "{body}");
        assert!(body.contains("menu_routes::RESTART"), "{body}");
        for forbidden in ["spawn_worker", "set_menu", "run_menu_request"] {
            assert!(
                !body.contains(forbidden),
                "restart_harness must delegate {forbidden} to the shared helpers: {body}"
            );
        }
    }

    #[test]
    fn switch_dispatches_to_the_version_route_without_the_dashboard() {
        assert_eq!(
            switch_dispatch("0.2.0-rc.2", Some(54321), None),
            SwitchDispatch::Dispatch("/versions/switch?version=0.2.0-rc.2".to_owned()),
        );

        // The switch keeps ONE thing the other two do not have: the version-name gate.
        match switch_dispatch("next", Some(54321), None) {
            SwitchDispatch::Unavailable(message) => {
                assert!(message.contains("not an exact version"), "{message}");
            }
            other => panic!("a dist-tag must be refused before any request: {other:?}"),
        }

        let body = production_function("switch_version");
        assert!(body.contains("run_menu_action"), "{body}");
        assert!(body.contains("switch_dispatch"), "{body}");
        for forbidden in ["spawn_worker", "set_menu", "run_menu_request"] {
            assert!(
                !body.contains(forbidden),
                "switch_version must delegate {forbidden} to the shared helpers: {body}"
            );
        }
    }

    #[test]
    fn the_harness_action_outcome_prefers_the_sidecars_own_wording() {
        // Pure, so all the shapes are testable without an app. The sidecar's message is
        // more specific than anything the shell could invent ("Harness stopped." vs "No
        // running harness to stop."), so it is used verbatim.
        let stopped = crate::ProxiedResponse {
            code: 200,
            data: serde_json::json!({ "status": "stopped", "message": "Harness stopped." }),
            error: None,
            shell_error: None,
        };
        assert_eq!(harness_action_outcome(&stopped), "Harness stopped.");

        let noop = crate::ProxiedResponse {
            code: 200,
            data: serde_json::json!({ "status": "stopped", "message": "No running harness to stop." }),
            error: None,
            shell_error: None,
        };
        assert_eq!(harness_action_outcome(&noop), "No running harness to stop.");

        let unreachable = crate::ProxiedResponse {
            code: 0,
            data: serde_json::Value::Null,
            error: Some("Could not reach the DSH-Dock core on 127.0.0.1:54321".to_owned()),
            shell_error: Some("Could not find sidecar/index.js".to_owned()),
        };
        let message = harness_action_outcome(&unreachable);
        assert!(message.contains("Could not reach the DSH-Dock core"), "{message}");
        assert!(message.contains("Could not find sidecar/index.js"), "{message}");

        // A 2xx with no body must still say something, rather than producing an empty
        // sentence in a dialog.
        let silent = crate::ProxiedResponse {
            code: 200,
            data: serde_json::Value::Null,
            error: None,
            shell_error: None,
        };
        assert!(!harness_action_outcome(&silent).is_empty());
        let unexplained = crate::ProxiedResponse {
            code: 500,
            data: serde_json::Value::Null,
            error: None,
            shell_error: None,
        };
        assert!(harness_action_outcome(&unexplained).contains("HTTP 500"));
    }

    // --- reading the harness status ---------------------------------------

    #[test]
    fn a_status_payload_maps_onto_a_snapshot() {
        let payload = serde_json::json!({
            "status": "running",
            "version": "0.1.5-rc.2",
            "pid": 4242,
            "url": "http://127.0.0.1:60555/?token=SECRET",
            "lastError": null,
            "message": null
        });

        let snapshot = snapshot_from_status_payload(&payload);

        assert_eq!(snapshot.status, HarnessStatus::Running);
        assert_eq!(snapshot.version.as_deref(), Some("0.1.5-rc.2"));
        assert_eq!(snapshot.pid, Some(4242));
        assert_eq!(snapshot.last_error, None);
        // The URL is never carried: the snapshot has nowhere to put it, which is
        // what keeps the token out of the menu and out of the log.
        assert!(!format!("{snapshot:?}").contains("SECRET"));
    }

    #[test]
    fn every_lifecycle_state_maps_and_anything_else_admits_ignorance() {
        let map = |status: &str| {
            snapshot_from_status_payload(&serde_json::json!({ "status": status })).status
        };

        assert_eq!(map("running"), HarnessStatus::Running);
        assert_eq!(map("starting"), HarnessStatus::Starting);
        assert_eq!(map("stopped"), HarnessStatus::Stopped);
        assert_eq!(map("error"), HarnessStatus::Error);

        // An unknown or missing state must not be guessed at.
        assert_eq!(map("warming-up"), HarnessStatus::Unavailable);
        assert_eq!(map(""), HarnessStatus::Unavailable);
        assert_eq!(
            snapshot_from_status_payload(&serde_json::json!({})).status,
            HarnessStatus::Unavailable
        );
        assert_eq!(
            snapshot_from_status_payload(&serde_json::Value::Null).status,
            HarnessStatus::Unavailable
        );
        assert_eq!(
            snapshot_from_status_payload(&serde_json::json!("running")).status,
            HarnessStatus::Unavailable
        );
    }

    #[test]
    fn a_degenerate_version_or_pid_is_treated_as_unknown() {
        // "● Running · v" and "pid 0" would both be lies; unknown is the truth.
        let blank = snapshot_from_status_payload(&serde_json::json!({
            "status": "running", "version": "   ", "pid": 0
        }));
        assert_eq!(blank.version, None);
        assert_eq!(blank.pid, None);
        assert_eq!(status_label(&MenuState {
            harness_status: blank.status,
            harness_version: blank.version.clone(),
            ..MenuState::default()
        }), "● Running");

        for pid in [serde_json::json!("4242"), serde_json::json!(-1), serde_json::json!(4294967296u64), serde_json::json!(null)] {
            let snapshot = snapshot_from_status_payload(&serde_json::json!({
                "status": "running", "pid": pid
            }));
            assert_eq!(snapshot.pid, None, "pid {pid} should be unknown");
        }
    }

    #[test]
    fn the_error_text_is_picked_up_from_last_error_or_the_message() {
        let explicit = snapshot_from_status_payload(&serde_json::json!({
            "status": "error", "lastError": "the recorded harness is not answering"
        }));
        assert_eq!(explicit.last_error.as_deref(), Some("the recorded harness is not answering"));

        let fallback = snapshot_from_status_payload(&serde_json::json!({
            "status": "error", "lastError": null, "message": "Stopping the harness..."
        }));
        assert_eq!(fallback.last_error.as_deref(), Some("Stopping the harness..."));

        let neither = snapshot_from_status_payload(&serde_json::json!({ "status": "error" }));
        assert_eq!(neither.last_error, None);
    }

    #[test]
    fn an_unavailable_sidecar_is_only_an_error_when_something_actually_failed() {
        // The micro-decision's other half: no port and no reason yet is "we have
        // not heard", not "something is broken".
        let quiet = snapshot_unavailable(None);
        assert_eq!(quiet.status, HarnessStatus::Unavailable);
        assert_eq!(quiet.last_error, None);

        let blank = snapshot_unavailable(Some("   "));
        assert_eq!(blank.status, HarnessStatus::Unavailable);

        let failed = snapshot_unavailable(Some("Could not find sidecar/index.js"));
        assert_eq!(failed.status, HarnessStatus::Error);
        assert_eq!(failed.last_error.as_deref(), Some("Could not find sidecar/index.js"));
    }

    // --- the menu runtime and the rebuild gate ----------------------------

    #[test]
    fn the_runtime_reports_only_real_state_changes() {
        let runtime = MenuRuntime::new(MenuState::default());

        assert_eq!(runtime.last_installed(), None);

        let snapshot = HarnessSnapshot {
            status: HarnessStatus::Running,
            version: Some("0.1.5-rc.2".to_owned()),
            pid: Some(4242),
            last_error: None,
            recent_versions: Vec::new(),
        };

        assert!(runtime.update_harness(&snapshot), "a first observation is a change");
        assert!(!runtime.update_harness(&snapshot), "the same facts are not a change");

        // The pid is not rendered, but the state still records it - the rebuild
        // gate, not this method, is what prevents a needless rebuild.
        let moved_pid = HarnessSnapshot {
            pid: Some(9999),
            ..snapshot.clone()
        };
        assert!(runtime.update_harness(&moved_pid));
        assert_eq!(runtime.snapshot().harness_pid, Some(9999));

        let stopped = HarnessSnapshot {
            status: HarnessStatus::Stopped,
            version: None,
            pid: None,
            last_error: None,
            recent_versions: Vec::new(),
        };
        assert!(runtime.update_harness(&stopped));
        assert_eq!(runtime.snapshot().harness_status, HarnessStatus::Stopped);
    }

    #[test]
    fn the_runtime_tracks_the_channel_but_not_the_rest_of_the_settings() {
        let runtime = MenuRuntime::new(MenuState::default());

        let settings = Settings {
            auto_update_channel: "rc".to_owned(),
            ..Settings::default()
        };
        assert!(!runtime.apply_settings(&settings), "rc is already the default");

        let alpha = Settings {
            auto_update_channel: "alpha".to_owned(),
            ..Settings::default()
        };
        assert!(runtime.apply_settings(&alpha));
        assert_eq!(runtime.snapshot().auto_update_channel, "alpha");

        // A settings field the menu does not render must not churn the channel.
        let other = Settings {
            auto_update_channel: "alpha".to_owned(),
            cache_limit: 3,
            ..Settings::default()
        };
        assert!(!runtime.apply_settings(&other));
    }

    #[test]
    fn the_installed_plan_is_what_the_gate_compares() {
        let runtime = MenuRuntime::new(state_for("running"));
        assert_eq!(runtime.last_installed(), None);

        let plan = menu_plan(&runtime.snapshot(), TargetOs::Windows);
        assert!(runtime.last_installed().as_ref() != Some(&plan));
        runtime.remember_installed(plan.clone());
        assert_eq!(runtime.last_installed(), Some(plan));
    }

    #[test]
    fn the_runtime_state_can_be_shared_across_threads() {
        // `MenuRuntime` is Tauri managed state and is touched from the watcher
        // thread, the IPC thread and click handlers.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MenuRuntime>();
    }

    // --- the poll interval -------------------------------------------------

    #[test]
    fn the_poll_interval_defaults_to_five_seconds() {
        assert_eq!(poll_interval_from(None).0, Duration::from_secs(5));
        assert_eq!(poll_interval_from(Some("")).0, Duration::from_secs(5));
        assert_eq!(poll_interval_from(Some("   ")).0, Duration::from_secs(5));
        assert!(poll_interval_from(None).1.is_none());
    }

    #[test]
    fn the_poll_interval_honours_a_sane_override() {
        assert_eq!(poll_interval_from(Some("1000")).0, Duration::from_millis(1000));
        assert_eq!(poll_interval_from(Some(" 250 ")).0, Duration::from_millis(250));
        assert!(poll_interval_from(Some("1000")).1.is_none());
    }

    #[test]
    fn an_absurd_poll_interval_is_clamped_or_defaulted_with_a_warning() {
        // A diagnostic knob must not be able to busy-loop the watcher or stop it.
        let (clamped, warning) = poll_interval_from(Some("1"));
        assert_eq!(clamped, Duration::from_millis(100));
        assert!(warning.is_some(), "the clamp must be reported");

        let (zero, warning) = poll_interval_from(Some("0"));
        assert_eq!(zero, Duration::from_millis(100));
        assert!(warning.is_some());

        let (default, warning) = poll_interval_from(Some("soon"));
        assert_eq!(default, Duration::from_secs(5));
        assert!(warning.is_some(), "an unparseable value must be reported");

        let (negative, warning) = poll_interval_from(Some("-100"));
        assert_eq!(negative, Duration::from_secs(5));
        assert!(warning.is_some());
    }

    // --- Phase 2B: the version list, and the switch the menu can start --------

    #[test]
    fn the_library_guard_compares_content_not_the_array_identity() {
        let runtime = MenuRuntime::new(MenuState::default());

        let list = vec![
            RecentVersion {
                version: "0.2.0-rc.2".to_owned(),
                installed_at: Some("2026-10-06T18:37:06.147Z".to_owned()),
            },
            RecentVersion {
                version: "0.2.0-rc.1".to_owned(),
                installed_at: Some("2026-10-06T18:36:02.227Z".to_owned()),
            },
        ];

        let snapshot = HarnessSnapshot {
            status: HarnessStatus::Stopped,
            version: None,
            pid: None,
            last_error: None,
            recent_versions: list.clone(),
        };

        assert!(runtime.update_library(&snapshot), "the first list is a change");

        // THE POINT OF THIS TEST. The payload is rebuilt on every 5s poll, so in
        // production this is a FRESH Vec with equal contents. A reference or pointer
        // comparison would report a change every poll and trigger a full structural
        // rebuild (~37 ms) forever.
        let rebuilt = HarnessSnapshot {
            recent_versions: list.clone(),
            ..snapshot.clone()
        };
        assert!(
            !runtime.update_library(&rebuilt),
            "an equal list in a DIFFERENT Vec must not count as a change"
        );

        // An entry added, removed, or REORDERED is a change: order is what the
        // submenu renders, so a reordering genuinely changes the menu.
        let mut extra = list.clone();
        extra.push(RecentVersion::bare("0.1.9"));
        assert!(runtime.update_library(&HarnessSnapshot {
            recent_versions: extra,
            ..snapshot.clone()
        }));

        let mut reordered = list.clone();
        reordered.reverse();
        assert!(
            runtime.update_library(&HarnessSnapshot {
                recent_versions: reordered,
                ..snapshot.clone()
            }),
            "a reordering changes what the submenu shows"
        );

        // And back to the original, so the guard is not sticky in one direction only.
        assert!(runtime.update_library(&snapshot));
    }

    #[test]
    fn a_date_only_change_does_not_force_a_rebuild() {
        // The second half of the same concern. `installed_at` is NOT rendered by the
        // submenu, so a catalogue rewrite that moved dates without moving the list
        // must not cost a 37 ms structural rebuild for a menu that looks identical.
        let runtime = MenuRuntime::new(MenuState::default());

        let with_old_dates = HarnessSnapshot {
            status: HarnessStatus::Stopped,
            version: None,
            pid: None,
            last_error: None,
            recent_versions: vec![RecentVersion {
                version: "0.2.0-rc.2".to_owned(),
                installed_at: Some("2026-09-29T09:56:27.792Z".to_owned()),
            }],
        };
        assert!(runtime.update_library(&with_old_dates));

        let with_new_dates = HarnessSnapshot {
            recent_versions: vec![RecentVersion {
                version: "0.2.0-rc.2".to_owned(),
                installed_at: Some("2026-10-07T00:00:00.000Z".to_owned()),
            }],
            ..with_old_dates.clone()
        };
        assert!(
            !runtime.update_library(&with_new_dates),
            "a date-only change is not visible in the menu, so it must not rebuild"
        );
    }

    #[test]
    fn update_snapshot_applies_both_guards_even_when_only_one_moved() {
        // The failure this prevents: a caller using `update_harness` alone would miss
        // a library change entirely - the submenu would stay stale with no log line,
        // which is 2B's version of the "computed but never applied" bug.
        let runtime = MenuRuntime::new(MenuState::default());

        let baseline = HarnessSnapshot {
            status: HarnessStatus::Stopped,
            version: None,
            pid: None,
            last_error: None,
            recent_versions: Vec::new(),
        };
        assert!(runtime.update_snapshot(&baseline), "the first snapshot is a change");
        assert!(!runtime.update_snapshot(&baseline), "the same snapshot is not a change");

        // A library change with NO harness change.
        let library_moved = HarnessSnapshot {
            recent_versions: vec![RecentVersion::bare("0.2.0-rc.2")],
            ..baseline.clone()
        };
        assert!(
            runtime.update_snapshot(&library_moved),
            "a library-only change must be reported"
        );
        assert_eq!(runtime.snapshot().recent_versions.len(), 1);

        // Both moving at once: neither update may be skipped by short-circuiting.
        let both = HarnessSnapshot {
            status: HarnessStatus::Running,
            version: Some("0.2.0-rc.2".to_owned()),
            pid: Some(4242),
            last_error: None,
            recent_versions: vec![RecentVersion::bare("0.2.0-rc.2"), RecentVersion::bare("0.2.0-rc.1")],
        };
        assert!(runtime.update_snapshot(&both));
        let state = runtime.snapshot();
        assert_eq!(state.harness_status, HarnessStatus::Running);
        assert_eq!(state.harness_pid, Some(4242));
        assert_eq!(
            state.recent_versions.len(),
            2,
            "the library must have been applied even though the harness changed too"
        );
    }

    #[test]
    fn the_status_payload_populates_the_version_list() {
        let payload = serde_json::json!({
            "status": "running",
            "version": "0.2.0-rc.2",
            "pid": 4242,
            "recentVersions": [
                { "version": "0.2.0-rc.2", "state": "installed", "installedAt": "2026-10-06T18:37:06.147Z" },
                { "version": "0.2.0-rc.1", "state": "installed", "installedAt": "2026-10-06T18:36:02.227Z" },
                { "version": "0.1.9", "state": "partial", "installedAt": null }
            ]
        });

        let snapshot = snapshot_from_status_payload(&payload);
        assert_eq!(snapshot.recent_versions.len(), 3);
        assert_eq!(snapshot.recent_versions[0].version, "0.2.0-rc.2");
        assert_eq!(
            snapshot.recent_versions[0].installed_at.as_deref(),
            Some("2026-10-06T18:37:06.147Z")
        );
        assert_eq!(
            snapshot.recent_versions[2].installed_at,
            None,
            "a null date is None, not the string \"null\""
        );

        // A JUNK LIST MUST NOT COST THE USER THE STATUS LABEL. This is the menu's
        // primary information; an unreadable version list degrades to empty.
        for junk in [
            serde_json::json!({ "status": "running" }),
            serde_json::json!({ "status": "running", "recentVersions": "not an array" }),
            serde_json::json!({ "status": "running", "recentVersions": [1, 2, 3] }),
            serde_json::json!({ "status": "running", "recentVersions": [{ "installedAt": "x" }] }),
        ] {
            let degraded = snapshot_from_status_payload(&junk);
            assert!(
                degraded.recent_versions.is_empty(),
                "junk must degrade to an empty list: {junk}"
            );
            assert_eq!(
                degraded.status,
                HarnessStatus::Running,
                "the status must survive a junk version list: {junk}"
            );
        }

        // An entry with a blank version is dropped rather than rendered as `v`.
        let blank = snapshot_from_status_payload(&serde_json::json!({
            "status": "running",
            "recentVersions": [{ "version": "   " }, { "version": "0.2.0-rc.2" }]
        }));
        assert_eq!(blank.recent_versions.len(), 1);
        assert_eq!(blank.recent_versions[0].version, "0.2.0-rc.2");
    }

    #[test]
    fn a_version_list_change_declines_the_status_only_fast_path() {
        // The cadence closure, asserted rather than assumed. `status_only_change`
        // compares the ENTIRE plan, so a version-list difference must make it return
        // `None` - which routes the rebuild to the full structural path.
        let base = state_for("recent-versions");
        let installed = menu_plan(&base, TargetOs::Windows);

        let moved_library = MenuState {
            recent_versions: vec![RecentVersion::bare("9.9.9")],
            ..base.clone()
        };
        let candidate = menu_plan(&moved_library, TargetOs::Windows);

        assert_eq!(
            status_only_change(&installed, &candidate),
            None,
            "a version-list change must NOT take the 0 ms fast path"
        );

        // The converse, so the fast path is still reachable at all: a status-label
        // change with the SAME list is the case the fast path exists for.
        let status_moved = MenuState {
            harness_status: HarnessStatus::Starting,
            ..base.clone()
        };
        assert!(
            status_only_change(&installed, &menu_plan(&status_moved, TargetOs::Windows)).is_some(),
            "a status-only change must still be detected"
        );
    }

    #[test]
    fn a_switch_prefers_the_shell_error_over_a_generic_message() {
        // THE DEAD-SIDECAR CASE (Q91). The user must see a specific reason, not a
        // silent no-op and not a generic failure. The shell's recorded startup error
        // is the real cause (a missing sidecar/index.js, for example), which is why
        // it is preferred over "no port yet".
        let unavailable = switch_dispatch("0.2.0-rc.2", None, None);
        match unavailable {
            SwitchDispatch::Unavailable(message) => {
                assert!(message.contains("0.2.0-rc.2"), "{message}");
                assert!(
                    message.contains("not reported a port yet"),
                    "a sidecar that never came up must say so: {message}"
                );
                assert!(message.contains("launcher log"), "{message}");
            }
            other => panic!("a missing port must refuse, not dispatch: {other:?}"),
        }

        let with_error = switch_dispatch(
            "0.2.0-rc.2",
            None,
            Some("Could not find sidecar/index.js. Searched, starting from the running executable: ..."),
        );
        match with_error {
            SwitchDispatch::Unavailable(message) => {
                assert!(
                    message.contains("Could not find sidecar/index.js"),
                    "the shell's real reason must be shown: {message}"
                );
                assert!(
                    !message.contains("not reported a port yet"),
                    "the generic message must not replace the real cause: {message}"
                );
            }
            other => panic!("a recorded shell error must refuse: {other:?}"),
        }

        // A blank error is treated as no error, so the message is not left dangling.
        let blank = switch_dispatch("0.2.0-rc.2", None, Some("   "));
        assert!(matches!(blank, SwitchDispatch::Unavailable(message) if message.contains("not reported")));
    }

    #[test]
    fn a_switch_with_a_live_sidecar_dispatches_the_versioned_route() {
        let dispatch = switch_dispatch("0.2.0-rc.2", Some(54321), None);
        assert_eq!(
            dispatch,
            SwitchDispatch::Dispatch("/versions/switch?version=0.2.0-rc.2".to_owned()),
            "the route must match the sidecar's, including the query form"
        );

        // A build-metadata version keeps its `+`, because `URLSearchParams` would read
        // a raw `+` as a space and the sidecar would refuse a version that is correct.
        let plus = switch_dispatch("1.0.0+build.5", Some(1), None);
        assert_eq!(
            plus,
            SwitchDispatch::Dispatch("/versions/switch?version=1.0.0+build.5".to_owned()),
            "the shell passes the version through; the sidecar decodes it"
        );
    }

    #[test]
    fn a_switch_refuses_a_version_that_could_not_name_a_directory() {
        // Defense in depth: the sidecar validates and is the authority. This copy
        // exists so a malformed menu id never becomes an HTTP request, and so the user
        // gets the reason instead of a 400 from a service they did not know was
        // involved.
        for hostile in [
            "../../evil",
            "next",
            "latest",
            "1.x",
            "^1.2.3",
            "1.2",
            "1.2.3.4",
            "",
            "1.2.3-",
            "1.2.3+",
            "1.2.3 ",
        ] {
            let dispatch = switch_dispatch(hostile, Some(1), None);
            assert!(
                matches!(dispatch, SwitchDispatch::Unavailable(_)),
                "{hostile:?} must be refused: {dispatch:?}"
            );
        }

        // And the versions it must accept, including every real shape this project has
        // seen plus build metadata.
        for good in [
            "0.2.0-rc.1",
            "0.2.0-rc.2",
            "0.2.1-alpha.1",
            "1.2.3",
            "1.2.3-alpha.10",
            "1.2.3+build.5",
            "1.2.3-rc.1+build.5",
        ] {
            assert!(
                matches!(switch_dispatch(good, Some(1), None), SwitchDispatch::Dispatch(_)),
                "{good:?} must be accepted"
            );
        }
    }

    #[test]
    fn the_switch_outcome_message_distinguishes_the_three_shapes() {
        // 202 is "accepted", NOT "switched": the boot takes minutes and the message
        // must not claim it finished.
        let accepted = crate::ProxiedResponse {
            code: 202,
            data: serde_json::json!({ "busy": true, "kind": "switch", "version": "0.2.0-rc.2" }),
            error: None,
            shell_error: None,
        };
        let message = switch_outcome_message("0.2.0-rc.2", &accepted);
        assert!(message.contains("Switching to v0.2.0-rc.2"), "{message}");
        assert!(
            !message.contains("Switched"),
            "an accepted switch must not be reported as finished: {message}"
        );
        assert!(message.contains("few minutes"), "{message}");

        // A refusal carries the sidecar's OWN explanation, which is more specific than
        // anything the shell could invent (another operation in flight, or the library
        // locked by another process).
        let refused = crate::ProxiedResponse {
            code: 409,
            data: serde_json::json!({ "error": "library-locked", "message": "Another version library operation is in progress (pid 4242 since ...)" }),
            error: None,
            shell_error: None,
        };
        let message = switch_outcome_message("0.2.0-rc.1", &refused);
        assert!(message.contains("Could not switch to v0.2.0-rc.1"), "{message}");
        assert!(message.contains("pid 4242"), "the sidecar's wording must survive: {message}");

        // A transport failure, with and without the shell's own reason.
        let unreachable = crate::ProxiedResponse {
            code: 0,
            data: serde_json::Value::Null,
            error: Some("Could not reach the DSH-Dock core on 127.0.0.1:54321".to_owned()),
            shell_error: None,
        };
        let message = switch_outcome_message("0.2.0-rc.2", &unreachable);
        assert!(message.contains("Could not start switching"), "{message}");
        assert!(!message.contains("()"), "no dangling parentheses: {message}");

        let with_shell = crate::ProxiedResponse {
            shell_error: Some("Could not find sidecar/index.js".to_owned()),
            ..unreachable
        };
        let message = switch_outcome_message("0.2.0-rc.2", &with_shell);
        assert!(message.contains("Could not find sidecar/index.js"), "{message}");

        // An unexplained non-2xx must still say something specific.
        let silent = crate::ProxiedResponse {
            code: 500,
            data: serde_json::Value::Null,
            error: None,
            shell_error: None,
        };
        let message = switch_outcome_message("0.2.0-rc.2", &silent);
        assert!(message.contains("HTTP 500"), "{message}");
    }

    #[test]
    fn every_rebuild_reason_goes_through_the_one_set_menu_call_site() {
        // THE WORKER BOUNDARY, PINNED AS FAR AS A UNIT TEST CAN. `set_menu` is
        // app-wide and must only ever be called from `rebuild_menu`, which is
        // main-thread work. The switch worker deliberately does NOT touch a menu: it
        // performs the HTTP call and then marshals back with `on_main`, which calls
        // `request_rebuild`. This asserts there is exactly ONE production call site,
        // so a future edit that installs a menu from a worker shows up here.
        let source = include_str!("menu.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("menu.rs has a non-test section");

        let app_wide: Vec<&str> = production
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("if let Err(error) = app.set_menu(") || line.starts_with("app.set_menu("))
            .collect();
        assert_eq!(
            app_wide.len(),
            1,
            "there must be exactly one app-wide set_menu call site: {app_wide:?}"
        );

        // The window-scoped clear is the other one, and it is on a WINDOW, not the
        // app - which is why it is not counted above.
        assert!(
            production.contains("window.set_menu(empty)"),
            "the wizard's menu clear must stay window-scoped"
        );
    }

    #[test]
    fn the_switch_version_predicate_agrees_with_the_id_round_trip() {
        // THE CROSS-MODULE PIN, INSIDE THE SHELL (Q71). Two pieces of shell code now
        // decide whether a string is an exact version: this predicate, added in 7b so a
        // malformed menu id never becomes an HTTP request, and
        // `MenuAction::from_id`, which RECONSTRUCTS the action from the id the submenu
        // built. If they disagreed, a menu item could exist whose own click did not
        // round-trip - which the existing `every_action_id_in_every_plan_round_trips`
        // test would catch only for versions the FIXTURES happen to contain. This walks
        // a corpus instead, so the two cannot drift on a version nobody thought to
        // write a fixture for.
        //
        // NOT a parity check with the sidecar. The sidecar's `isSafeVersionName` is the
        // authority and refuses a superset of what this predicate allows; that
        // relationship is asserted on the sidecar side, where the authority lives.
        let corpus = [
            "0.2.0-rc.1",
            "0.2.0-rc.2",
            "0.2.1-alpha.1",
            "1.2.3",
            "1.2.3-alpha.10",
            "1.2.3+build.5",
            "1.2.3-rc.1+build.5",
            "0.0.1-rc.1",
            "10.20.30",
            "../../evil",
            "1.0.0/../evil",
            "next",
            "latest",
            "1.x",
            "^1.2.3",
            "1.2",
            "1.2.3.4",
            "1.2.3-",
            "1.2.3+",
            "1.2.3 ",
            "1.2.3-rc.1+",
            "v1.2.3",
        ];

        for version in corpus {
            let predicate = is_switchable_version(version);
            let id = format!("{ID_HARNESS_RECENT_PREFIX}{version}");
            let round_trips = matches!(
                MenuAction::from_id(&id),
                Some(MenuAction::SwitchVersion(_))
            );
            assert_eq!(
                predicate, round_trips,
                "{version:?}: is_switchable_version={predicate} but id round-trip={round_trips}"
            );

            // And the predicate must not be vacuously permissive: a version it accepts
            // must build a route the sidecar could serve.
            if predicate {
                match switch_dispatch(version, Some(1), None) {
                    SwitchDispatch::Dispatch(path) => assert_eq!(
                        path,
                        format!("/versions/switch?version={version}"),
                        "{version:?} built an unexpected route"
                    ),
                    other => panic!("{version:?} was accepted but not dispatched: {other:?}"),
                }
            }
        }
    }

    #[test]
    fn a_library_rebuild_still_clears_the_wizard_window_menu() {
        // The re-verification the phase asked for. `rebuild_menu` re-clears the
        // wizard's menu after EVERY install, and 2B adds a rebuild reason that fires
        // while the wizard can legitimately be open - a first-run install completes
        // and the recent-versions list changes. The guard is unconditional (not
        // matched on `reason`), which is what makes it cover the new reason for free;
        // this pins that it is not behind a `reason` check.
        let source = include_str!("menu.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("menu.rs has a non-test section");

        let body = {
            let start = production
                .find("pub fn rebuild_menu<R: Runtime>")
                .expect("rebuild_menu exists");
            let rest = &production[start..];
            let end = rest.find("\n}\n").expect("rebuild_menu ends");
            &rest[..end]
        };

        assert!(
            body.contains("clear_welcome_menu(app, \"rebuild\")"),
            "every rebuild must re-clear the wizard's menu"
        );
        assert!(
            !body.contains("match reason")
                && !body.contains("if reason ==")
                && !body.contains("RebuildReason::Poll => clear_welcome_menu"),
            "the clear must not be conditional on the rebuild reason, or a new reason \
             would silently skip it"
        );
    }
}
