//! Launcher settings - the single source of truth at `<data-dir>/settings.json`.
//!
//! Sections 2.4, 3.11 and decision Q53 of `docs/PROJECT_DSH-DOCK.md`: every
//! launcher setting lives in exactly one file, and both surfaces - the native
//! menu bar and the (Phase 3) settings window - read and write that one file.
//! There is no secondary state cache: whoever changes a setting last wins, and
//! both surfaces read the current state when they open.
//!
//! WHY THE SHELL OWNS THIS FILE, AGAINST SECTION 2'S LAYER TABLE. Section 2 puts
//! settings I/O in the Node core, and the sidecar does own
//! `resolveStatePaths().settings`. This sub-project assigns the menu bar's own
//! reads and writes to Rust, which means the file has two writers for now. Three
//! safeguards make that safe, and all three are deliberate:
//!
//!   1. ONE data-directory rule. [`data_dir_from`] mirrors
//!      `sidecar/lib/state.js` (`DSH_DOCK_DATA_DIR`, otherwise the per-OS
//!      default), so both writers resolve the same path. The shared rule is
//!      asserted against the sidecar's own source by a test below.
//!   2. ATOMIC WRITES. Sibling `.tmp` file, then rename - the same pattern as
//!      `writeJsonAtomic` in the sidecar - so a reader can never observe a
//!      half-written file.
//!   3. UNKNOWN KEYS ARE PRESERVED. [`Settings::unknown`] keeps every field this
//!      build does not model, so a Rust rewrite can never delete a key that the
//!      sidecar or a later phase added.
//!
//! Long-term ownership of the file is a Phase 2 question and is recorded as such
//! in the MD. Nothing here tries to settle it.
//!
//! INVARIANTS
//!
//!   * Reading never creates the file. An absent `settings.json` is meaningful
//!     ("nothing has been configured yet") and the defaults are used instead -
//!     the same rule `ensureDataDirs` follows in the sidecar.
//!   * Reading never fails and never panics. A missing, unreadable, corrupt or
//!     wrongly-typed file yields the defaults plus a warning for the launcher
//!     log. A settings problem must never be able to stop the launcher starting.
//!   * A value read from the file is never "corrected" in memory. An
//!     unrecognised channel is reported and kept exactly as written, so opening
//!     the launcher cannot silently rewrite a user's file.
//!   * A write is all-or-nothing in memory AND on disk: the file is written
//!     first and the in-memory value is committed second, so a failed write
//!     leaves the two in agreement.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// Environment variable that overrides the launcher data directory.
///
/// A supported product feature, not a test hook (section 2.4). Mirrors
/// `DATA_DIR_ENV_VAR` in `sidecar/lib/state.js`; the launcher only ever READS it
/// and production code never sets it.
pub const DATA_DIR_ENV_VAR: &str = "DSH_DOCK_DATA_DIR";

/// File name of the settings file inside the data directory (section 3.11).
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// Directory name used on Windows and macOS (section 2.4).
pub const APP_DIR_NAME: &str = "DSH-Dock";

/// Directory name used on Linux, where lowercase is conventional.
pub const APP_DIR_SLUG: &str = "dsh-dock";

/// Channel used when nothing has been chosen yet.
///
/// Section 3.9: closing the first-run wizard without choosing defaults to `rc`.
pub const DEFAULT_CHANNEL: &str = "rc";

/// Default cache limit (sections 3.1 and 3.11).
pub const DEFAULT_CACHE_LIMIT: usize = 10;

/// Channels a user may select in this build.
///
/// `stable` is deliberately absent: as of 2026-09-10 the `latest` tag still
/// points at a release candidate, so there is no stable release to track
/// (section 3.1, Q48). The same list backs the menu's available-channel
/// constant, and Phase 2 replaces both with a real registry probe.
pub const SELECTABLE_CHANNELS: [&str; 3] = ["rc", "alpha", "all"];

/// The four auto-update options, in the order the menu shows them (section 3.2).
///
/// `stable` is listed as an OPTION even though it cannot be selected yet: Q48
/// requires the option to stay visible and disabled rather than disappear.
pub const AUTO_UPDATE_OPTIONS: [&str; 4] = ["stable", "rc", "alpha", "all"];

/// True when `channel` names a channel that can have releases on the registry.
///
/// `all` is an update POLICY - "whichever channel is newest" - not a channel, so
/// it is deliberately not one. This distinction is what lets the menu keep
/// `All channels` always enabled while the three real channels follow the
/// registry's availability.
pub fn is_registry_channel(channel: &str) -> bool {
    matches!(channel, "stable" | "rc" | "alpha")
}

/// True when `channel` is one this build may write to `settings.json`.
pub fn is_selectable_channel(channel: &str) -> bool {
    SELECTABLE_CHANNELS.contains(&channel)
}

/// Validates a channel before it is persisted.
///
/// Returns the reason on failure rather than a bare "invalid": the caller is a
/// menu click or a wizard button, and the message ends up in the launcher log.
pub fn validate_channel(channel: &str) -> Result<(), String> {
    if is_selectable_channel(channel) {
        return Ok(());
    }

    let reason = if channel == "stable" {
        "the stable channel has no release yet (the `latest` tag still points at a release \
         candidate), so tracking it would be meaningless; it is re-enabled when a stable \
         release appears"
    } else {
        "it is not one of the supported channels"
    };

    Err(format!(
        "Refusing to set auto_update_channel to {channel:?}: {reason}. Selectable: {}.",
        SELECTABLE_CHANNELS.join(", ")
    ))
}

/// Everything the launcher persists (section 3.11, plus the first-run flag).
///
/// Field names are the JSON keys and are contract: the sidecar and the Phase 3
/// settings window read and write this same file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// Which channel auto-update tracks: `stable`, `rc`, `alpha` or `all`.
    #[serde(default = "default_channel")]
    pub auto_update_channel: String,

    /// A pinned version, which overrides auto-update until it is cleared.
    #[serde(default)]
    pub preferred_version: Option<String>,

    /// How many harness versions the library may keep (section 3.1).
    #[serde(default = "default_cache_limit")]
    pub cache_limit: usize,

    /// When the registry was last polled (section 3.2, 12-hour cadence).
    #[serde(default)]
    pub last_update_check: Option<String>,

    /// ETag from the last registry response, for `If-None-Match` (section 3.2).
    #[serde(default)]
    pub etag: Option<String>,

    /// True once the first-run wizard has been answered or dismissed.
    ///
    /// NOT YET LISTED IN SECTION 3.11 - the MD correction is queued by the
    /// project owner. It lives here so the wizard is shown exactly once
    /// (section 3.9) without inventing a second state file.
    #[serde(default)]
    pub first_run_completed: bool,

    /// Every key this build does not model, preserved verbatim.
    ///
    /// This is what makes a Rust rewrite non-destructive: the sidecar and later
    /// phases may add fields that an older shell does not know about, and those
    /// fields must survive. Do not remove without solving that problem another
    /// way.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

fn default_channel() -> String {
    DEFAULT_CHANNEL.to_owned()
}

fn default_cache_limit() -> usize {
    DEFAULT_CACHE_LIMIT
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_update_channel: default_channel(),
            preferred_version: None,
            cache_limit: default_cache_limit(),
            last_update_check: None,
            etag: None,
            first_run_completed: false,
            unknown: serde_json::Map::new(),
        }
    }
}

// --- Data directory ---------------------------------------------------------

/// Reads one environment variable, treating blank as unset.
///
/// A whitespace-only value must never resolve to a relative or empty path.
fn env_string(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    let value = env.get(key)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// The current process environment, lossily decoded.
///
/// `std::env::vars()` PANICS on a non-Unicode variable, and a launcher must not
/// be able to die because of an unrelated environment variable, so the lossy
/// variant is used deliberately.
fn environment() -> BTreeMap<String, String> {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// The user's home directory as the sidecar's `os.homedir()` would see it.
///
/// `USERPROFILE` on Windows, `HOME` elsewhere, with `HOME` as the Windows
/// fallback for a stripped environment. Returns `None` rather than guessing.
fn home_from(env: &BTreeMap<String, String>) -> Option<String> {
    if cfg!(windows) {
        env_string(env, "USERPROFILE").or_else(|| env_string(env, "HOME"))
    } else {
        env_string(env, "HOME")
    }
}

/// Expands a leading `~` against the home directory.
///
/// Mirrors `expandHome` in the sidecar: only a bare `~` or a `~/`-or-`\`-prefixed
/// form is expanded. A `~name` form is left alone rather than guessed at, and
/// without a known home the value is returned unchanged.
fn expand_home(value: &str, home: Option<&str>) -> PathBuf {
    if let Some(home) = home {
        if value == "~" {
            return PathBuf::from(home);
        }
        if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(value)
}

/// The `DSH_DOCK_DATA_DIR` override, or `None` when it is unset or blank.
///
/// The result is made absolute to mirror `path.resolve` in the sidecar. A
/// RELATIVE override is inherently ambiguous, because it is resolved against
/// whichever process reads it; the documented contract is an absolute path.
pub fn data_dir_override(env: &BTreeMap<String, String>, home: Option<&str>) -> Option<PathBuf> {
    let raw = env_string(env, DATA_DIR_ENV_VAR)?;
    let expanded = expand_home(&raw, home);
    Some(std::path::absolute(&expanded).unwrap_or(expanded))
}

/// Pure per-OS data-directory rule, with every input supplied explicitly.
///
/// Mirrors `defaultDataDirFor(platform, env, home)` in `sidecar/lib/state.js`,
/// including its naming: `windows`/`macos` are matched, and anything else uses
/// the XDG rule. Kept pure and exported so all three branches are testable on
/// one machine - reading `std::env::consts::OS` here would leave the macOS and
/// Linux branches unverifiable, which is how per-OS bugs hide.
///
/// ONE DELIBERATE DEVIATION from the sidecar: a blank `LOCALAPPDATA` is treated
/// as unset here, where state.js's `??` would accept the empty string and
/// produce a relative path. A blank value cannot be a valid base on either side;
/// the sidecar's behaviour for that case is a Phase 2 note, not something this
/// session changes.
/// Which separator flavour a path resolution should use.
///
/// Mirrors `pathFor(platform)` in `sidecar/lib/state.js`. Needed because the
/// per-OS rule is pure and takes the target platform as an argument: joining
/// with the HOST's path rules while simulating macOS or Linux would emit Windows
/// separators, so the resolution and any test asserting it would agree on the
/// same wrong answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathFlavour {
    /// `\` separators, as Windows uses.
    Windows,
    /// `/` separators, as macOS and Linux use.
    Posix,
}

impl PathFlavour {
    /// The flavour that belongs to a `std::env::consts::OS` style target name.
    pub fn for_target_os(target_os: &str) -> Self {
        match target_os {
            "windows" => Self::Windows,
            _ => Self::Posix,
        }
    }

    fn separator(self) -> char {
        match self {
            Self::Windows => '\\',
            Self::Posix => '/',
        }
    }

    /// Joins `parts` onto `base` with this flavour's separator.
    ///
    /// Returns a `String` rather than a `PathBuf` on purpose: on Windows,
    /// `Path::new("/a/b") == Path::new("\\a\\b")`, so a `PathBuf` comparison
    /// would NOT catch a wrong separator. The string comparison is the one that
    /// means something here.
    ///
    /// A trailing separator on `base` is not doubled, so an override or an
    /// environment value with a trailing slash resolves cleanly.
    pub fn join(self, base: &str, parts: &[&str]) -> String {
        let mut out = base.trim_end_matches(['/', '\\']).to_owned();
        for part in parts {
            out.push(self.separator());
            out.push_str(part);
        }
        out
    }
}

/// Pure per-OS data-directory rule as an exact path string, with every input
/// supplied explicitly.
///
/// This is the flavour-exact core: the separator matches the TARGET OS, not the
/// host, so the macOS and Linux results are byte-comparable on Windows - the
/// same reason `defaultDataDirFor` takes a platform in the sidecar.
///
/// See [`default_data_dir_for`] for the `PathBuf` form the launcher uses.
pub fn default_data_dir_string_for(
    target_os: &str,
    env: &BTreeMap<String, String>,
    home: Option<&str>,
) -> Option<String> {
    let flavour = PathFlavour::for_target_os(target_os);

    match target_os {
        "windows" => {
            let base = match env_string(env, "LOCALAPPDATA") {
                Some(value) => value,
                None => flavour.join(home?, &["AppData", "Local"]),
            };
            Some(flavour.join(&base, &[APP_DIR_NAME]))
        }

        "macos" => Some(flavour.join(
            home?,
            &["Library", "Application Support", APP_DIR_NAME],
        )),

        // XDG: $XDG_DATA_HOME, defaulting to ~/.local/share. A blank value counts
        // as unset rather than becoming an empty or relative base.
        _ => {
            let base = match env_string(env, "XDG_DATA_HOME") {
                Some(value) => value,
                None => flavour.join(home?, &[".local", "share"]),
            };
            Some(flavour.join(&base, &[APP_DIR_SLUG]))
        }
    }
}

/// The data directory as a [`PathBuf`], for the target OS named.
///
/// In production this is always called with the HOST's OS name, so the flavour
/// and the host agree. Simulating another OS from a test is supported - the
/// components are then correct and the separator is that OS's - but the byte
/// comparison belongs in [`default_data_dir_string_for`].
pub fn default_data_dir_for(
    target_os: &str,
    env: &BTreeMap<String, String>,
    home: Option<&str>,
) -> Option<PathBuf> {
    Some(PathBuf::from(default_data_dir_string_for(
        target_os, env, home,
    )?))
}

/// Testable core of [`data_dir`]: the override wins outright, else the OS rule.
pub fn data_dir_from(
    target_os: &str,
    env: &BTreeMap<String, String>,
    home: Option<&str>,
) -> Option<PathBuf> {
    if let Some(override_dir) = data_dir_override(env, home) {
        return Some(override_dir);
    }
    default_data_dir_for(target_os, env, home)
}

/// The launcher data directory for this platform (section 2.4), or `None`.
///
/// `None` means the directory genuinely cannot be resolved (no override, no
/// `LOCALAPPDATA`, no home). Callers report that instead of inventing a path:
/// writing launcher state into the current working directory would be worse
/// than admitting the environment is broken.
pub fn data_dir() -> Option<PathBuf> {
    let env = environment();
    let home = home_from(&env);
    data_dir_from(std::env::consts::OS, &env, home.as_deref())
}

/// `<data-dir>/settings.json`, or `None` when the data directory is unknown.
pub fn settings_path() -> Option<PathBuf> {
    Some(data_dir()?.join(SETTINGS_FILE_NAME))
}

// --- Reading and writing ----------------------------------------------------

/// Outcome of a settings read: the usable value plus anything worth logging.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadResult {
    /// What the caller should use. Always usable.
    pub settings: Settings,
    /// Human-readable problems, in the order they were found.
    pub warnings: Vec<String>,
}

/// Reads `settings.json`.
///
/// Never returns an error and never panics - see the module invariant. A file
/// that cannot be parsed at all yields the defaults, and the next write replaces
/// it, which is stated in the warning text so the loss is visible in the log.
pub fn load_from(path: &Path) -> LoadResult {
    let mut warnings = Vec::new();

    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // An absent file is the normal first-run state, not a problem.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LoadResult {
                settings: Settings::default(),
                warnings,
            }
        }
        Err(error) => {
            warnings.push(format!(
                "could not read {}: {error}. Using the default settings.",
                path.display()
            ));
            return LoadResult {
                settings: Settings::default(),
                warnings,
            };
        }
    };

    match serde_json::from_str::<Settings>(&text) {
        Ok(settings) => {
            // Reported, never corrected: rewriting a value the user typed (or a
            // later phase wrote) is not this module's business.
            if !is_selectable_channel(&settings.auto_update_channel) {
                warnings.push(format!(
                    "auto_update_channel {:?} in {} is not selectable in this build (selectable: \
                     {}). The value is kept as written and no auto-update option is checked.",
                    settings.auto_update_channel,
                    path.display(),
                    SELECTABLE_CHANNELS.join(", ")
                ));
            }
            LoadResult { settings, warnings }
        }
        Err(error) => {
            warnings.push(format!(
                "{} is not valid settings JSON ({error}). Using the default settings; the next \
                 settings change will replace the file.",
                path.display()
            ));
            LoadResult {
                settings: Settings::default(),
                warnings,
            }
        }
    }
}

/// The sibling temporary file used for an atomic replace.
///
/// A `.tmp` SUFFIX rather than a leading dot, so a failure leaves an obvious
/// artifact instead of a file that looks ignored - the same choice
/// `writeJsonAtomic` documents in the sidecar.
fn temp_sibling(path: &Path) -> PathBuf {
    match path.file_name() {
        Some(name) => path.with_file_name(format!("{}.tmp", name.to_string_lossy())),
        None => path.with_extension("tmp"),
    }
}

/// Writes `settings.json` atomically: write a sibling temp file, then rename.
///
/// A rename within one directory is atomic on both NTFS and POSIX, so a reader
/// (including the sidecar) can never observe a half-written file.
pub fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err(format!(
            "Could not write {}: the path has no parent directory.",
            path.display()
        ));
    };

    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialise the settings: {error}"))?;

    let temp = temp_sibling(path);
    std::fs::write(&temp, format!("{json}\n")).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not write {}: {error}", temp.display())
    })?;

    std::fs::rename(&temp, path).map_err(|error| {
        // Do not leave a stray temp file behind: the caller reports the failure,
        // and a leftover would be mistaken for real state on the next look.
        let _ = std::fs::remove_file(&temp);
        format!("Could not replace {}: {error}", path.display())
    })?;

    Ok(())
}

// --- Managed state ----------------------------------------------------------

/// Settings as Tauri managed state, with the path resolved once.
#[derive(Debug)]
pub struct SettingsState {
    inner: Mutex<SettingsInner>,
}

#[derive(Debug)]
struct SettingsInner {
    /// `None` when the launcher data directory could not be resolved.
    path: Option<PathBuf>,
    settings: Settings,
    warnings: Vec<String>,
}

impl SettingsState {
    /// Reads settings from the real data directory. Never fails.
    pub fn load() -> Self {
        match settings_path() {
            Some(path) => Self::at(Some(path)),
            None => {
                let state = Self::at(None);
                state.push_warning(
                    "the launcher data directory could not be resolved (no DSH_DOCK_DATA_DIR, no \
                     LOCALAPPDATA and no home directory), so settings cannot be read or written. \
                     The defaults are in use and will not persist."
                        .to_owned(),
                );
                state
            }
        }
    }

    /// Reads settings from an explicit path. Used by [`Self::load`] and by tests.
    pub fn at(path: Option<PathBuf>) -> Self {
        let (settings, warnings) = match path.as_deref() {
            Some(path) => {
                let result = load_from(path);
                (result.settings, result.warnings)
            }
            None => (Settings::default(), Vec::new()),
        };

        Self {
            inner: Mutex::new(SettingsInner {
                path,
                settings,
                warnings,
            }),
        }
    }

    /// The file this state reads and writes, when the data directory is known.
    pub fn path(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .path
            .clone()
    }

    /// Everything worth logging from the startup read.
    pub fn warnings(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .warnings
            .clone()
    }

    /// A copy of the current settings.
    ///
    /// The menu builder reads a snapshot rather than holding the lock, so a slow
    /// rebuild can never block a settings change.
    pub fn snapshot(&self) -> Settings {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .settings
            .clone()
    }

    /// The tracked channel, whatever the file says.
    pub fn auto_update_channel(&self) -> String {
        self.snapshot().auto_update_channel
    }

    /// True once the first-run wizard has been answered or dismissed.
    pub fn first_run_completed(&self) -> bool {
        self.snapshot().first_run_completed
    }

    /// Sets the tracked channel and writes the file.
    pub fn set_auto_update_channel(&self, channel: &str) -> Result<Settings, String> {
        validate_channel(channel)?;
        let channel = channel.to_owned();
        self.mutate(move |settings| settings.auto_update_channel = channel)
    }

    /// Records the wizard's outcome: the chosen channel and the flag together.
    ///
    /// One write, so a crash between two writes cannot leave "first run done"
    /// recorded without a channel (or the reverse).
    pub fn complete_first_run(&self, channel: &str) -> Result<Settings, String> {
        validate_channel(channel)?;
        let channel = channel.to_owned();
        self.mutate(move |settings| {
            settings.auto_update_channel = channel;
            settings.first_run_completed = true;
        })
    }

    fn push_warning(&self, warning: String) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .warnings
            .push(warning);
    }

    /// Applies a change, writes it, and only then commits it to memory.
    ///
    /// The order matters: a failed write leaves memory and disk in agreement
    /// instead of showing the user a value that was never persisted.
    fn mutate<F: FnOnce(&mut Settings)>(&self, change: F) -> Result<Settings, String> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);

        let Some(path) = inner.path.clone() else {
            return Err(
                "The launcher data directory could not be resolved, so settings cannot be saved."
                    .to_owned(),
            );
        };

        let mut next = inner.settings.clone();
        change(&mut next);

        save_to(&path, &next)?;
        inner.settings = next.clone();

        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique, freshly created directory under the system temp directory.
    ///
    /// Never inside `%LOCALAPPDATA%\DSH-Dock`: the developer's live launcher
    /// state lives there, and a test must not be able to touch it.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-dock-settings-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp directory");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    // --- the model ---------------------------------------------------------

    #[test]
    fn the_defaults_match_the_documented_model() {
        let settings = Settings::default();

        // Section 3.11's example document, plus the first-run flag.
        assert_eq!(settings.auto_update_channel, "rc");
        assert_eq!(settings.preferred_version, None);
        assert_eq!(settings.cache_limit, 10);
        assert_eq!(settings.last_update_check, None);
        assert_eq!(settings.etag, None);
        assert!(!settings.first_run_completed);
        assert!(settings.unknown.is_empty());
    }

    #[test]
    fn the_json_keys_are_the_documented_field_names() {
        // These names are contract with the sidecar and the Phase 3 settings
        // window; renaming one silently would break the single-source-of-truth
        // rule (section 3.11).
        let dir = temp_dir("keys");
        let file = dir.join(SETTINGS_FILE_NAME);

        save_to(&file, &Settings::default()).expect("a write");

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("the file")).expect("json");
        let object = raw.as_object().expect("an object");

        for key in [
            "auto_update_channel",
            "preferred_version",
            "cache_limit",
            "last_update_check",
            "etag",
            "first_run_completed",
        ] {
            assert!(object.contains_key(key), "missing key {key} in {object:?}");
        }

        cleanup(&dir);
    }

    // --- reading -----------------------------------------------------------

    #[test]
    fn an_absent_file_is_the_defaults_and_writes_nothing() {
        let dir = temp_dir("absent");
        let file = dir.join(SETTINGS_FILE_NAME);

        let result = load_from(&file);

        assert_eq!(result.settings, Settings::default());
        assert!(result.warnings.is_empty(), "an absent file is not a warning");
        // Reading must never create the file: "nothing configured yet" is a
        // state the launcher has to be able to see.
        assert!(!file.exists(), "reading created {file:?}");

        cleanup(&dir);
    }

    #[test]
    fn a_round_trip_preserves_every_field() {
        let dir = temp_dir("roundtrip");
        let file = dir.join(SETTINGS_FILE_NAME);

        let settings = Settings {
            auto_update_channel: "alpha".to_owned(),
            preferred_version: Some("0.1.5-rc.2".to_owned()),
            cache_limit: 4,
            last_update_check: Some("2026-10-02T00:00:00Z".to_owned()),
            etag: Some("W/\"abc\"".to_owned()),
            first_run_completed: true,
            unknown: serde_json::Map::new(),
        };

        save_to(&file, &settings).expect("a write");
        let result = load_from(&file);

        assert_eq!(result.settings, settings);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);

        cleanup(&dir);
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_defaults_with_a_warning() {
        let dir = temp_dir("corrupt");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(&file, "{ this is not json").expect("a fixture");

        let result = load_from(&file);

        assert_eq!(result.settings, Settings::default());
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
        // The warning must name the file and admit the data will be replaced.
        assert!(result.warnings[0].contains("settings.json"), "{:?}", result.warnings);
        assert!(result.warnings[0].contains("replace"), "{:?}", result.warnings);

        cleanup(&dir);
    }

    #[test]
    fn an_empty_file_is_treated_as_corrupt_rather_than_panicking() {
        let dir = temp_dir("empty");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(&file, "").expect("a fixture");

        let result = load_from(&file);

        assert_eq!(result.settings, Settings::default());
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);

        cleanup(&dir);
    }

    #[test]
    fn a_wrongly_typed_field_is_reported_rather_than_panicking() {
        let dir = temp_dir("wrongtype");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(&file, r#"{"cache_limit": "ten"}"#).expect("a fixture");

        let result = load_from(&file);

        assert_eq!(result.settings, Settings::default());
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
        // serde names the type mismatch and the position, not the field:
        // "invalid type: string \"ten\", expected usize at line 1 column 21".
        // The position plus the offending value is what makes this actionable,
        // so that detail must not be swallowed by a generic message.
        assert!(result.warnings[0].contains("expected usize"), "{:?}", result.warnings);
        assert!(result.warnings[0].contains("settings.json"), "{:?}", result.warnings);

        cleanup(&dir);
    }

    #[test]
    fn a_partial_file_keeps_the_fields_it_does_have() {
        // A hand-written or older file must not lose what it does set.
        let dir = temp_dir("partial");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(&file, r#"{"cache_limit": 3, "auto_update_channel": "alpha"}"#)
            .expect("a fixture");

        let result = load_from(&file);

        assert_eq!(result.settings.cache_limit, 3);
        assert_eq!(result.settings.auto_update_channel, "alpha");
        // Unset fields take the defaults, not garbage.
        assert_eq!(result.settings.etag, None);
        assert!(!result.settings.first_run_completed);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);

        cleanup(&dir);
    }

    #[test]
    fn an_unknown_channel_is_kept_as_written_and_reported() {
        // Reported, never corrected: opening the launcher must not rewrite a
        // value the user (or a later phase) put in the file.
        let dir = temp_dir("unknownchan");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(&file, r#"{"auto_update_channel": "beta"}"#).expect("a fixture");

        let result = load_from(&file);

        assert_eq!(result.settings.auto_update_channel, "beta");
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
        assert!(result.warnings[0].contains("beta"), "{:?}", result.warnings);

        cleanup(&dir);
    }

    // --- unknown-key preservation -----------------------------------------

    #[test]
    fn unknown_keys_survive_a_rewrite() {
        // The load that matters: the sidecar or a later phase adds a field, and
        // an older shell must not delete it when the user clicks a menu item.
        let dir = temp_dir("unknownkeys");
        let file = dir.join(SETTINGS_FILE_NAME);
        std::fs::write(
            &file,
            r#"{
              "auto_update_channel": "rc",
              "cache_limit": 10,
              "future_feature_flag": true,
              "sessions": {"pinned": ["0.1.5-rc.2"]}
            }"#,
        )
        .expect("a fixture");

        let state = SettingsState::at(Some(file.clone()));
        assert_eq!(
            state.snapshot().unknown.get("future_feature_flag"),
            Some(&serde_json::Value::Bool(true))
        );

        state
            .set_auto_update_channel("alpha")
            .expect("a successful write");

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("the file")).expect("json");
        let object = raw.as_object().expect("an object");

        assert_eq!(object.get("auto_update_channel").and_then(|v| v.as_str()), Some("alpha"));
        assert_eq!(
            object.get("future_feature_flag"),
            Some(&serde_json::Value::Bool(true)),
            "a Rust rewrite deleted an unknown key: {object:?}"
        );
        assert_eq!(
            object
                .get("sessions")
                .and_then(|v| v.get("pinned"))
                .and_then(|v| v.as_array())
                .map(|values| values.len()),
            Some(1),
            "a nested unknown key did not survive: {object:?}"
        );

        cleanup(&dir);
    }

    // --- writing -----------------------------------------------------------

    #[test]
    fn a_write_is_atomic_and_leaves_no_temp_file() {
        let dir = temp_dir("atomic");
        let file = dir.join(SETTINGS_FILE_NAME);

        save_to(&file, &Settings::default()).expect("a first write");
        let second = Settings {
            cache_limit: 2,
            ..Settings::default()
        };
        save_to(&file, &second).expect("a replacing write");

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("the directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "a temp file was left behind: {leftovers:?}");

        let result = load_from(&file);
        assert_eq!(result.settings.cache_limit, 2);

        cleanup(&dir);
    }

    #[test]
    fn the_file_ends_with_a_newline_like_the_sidecars_writer() {
        // `writeJsonAtomic` in the sidecar writes `JSON.stringify(..., 2) + "\n"`;
        // matching it keeps a diff between the two writers meaningless.
        let dir = temp_dir("newline");
        let file = dir.join(SETTINGS_FILE_NAME);

        save_to(&file, &Settings::default()).expect("a write");

        let text = std::fs::read_to_string(&file).expect("the file");
        assert!(text.ends_with('\n'), "{text:?}");
        assert!(text.contains("\n  \"auto_update_channel\""), "expected pretty JSON: {text:?}");

        cleanup(&dir);
    }

    #[test]
    fn a_save_that_cannot_create_its_directory_leaves_memory_unchanged() {
        // A failed write must not leave the UI showing a value that was never
        // persisted. The blocker is a FILE where a directory would have to go.
        let dir = temp_dir("savefail");
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "not a directory").expect("a fixture");

        let state = SettingsState::at(Some(blocker.join(SETTINGS_FILE_NAME)));
        assert_eq!(state.auto_update_channel(), "rc");

        let error = state
            .set_auto_update_channel("alpha")
            .expect_err("the write must fail");

        // The failure names the directory it could not create, which is where
        // the problem actually is.
        assert!(error.contains("blocker"), "{error}");
        assert_eq!(
            state.auto_update_channel(),
            "rc",
            "memory must not advance past a failed write"
        );

        cleanup(&dir);
    }

    // --- validation --------------------------------------------------------

    #[test]
    fn the_selectable_channels_are_exactly_rc_alpha_and_all() {
        assert!(is_selectable_channel("rc"));
        assert!(is_selectable_channel("alpha"));
        assert!(is_selectable_channel("all"));

        assert!(!is_selectable_channel("stable"));
        assert!(!is_selectable_channel("RC"), "channel values are case-sensitive");
        assert!(!is_selectable_channel(""));
        assert!(!is_selectable_channel("beta"));
    }

    #[test]
    fn the_auto_update_options_cover_every_selectable_channel() {
        // One source of truth: everything the user may select must be an option
        // in the menu, and `stable` must stay visible-but-disabled (Q48) even
        // though it cannot be selected yet.
        for channel in SELECTABLE_CHANNELS {
            assert!(
                AUTO_UPDATE_OPTIONS.contains(&channel),
                "{channel} is selectable but not an option"
            );
        }

        assert!(AUTO_UPDATE_OPTIONS.contains(&"stable"));
        assert!(!is_selectable_channel("stable"));
        assert_eq!(AUTO_UPDATE_OPTIONS.len(), 4, "section 3.2 defines exactly four options");
    }

    #[test]
    fn the_registry_channels_are_the_three_real_channels() {
        // `all` is a policy, not a channel: the menu keys channel availability
        // off this distinction, so it must not drift.
        assert!(is_registry_channel("stable"));
        assert!(is_registry_channel("rc"));
        assert!(is_registry_channel("alpha"));

        assert!(!is_registry_channel("all"));
        assert!(!is_registry_channel("beta"));
        assert!(!is_registry_channel(""));
    }

    #[test]
    fn validating_stable_explains_why_it_is_unavailable() {
        // Section 3.1/Q48: no stable release exists yet, so the option is
        // disabled; the message has to say that rather than "invalid".
        let error = validate_channel("stable").expect_err("stable must be refused");

        assert!(error.contains("stable channel has no release"), "{error}");
        assert!(error.contains("rc, alpha, all"), "{error}");
    }

    #[test]
    fn validating_an_unknown_channel_lists_the_alternatives() {
        let error = validate_channel("beta").expect_err("beta must be refused");

        assert!(error.contains("beta"), "{error}");
        assert!(error.contains("rc, alpha, all"), "{error}");
        assert!(validate_channel("alpha").is_ok());
    }

    // --- managed state -----------------------------------------------------

    #[test]
    fn setting_the_channel_writes_the_file_immediately() {
        let dir = temp_dir("statewrite");
        let file = dir.join(SETTINGS_FILE_NAME);

        let state = SettingsState::at(Some(file.clone()));
        assert!(!file.exists(), "constructing the state must not create the file");

        let settings = state.set_auto_update_channel("alpha").expect("a write");

        assert_eq!(settings.auto_update_channel, "alpha");
        assert_eq!(state.auto_update_channel(), "alpha");
        assert!(file.exists(), "a mutation must write");

        // A second reader (the sidecar, or a later launcher run) sees it.
        assert_eq!(load_from(&file).settings.auto_update_channel, "alpha");

        cleanup(&dir);
    }

    #[test]
    fn a_rejected_channel_is_not_written() {
        let dir = temp_dir("rejectnowrite");
        let file = dir.join(SETTINGS_FILE_NAME);

        let state = SettingsState::at(Some(file.clone()));
        let error = state.set_auto_update_channel("stable").expect_err("stable is refused");

        assert!(error.contains("stable"), "{error}");
        assert_eq!(state.auto_update_channel(), "rc");
        assert!(!file.exists(), "a rejected value must not create the file");

        cleanup(&dir);
    }

    #[test]
    fn completing_the_first_run_records_the_flag_and_the_channel_together() {
        let dir = temp_dir("firstrun");
        let file = dir.join(SETTINGS_FILE_NAME);

        let state = SettingsState::at(Some(file.clone()));
        assert!(!state.first_run_completed());

        state.complete_first_run(DEFAULT_CHANNEL).expect("a write");

        assert!(state.first_run_completed());
        let reloaded = load_from(&file).settings;
        assert!(reloaded.first_run_completed);
        assert_eq!(reloaded.auto_update_channel, DEFAULT_CHANNEL);

        cleanup(&dir);
    }

    #[test]
    fn a_state_without_a_path_reports_instead_of_panicking() {
        // An unresolvable data directory is reported, never guessed at.
        let state = SettingsState::at(None);

        assert_eq!(state.auto_update_channel(), "rc");
        let error = state
            .set_auto_update_channel("alpha")
            .expect_err("there is nowhere to write");
        assert!(error.contains("data directory"), "{error}");
    }

    // --- data directory ----------------------------------------------------

    #[test]
    fn the_windows_data_dir_follows_local_app_data() {
        let env = env_of(&[("LOCALAPPDATA", r"C:\Users\dev\AppData\Local")]);

        let dir = default_data_dir_for("windows", &env, Some(r"C:\Users\dev")).expect("a path");

        assert_eq!(dir, PathBuf::from(r"C:\Users\dev\AppData\Local").join("DSH-Dock"));
        // Section 2.4: the data directory must never be the install directory
        // (`%LOCALAPPDATA%\Programs\DSH-Dock`), which is the v0.5.0 bug.
        assert!(!dir.to_string_lossy().contains("Programs"));
    }

    #[test]
    fn the_windows_data_dir_falls_back_to_the_home_directory() {
        let dir = default_data_dir_for("windows", &env_of(&[]), Some(r"C:\Users\dev"))
            .expect("a fallback path");

        assert_eq!(dir, PathBuf::from(r"C:\Users\dev\AppData\Local").join("DSH-Dock"));
    }

    #[test]
    fn a_blank_local_app_data_counts_as_unset() {
        let env = env_of(&[("LOCALAPPDATA", "   ")]);

        let dir = default_data_dir_for("windows", &env, Some(r"C:\Users\dev")).expect("a path");

        assert_eq!(dir, PathBuf::from(r"C:\Users\dev\AppData\Local").join("DSH-Dock"));
    }

    #[test]
    fn the_macos_data_dir_lives_in_application_support() {
        let dir = default_data_dir_for("macos", &env_of(&[]), Some("/Users/dev")).expect("a path");

        assert_eq!(
            dir,
            PathBuf::from("/Users/dev")
                .join("Library")
                .join("Application Support")
                .join("DSH-Dock")
        );
    }

    #[test]
    fn the_linux_data_dir_honours_xdg_data_home() {
        let env = env_of(&[("XDG_DATA_HOME", "/home/dev/.local/state")]);

        let dir = default_data_dir_for("linux", &env, Some("/home/dev")).expect("a path");

        assert_eq!(dir, PathBuf::from("/home/dev/.local/state").join("dsh-dock"));
    }

    #[test]
    fn the_linux_data_dir_defaults_to_local_share() {
        let dir = default_data_dir_for("linux", &env_of(&[]), Some("/home/dev")).expect("a path");

        assert_eq!(
            dir,
            PathBuf::from("/home/dev").join(".local").join("share").join("dsh-dock")
        );
    }

    #[test]
    fn an_unresolvable_home_reports_rather_than_guessing() {
        // No override, no base directory: the caller must be told, not handed a
        // path relative to the current working directory.
        assert_eq!(default_data_dir_for("windows", &env_of(&[]), None), None);
        assert_eq!(default_data_dir_for("macos", &env_of(&[]), None), None);
        assert_eq!(default_data_dir_for("linux", &env_of(&[]), None), None);
    }

    #[test]
    fn the_override_wins_over_every_platform_default() {
        let home = Some("/home/dev");
        let env = env_of(&[("DSH_DOCK_DATA_DIR", "/tmp/dsh-dock-isolated")]);
        let expected = std::path::absolute(PathBuf::from("/tmp/dsh-dock-isolated")).unwrap();

        for target in ["windows", "macos", "linux"] {
            let dir = data_dir_from(target, &env, home).expect("the override");
            assert_eq!(dir, expected, "{target} ignored the override");
        }

        // On Windows `std::path::absolute` of a POSIX-looking literal still
        // yields something absolute, which is all this asserts.
        assert!(data_dir_from("linux", &env, home).expect("a path").is_absolute());
    }

    #[test]
    fn a_blank_override_counts_as_unset() {
        let env = env_of(&[("DSH_DOCK_DATA_DIR", "  ")]);

        let dir = data_dir_from("linux", &env, Some("/home/dev")).expect("the platform default");

        assert_eq!(
            dir,
            PathBuf::from("/home/dev").join(".local").join("share").join("dsh-dock")
        );
    }

    #[test]
    fn a_tilde_override_expands_against_home() {
        // Mirrors expandHome in the sidecar, so both writers agree on the path.
        let env = env_of(&[("DSH_DOCK_DATA_DIR", "~/dsh-dock-test")]);

        let dir = data_dir_from("linux", &env, Some("/home/dev")).expect("a path");

        // `~` must have been expanded against the SUPPLIED home (not the real
        // one), and the result is then made absolute, so the expectation goes
        // through the same final step.
        let expected =
            std::path::absolute(PathBuf::from("/home/dev").join("dsh-dock-test")).expect("absolute");
        assert_eq!(dir, expected);
    }

    #[test]
    fn a_named_tilde_is_left_alone_rather_than_guessed_at() {
        let env = env_of(&[("DSH_DOCK_DATA_DIR", "~someone/else")]);

        let dir = data_dir_from("linux", &env, Some("/home/dev")).expect("a path");

        assert!(dir.to_string_lossy().contains("~someone"), "{dir:?}");
    }

    #[test]
    fn the_environment_is_read_without_panicking_on_odd_values() {
        // `std::env::vars()` panics on a non-Unicode variable; the lossy reader
        // must not, because a launcher cannot die over an unrelated variable.
        let env = environment();
        let _ = home_from(&env);
        let _ = data_dir_from(std::env::consts::OS, &env, home_from(&env).as_deref());
    }

    // --- byte-exact per-OS paths -------------------------------------------
    //
    // These compare STRINGS, not PathBufs, on purpose: on Windows
    // `Path::new("/a/b") == Path::new("\\a\\b")`, so a PathBuf comparison would
    // not catch a wrong separator. The flavour-aware core exists so the macOS
    // and Linux results are checkable on any host.

    #[test]
    fn the_posix_branches_produce_byte_exact_paths_on_any_host() {
        assert_eq!(
            default_data_dir_string_for("macos", &env_of(&[]), Some("/Users/dev")).unwrap(),
            "/Users/dev/Library/Application Support/DSH-Dock"
        );

        assert_eq!(
            default_data_dir_string_for("linux", &env_of(&[]), Some("/home/dev")).unwrap(),
            "/home/dev/.local/share/dsh-dock"
        );

        assert_eq!(
            default_data_dir_string_for(
                "linux",
                &env_of(&[("XDG_DATA_HOME", "/home/dev/.local/state")]),
                Some("/home/dev")
            )
            .unwrap(),
            "/home/dev/.local/state/dsh-dock"
        );
    }

    #[test]
    fn the_windows_branch_produces_byte_exact_paths_on_any_host() {
        assert_eq!(
            default_data_dir_string_for(
                "windows",
                &env_of(&[("LOCALAPPDATA", r"C:\Users\dev\AppData\Local")]),
                Some(r"C:\Users\dev")
            )
            .unwrap(),
            r"C:\Users\dev\AppData\Local\DSH-Dock"
        );

        // The home fallback, same flavour.
        assert_eq!(
            default_data_dir_string_for("windows", &env_of(&[]), Some(r"C:\Users\dev")).unwrap(),
            r"C:\Users\dev\AppData\Local\DSH-Dock"
        );
    }

    #[test]
    fn the_flavour_follows_the_target_os_not_the_host() {
        // The whole point: simulating macOS on Windows must not emit `\`.
        assert_eq!(PathFlavour::for_target_os("windows"), PathFlavour::Windows);
        assert_eq!(PathFlavour::for_target_os("macos"), PathFlavour::Posix);
        assert_eq!(PathFlavour::for_target_os("linux"), PathFlavour::Posix);
        // Anything unrecognised takes the XDG branch, so it must be POSIX too.
        assert_eq!(PathFlavour::for_target_os("freebsd"), PathFlavour::Posix);
        assert_eq!(PathFlavour::for_target_os(""), PathFlavour::Posix);

        let macos = default_data_dir_string_for("macos", &env_of(&[]), Some("/Users/dev")).unwrap();
        assert!(!macos.contains('\\'), "a POSIX target emitted a Windows separator: {macos}");
    }

    #[test]
    fn a_trailing_separator_on_a_base_is_not_doubled() {
        // An environment value with a trailing slash is common enough to matter.
        assert_eq!(
            default_data_dir_string_for(
                "linux",
                &env_of(&[("XDG_DATA_HOME", "/home/dev/.local/state/")]),
                Some("/home/dev")
            )
            .unwrap(),
            "/home/dev/.local/state/dsh-dock"
        );

        assert_eq!(
            default_data_dir_string_for(
                "windows",
                &env_of(&[("LOCALAPPDATA", r"C:\Users\dev\AppData\Local\")]),
                Some(r"C:\Users\dev")
            )
            .unwrap(),
            r"C:\Users\dev\AppData\Local\DSH-Dock"
        );
    }

    #[test]
    fn the_pathbuf_form_agrees_with_the_flavour_exact_form() {
        // Production uses the PathBuf form with the HOST's OS name, so the two
        // must not drift apart.
        let env = env_of(&[]);
        let host_os = std::env::consts::OS;

        let exact = default_data_dir_string_for(host_os, &env, Some("home")).unwrap();
        let path = default_data_dir_for(host_os, &env, Some("home")).unwrap();

        assert_eq!(PathBuf::from(exact), path);
    }

    #[test]
    fn the_data_dir_rule_agrees_with_the_sidecars_names() {
        // Both writers must resolve the same file (section 3.11). This is a
        // cheap guard against a rename on one side only: the Rust constants
        // must still appear in the sidecar's own resolver.
        let sidecar = include_str!("../../sidecar/lib/state.js");

        assert!(sidecar.contains(DATA_DIR_ENV_VAR), "{DATA_DIR_ENV_VAR} is not in state.js");
        assert!(sidecar.contains(APP_DIR_NAME), "{APP_DIR_NAME} is not in state.js");
        assert!(sidecar.contains(APP_DIR_SLUG), "{APP_DIR_SLUG} is not in state.js");
        assert!(sidecar.contains(SETTINGS_FILE_NAME), "{SETTINGS_FILE_NAME} is not in state.js");

        // And the override must win in both implementations.
        assert!(
            sidecar.contains("resolveDataDir") && sidecar.contains("dataDirOverride"),
            "the sidecar's override path changed shape"
        );
    }
}
