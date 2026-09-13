/**
 * Launcher state directory and state files
 * (docs/PROJECT_DSH-DOCK.md sections 2.3 and 2.4).
 *
 * Responsibilities:
 *   - resolve the per-OS launcher data directory
 *   - resolve the entries inside it
 *   - read/write `runtime-state.json` atomically
 *
 * Per-OS launcher data directory (section 2.4):
 *   Windows  %LOCALAPPDATA%\DSH-Dock\
 *   macOS    ~/Library/Application Support/DSH-Dock/
 *   Linux    $XDG_DATA_HOME/dsh-dock/ (default ~/.local/share/dsh-dock/)
 *
 * `$DSH_HOME` is NOT resolved here. It is the harness's own environment
 * variable: passed through untouched, never read, written, or cached
 * (section 2.4 and Q8). Nothing in this module may live inside it.
 *
 * Every path here is resolved at runtime and returned absolute. No absolute
 * path is ever written into a source file or a config file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory name used on Windows and macOS. */
export const APP_DIR_NAME = "DSH-Dock";

/** Directory name used on Linux, where lowercase is conventional. */
export const APP_DIR_SLUG = "dsh-dock";

/**
 * Environment variable that overrides the launcher data directory.
 *
 * This is a supported product feature, not a test hook: it lets a power user
 * isolate launcher data (a second install, a portable setup, or Phase 2's
 * multi-version test runs) without touching the OS-native location.
 *
 * The launcher only ever READS this variable. Production code NEVER sets it -
 * not for any code path, not in any environment. Only an operator, a shell, or
 * a test script sets it (decision 5 of the Phase 1 plan).
 *
 * The name is exported so callers and tests share one spelling instead of
 * repeating a bare string literal.
 */
export const DATA_DIR_ENV_VAR = "DSH_DOCK_DATA_DIR";

/**
 * Name of the state file that records the running harness (section 2.3).
 *
 * SHAPE NOTE - the `url` field carries a SECRET, and it is deliberately stored
 * in full rather than reconstructed from `port`:
 *
 *   The harness prints `dsh web: http://127.0.0.1:<port>?<token>` (see
 *   @deepseek-ai/dsh-web-app, `announceReady`). The token is a per-boot signed
 *   credential: the webview exchanges it for a cookie, and requests without it
 *   are refused. A URL rebuilt as `http://127.0.0.1:<port>/` would therefore be
 *   rejected - so `url` is stored VERBATIM and `port` is kept only as a cheap
 *   human-readable field and for diagnostics.
 *
 *   Two consequences Phase 1 relies on:
 *     1. Adopt probes the exact stored URL, never a reconstructed base URL.
 *     2. A URL that parses but lacks the token is treated as INVALID state, so
 *        a stale token can never be adopted.
 *
 *   Staleness across a version switch (the token dies with its process) is a
 *   Phase 2 concern, once more than one harness/version can exist at a time.
 */
const RUNTIME_STATE_FILE = "runtime-state.json";

/** Leading integer of [`RUNTIME_STATE_SCHEMA_VERSION`]. Not bumped lightly. */
export const RUNTIME_STATE_SCHEMA_VERSION = 1;

/**
 * Private sentinel meaning "the state file does not exist".
 *
 * `Symbol` is chosen precisely because no JSON document can parse to it, so a
 * present-but-degenerate file can never be mistaken for an absent one.
 */
const ABSENT = Symbol("runtime-state-absent");

/**
 * Expands a leading `~` against the user's home directory.
 *
 * Required because the environment override is typed by a human and
 * convention says `~` should work. Only a bare or `/`-or-`\`-prefixed `~` is
 * expanded; a `~name` form is left alone rather than guessed at.
 */
function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Returns the environment-provided data directory override, or null.
 *
 * A blank or whitespace-only value counts as unset: an empty environment
 * variable must never silently resolve to the current working directory.
 */
export function dataDirOverride() {
  const raw = process.env[DATA_DIR_ENV_VAR];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return path.resolve(expandHome(trimmed));
}

/**
 * The path flavour that belongs to a *target* platform.
 *
 * Needed because [`defaultDataDirFor`] is pure and takes the platform as an
 * argument: joining with the host's `path` would emit Windows separators while
 * simulating macOS, so the resolution and any test asserting it would agree on
 * the same wrong answer.
 */
function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Pure per-OS data-directory resolution, with every input supplied explicitly
 * (section 2.4).
 *
 * Kept pure and exported so all three OS branches are testable on one machine.
 * The alternative - reading `process.platform` directly - would leave the macOS
 * and Linux branches unverifiable until Phase 4, which is how per-OS bugs hide.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function defaultDataDirFor(platform, env, home) {
  const join = pathFor(platform).join;

  if (platform === "win32") {
    // LOCALAPPDATA is the correct base on Windows; `AppData\Local` under the
    // home directory is the documented fallback when it is unset.
    const base = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(base, APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", APP_DIR_NAME);
  }

  // XDG spec: $XDG_DATA_HOME, defaulting to ~/.local/share. A blank value is
  // treated as unset rather than becoming a relative or empty base.
  const xdg =
    typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim().length > 0
      ? env.XDG_DATA_HOME.trim()
      : join(home, ".local", "share");
  return join(xdg, APP_DIR_SLUG);
}

/**
 * Absolute path of the launcher data directory for the current platform.
 *
 * READ-ONLY use of [`DATA_DIR_ENV_VAR`]: if it is set it wins outright,
 * otherwise the OS-native default is used. This function must never assign to
 * `process.env[DATA_DIR_ENV_VAR]` - see the constant's note above.
 *
 * This is the launcher's OWN state directory. It is never a project file path
 * and is never persisted into a config file.
 */
export function resolveDataDir() {
  const override = dataDirOverride();
  if (override !== null) return override;
  return defaultDataDirFor(process.platform, process.env, os.homedir());
}

/**
 * Entries that live inside the launcher data directory (section 2.4).
 *
 * Returned as a map so callers never hand-build path fragments. Paths are
 * absolute and are computed fresh on each call, so a changed override takes
 * effect immediately within the same process.
 */
export function resolveStatePaths() {
  const root = resolveDataDir();
  return Object.freeze({
    root,
    settings: path.join(root, "settings.json"),
    runtimeState: path.join(root, RUNTIME_STATE_FILE),
    versions: path.join(root, "versions"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
    npmCache: path.join(root, ".npm-cache"),
  });
}

/**
 * Creates the data directory and the subdirectories the launcher owns.
 *
 * Idempotent. Deliberately does NOT create `settings.json` or
 * `runtime-state.json`: an absent state file is meaningful ("nothing has been
 * started yet") and those files are created by the code that owns them.
 */
export function ensureDataDirs(paths = resolveStatePaths()) {
  const created = [];
  for (const dir of [paths.root, paths.versions, paths.logs, paths.cache]) {
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  }
  return created;
}

/**
 * Deterministic log-file name for one harness instance.
 *
 * One file per instance keeps a crashed boot readable after a restart has
 * already begun, and guarantees the launcher never appends two harnesses'
 * mixed output into one file.
 *
 * The sanitizer rejects `.` and `..` outright as well as path separators and
 * any other unsafe character. Today the id is generated internally, but this
 * guard is what stops a future user-supplied instance name from becoming a
 * path-traversal vector.
 *
 * TODO(Phase 4): rotate or cap the number of retained log files. They
 * currently accumulate forever; retention is a Phase 4 concern.
 */
export function harnessLogFile(instanceId) {
  const raw = String(instanceId ?? "");
  const unsafe = raw === "." || raw === ".." || !/^[A-Za-z0-9._-]+$/.test(raw);
  const name = unsafe ? "harness.log" : `harness-${raw}.log`;
  return path.join(resolveStatePaths().logs, name);
}

/** Reads and parses a JSON file. Returns `fallback` when it does not exist. */
export function readJsonFile(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
  return JSON.parse(text);
}

/**
 * Writes a JSON file atomically: write a sibling temp file, then rename.
 *
 * A rename within one directory is atomic on both NTFS and POSIX, so a reader
 * can never observe a half-written `runtime-state.json`. The temporary file is
 * given a `.tmp` extension rather than a leading dot so a failure leaves an
 * obvious artifact instead of a file that looks ignored.
 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/**
 * Validates a parsed `runtime-state.json` against the expected shape.
 *
 * Returns an array of human-readable problems; an empty array means valid.
 * Every problem is reported rather than the first, because this file is the
 * launcher's only record of a running harness: when it is wrong, the operator
 * needs to see exactly how.
 */
export function validateRuntimeState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["state is not a JSON object"];
  }

  const problems = [];

  if (value.version !== RUNTIME_STATE_SCHEMA_VERSION) {
    problems.push(
      `version must be ${RUNTIME_STATE_SCHEMA_VERSION}, got ${JSON.stringify(value.version)}`,
    );
  }

  if (!Number.isInteger(value.pid) || value.pid <= 0) {
    problems.push(`pid must be a positive integer, got ${JSON.stringify(value.pid)}`);
  }

  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    problems.push(`port must be 1-65535, got ${JSON.stringify(value.port)}`);
  }

  if (typeof value.url !== "string" || value.url.length === 0) {
    problems.push(`url must be a non-empty string, got ${JSON.stringify(value.url)}`);
  } else if (!/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/|$|\?)/.test(value.url)) {
    // IPv4 literal only: section 2.7 forbids `localhost` anywhere a listener
    // is addressed, because Vite/WebView2 resolve it inconsistently.
    problems.push(`url must be an http://127.0.0.1:<port>/... URL, got ${value.url}`);
  } else if (!/[?&]token=/.test(value.url)) {
    // The harness always answers with a token-bearing URL - see the note on
    // [`RUNTIME_STATE_URL_TOKEN_NOTE`]. A tokenless URL therefore means we
    // recorded something incomplete, and a later probe or window load would
    // fail in a confusing way. Reject it here, where the cause is obvious.
    problems.push(`url must carry the harness token query parameter, got ${value.url}`);
  }

  if (typeof value.harnessVersion !== "string" || value.harnessVersion.length === 0) {
    problems.push("harnessVersion must be a non-empty string");
  }

  if (typeof value.installDir !== "string" || value.installDir.length === 0) {
    problems.push("installDir must be a non-empty string");
  }

  if (typeof value.instanceId !== "string" || value.instanceId.length === 0) {
    problems.push("instanceId must be a non-empty string");
  }

  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    problems.push(`startedAt must be an ISO 8601 timestamp, got ${JSON.stringify(value.startedAt)}`);
  }

  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    problems.push(`recordedAt must be an ISO 8601 timestamp, got ${JSON.stringify(value.recordedAt)}`);
  }

  return problems;
}

/**
 * Reads `runtime-state.json`.
 *
 * Returns a discriminated result rather than throwing, because every caller
 * has to make the same decision and the three cases need different handling:
 *
 *   { status: "absent" }                - never started, or already cleaned up
 *   { status: "invalid", problems }     - present but unusable; do NOT trust it
 *   { status: "ok", state }             - usable
 *
 * Malformed JSON is reported as `invalid`, not thrown, for the same reason: an
 * unreadable state file must lead to a reap-and-start, never to a crash.
 */
export function readRuntimeState(file = resolveStatePaths().runtimeState) {
  let parsed;
  try {
    // The sentinel MUST be a value JSON cannot produce, so "absent" and "present
    // but empty/odd" stay distinguishable. `undefined` does not work here:
    // `readJsonFile` would return it as the fallback AND `JSON.parse` can never
    // yield it, which collapses the two cases into one.
    parsed = readJsonFile(file, ABSENT);
  } catch (error) {
    return { status: "invalid", problems: [`unreadable: ${error.message}`], raw: null };
  }

  if (parsed === ABSENT) return { status: "absent", problems: [], raw: null };

  const problems = validateRuntimeState(parsed);
  if (problems.length > 0) return { status: "invalid", problems, raw: parsed };

  return { status: "ok", problems: [], state: parsed };
}

/** Writes `runtime-state.json` atomically. Validates before writing. */
export function writeRuntimeState(state, file = resolveStatePaths().runtimeState) {
  const problems = validateRuntimeState(state);
  if (problems.length > 0) {
    throw new Error(`Refusing to write an invalid runtime state: ${problems.join("; ")}`);
  }
  writeJsonAtomic(file, state);
  return state;
}

/**
 * Builds a `runtime-state.json` value with `recordedAt` stamped now.
 *
 * Kept separate from the writer so tests can supply a fixed `recordedAt` and
 * so the "when was this written" question never depends on the caller.
 */
export function buildRuntimeState(fields) {
  return {
    version: RUNTIME_STATE_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    ...fields,
  };
}

/** Removes `runtime-state.json`. Missing is success, matching cleanup intent. */
export function clearRuntimeState(file = resolveStatePaths().runtimeState) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
