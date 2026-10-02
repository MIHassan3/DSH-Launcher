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
use std::sync::{Mutex, PoisonError};
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

/// Label of the version-manager entry while the version library does not exist.
///
/// A disabled menu item cannot carry a tooltip, so the reason has to be in the
/// label itself - the alternative is a clickable item that does nothing, which
/// is worse than a disabled one that explains why.
const LABEL_SHOW_ALL_VERSIONS: &str = "Show all versions… (Phase 2)";

/// Whether the version-manager entry is clickable.
///
/// PHASE 2 OWNER: flips to `true` when the version manager exists. Kept as a
/// named constant so the flip is one line and shows up in a diff.
const SHOW_ALL_VERSIONS_ENABLED: bool = false;

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
    /// Known harness versions, newest first, for the `Recent Versions` submenu.
    ///
    /// EMPTY until Phase 2 populates the library. The plan caps what it shows.
    pub recent_versions: Vec<String>,
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
        },
        _ => HarnessSnapshot {
            status: HarnessStatus::Unavailable,
            version: None,
            pid: None,
            last_error: None,
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

    HarnessSnapshot {
        status,
        version,
        pid,
        last_error,
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
    /// Switch the active harness version (Phase 2).
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
    /// Since the dashboard took ownership of the harness actions, only two
    /// actions touch anything outside this process: opening the logs folder (a
    /// process spawn) and writing `settings.json`. Everything else is an event
    /// emission or window management, which are main-thread safe by construction.
    ///
    /// This is documentation and a test seam; the dispatcher's safety comes from
    /// its match arms, not from this method being consulted at runtime.
    pub fn needs_worker(&self) -> bool {
        match self {
            // Process spawn / disk write.
            Self::OpenLogsFolder | Self::SetAutoUpdateChannel(_) => true,

            // Event emission and window management only.
            Self::RestartHarness
            | Self::StopHarness
            | Self::SwitchVersion(_)
            | Self::HarnessUpdate
            | Self::DockUpdate
            | Self::OpenControlPanel { .. } => false,
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
                if version.is_empty() {
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
/// Empty today: the version library is Phase 2's work. `state.recent_versions`
/// may be longer than the menu shows; the cap lives here so no caller has to
/// know it.
fn recent_versions_submenu(state: &MenuState) -> PlanNode {
    let mut items: Vec<PlanNode> = Vec::new();

    for version in state.recent_versions.iter().take(RECENT_VERSIONS_LIMIT) {
        if Some(version) == state.installed_version.as_ref() {
            // The active version is information, not an action: switching to the
            // version already running would do nothing.
            items.push(PlanNode::Label {
                label: format!("v{version} (installed)"),
            });
        } else {
            items.push(PlanNode::Action {
                id: format!("{ID_HARNESS_RECENT_PREFIX}{version}"),
                label: format!("v{version}"),
                action: MenuAction::SwitchVersion(version.clone()),
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
                recent_versions: vec![
                    "0.1.5-rc.2".to_owned(),
                    "0.1.5-rc.1".to_owned(),
                    "0.1.5-alpha.2".to_owned(),
                    "0.1.4-rc.3".to_owned(),
                    "0.1.4-rc.2".to_owned(),
                    "0.1.4-rc.1".to_owned(),
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
                    "0.1.6-rc.1".to_owned(),
                    "0.1.5-rc.2".to_owned(),
                    "0.1.5-rc.1".to_owned(),
                    "0.1.5-alpha.2".to_owned(),
                    "0.1.4-rc.3".to_owned(),
                    "0.1.4-rc.2".to_owned(),
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
fn on_main<R: Runtime, F: FnOnce(&AppHandle<R>) + Send + 'static>(app: &AppHandle<R>, work: F) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || work(&handle)) {
        log_line(&format!("menu: could not reach the main thread: {error}"));
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

        // Forwarded to the dashboard. Emitting an event is not I/O, so these run
        // inline and the handler still returns immediately.
        MenuAction::RestartHarness => deliver(app, DashboardAction::Restart),
        MenuAction::StopHarness => deliver(app, DashboardAction::Stop),

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

        MenuAction::SwitchVersion(version) => notice(
            app,
            PanelTab::Versions,
            format!("Switching to v{version} arrives with the version library (Phase 2)."),
        ),
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
    fn recent_versions_contains_only_the_disabled_phase_2_hint_when_empty() {
        let plan = menu_plan(&state_for("running"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert_eq!(items.len(), 1, "{items:#?}");
        let show_all = &items[0];
        assert_eq!(node_label(show_all), "Show all versions… (Phase 2)");
        assert!(
            matches!(show_all, PlanNode::Action { enabled: false, .. }),
            "the version manager does not exist yet, so the entry must not pretend it does: {show_all:?}"
        );
    }

    #[test]
    fn recent_versions_shows_at_most_five_by_date_plus_the_manager_entry() {
        // The fixture has six versions; Q49 says show five.
        let state = state_for("recent-versions");
        let plan = menu_plan(&state, TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        assert_eq!(items.len(), 6, "five versions plus Show all versions…: {items:#?}");
        assert_eq!(node_label(&items[0]), "v0.1.5-rc.2 (installed)");
        assert_eq!(node_label(&items[1]), "v0.1.5-rc.1");
        assert_eq!(node_label(&items[4]), "v0.1.4-rc.2");
        assert_eq!(node_label(&items[5]), "Show all versions… (Phase 2)");

        let labels: Vec<&str> = items.iter().map(node_label).collect();
        assert!(
            !labels.contains(&"v0.1.4-rc.1"),
            "the sixth version must be dropped: {labels:?}"
        );
    }

    #[test]
    fn the_installed_version_is_information_and_the_others_are_switch_actions() {
        let plan = menu_plan(&state_for("recent-versions"), TargetOs::Windows);
        let items = nested(submenu(&plan, "Harness"), "Recent Versions");

        // The installed entry is a label: switching to the running version is a
        // no-op, so it must not be clickable.
        assert!(matches!(&items[0], PlanNode::Label { .. }));

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
        assert_eq!(labels[5], "Show all versions… (Phase 2)");
        assert!(matches!(
            &items[5],
            PlanNode::Action { action: MenuAction::OpenControlPanel { tab: PanelTab::Versions }, .. }
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
        // both webviews. Anything that spawns a process or writes a file must be
        // moved to a worker, and the dispatcher's structure depends on this list
        // being exactly right.
        //
        // Since the dashboard took over the harness actions, Restart and Stop no
        // longer touch the sidecar from here at all: they emit an event. That is
        // why they are no longer worker actions.
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
                MenuAction::OpenLogsFolder | MenuAction::SetAutoUpdateChannel(_)
            );
            assert_eq!(
                action.needs_worker(),
                expected_worker,
                "{action:?} has the wrong threading classification"
            );
        }

        // Exactly two worker actions, and they are the two I/O ones.
        let workers: Vec<&MenuAction> =
            actions.iter().filter(|action| action.needs_worker()).collect();
        assert_eq!(workers.len(), 2, "{workers:?}");
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
    fn the_harness_actions_are_forwarded_rather_than_performed_here() {
        // The regression this guards: the menu used to call the sidecar itself,
        // so a menu "Stop Harness" left the dashboard showing a running harness.
        // Each of these ids must resolve to an action that only EMITS.
        for (id, expected) in [
            (ID_HARNESS_RESTART, DashboardAction::Restart),
            (ID_HARNESS_STOP, DashboardAction::Stop),
            (ID_HARNESS_OPEN_LOGS, DashboardAction::OpenLogs),
        ] {
            let action = MenuAction::from_id(id).expect("a known id");
            assert!(
                !action.needs_worker(),
                "{id} must not do I/O in the shell any more"
            );

            // The mapping from menu action to dashboard action is the contract
            // `handle_menu_event` implements; pin it here so a change to one
            // without the other fails a test.
            let forwarded = match action {
                MenuAction::RestartHarness => Some(DashboardAction::Restart),
                MenuAction::StopHarness => Some(DashboardAction::Stop),
                MenuAction::OpenLogsFolder => Some(DashboardAction::OpenLogs),
                _ => None,
            };
            assert_eq!(forwarded, Some(expected), "{id} forwards the wrong action");
        }
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
}
