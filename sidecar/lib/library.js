/**
 * The local version library
 * (docs/PROJECT_DSH-DOCK.md section 3.1, Phase 2 milestone 1).
 *
 * WHAT CHANGED IN PHASE 2. Until now `<data-dir>/versions/` held exactly one
 * version, so nothing ever had to ask "which versions are here?" - the question
 * was answered by whichever version the startup path had just installed. This
 * module makes the directory a library: N versions, each independently
 * enumerable, inspectable, installable and deletable.
 *
 * THE GROUND TRUTH IS THE FILESYSTEM. A catalogue
 * (`<data-dir>/versions/catalogue.json`, see `catalogue.js`) records WHEN each
 * version was installed and its checksum, so the UI and the menu can order
 * versions by date. That file is ADVISORY. This module never consults it to
 * decide whether a version exists: a missing, corrupt or stale catalogue must
 * never make a working install invisible, and a catalogue entry must never
 * conjure a version that is not on disk.
 *
 * LAUNCHER-OWNED FILES LIVE IN THE LIBRARY ROOT. From Phase 2 on,
 * `versions/` contains more than version directories: `catalogue.json`, lock
 * files, and staging or corrupted leftovers. Every enumeration therefore routes
 * through [`isVersionDirName`], and anything that is not a safe version name is
 * skipped rather than treated as a version. A `readdir` result is NEVER a
 * version name until that predicate says so.
 *
 * THREE STATES, NOT TWO. A version directory that exists but is not complete is
 * a real and previously unnamed state - it is what a killed install leaves
 * behind, and it is also what a validated install will never produce. It is
 * reported as `partial` so callers can distinguish "not here" from "here and
 * broken", which need completely different UI and completely different repair.
 *
 * No I/O is performed at import time, and every path is computed from an
 * explicit `paths` object (or resolved fresh), so a test can point the whole
 * library at a scratch directory.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStatePaths, readRuntimeState } from "./state.js";
import {
  INCOMPLETE_MARKER,
  describeProblems,
  harnessBinPath,
  isFile,
  validateInstallTree,
} from "./validation.js";

/**
 * The three states a version name can be in, as reported by [`readLibraryEntry`].
 *
 * `installed` is the ONLY state that means "this version can be run".
 */
export const LIBRARY_STATE = Object.freeze({
  /** No directory for this version. */
  ABSENT: "absent",
  /** A directory exists, but the tree did not pass validation. */
  PARTIAL: "partial",
  /** A directory exists and the tree passes validation. */
  INSTALLED: "installed",
});

/** Names of launcher-owned entries that live in the library root. */
export const LIBRARY_ROOT_FILES = Object.freeze(["catalogue.json"]);

/** Prefix of a staged install's directory (see `harness-install.js`). */
export const STAGING_PREFIX = ".staging-";

/** Prefix of a preserved copy of an unparseable catalogue. */
export const CORRUPT_PREFIX = ".corrupt-";

/** Suffix of the library's advisory lock file (see `library-lock.js`). */
export const LOCK_FILE_NAME = ".lock";

/**
 * Whether a `readdir` entry name is a version directory name.
 *
 * This is the single gate between "there is a file called something in the
 * library root" and "there is a version installed". It is deliberately strict, and
 * it is the reason `catalogue.json` can live next to the versions without being
 * mistaken for one.
 *
 * THREE RULES, ALL REQUIRED:
 *
 *   1. `catalogue.json` is rejected BY NAME. The character rules alone do not
 *      exclude it - `catalogue.json` is a legal package-name shape (found by the
 *      Step 1 test, not theorised). Launcher-owned names must be excluded
 *      explicitly, or a version operator could be handed `catalogue.json` as a
 *      version and delete the library's index.
 *   2. Everything else must start with an alphanumeric character. Every remaining
 *      launcher-owned entry starts with `.` (`.staging-`, `.corrupt-`, `.lock`), so
 *      none can pass.
 *   3. IT MUST BE AN EXACT VERSION - the same pattern `harness-install.js` uses.
 *      The looser `^[0-9A-Za-z]` rule this replaced accepted `next`, `latest` and
 *      `1.x`, so a DELETE would have treated a dist-tag as a version name: it would
 *      not have deleted anything (no such directory), but it would have reported
 *      `not-installed` instead of refusing, and - far worse - `installVersion("next")`
 *      would have created a directory named `next`. `library.js` and
 *      `harness-install.js` must agree on what a version is; a test asserts both
 *      accept and reject the identical list.
 */
export const MAX_VERSION_LENGTH = 128;

export function isSafeVersionName(version) {
  if (typeof version !== "string" || version.length === 0) return false;
  if (version.length > MAX_VERSION_LENGTH) return false;
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}

export function isVersionDirName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (LIBRARY_ROOT_FILES.includes(name)) return false;
  if (name.startsWith(".")) return false;
  // `.` and `..` are impossible in a readdir result but possible from a caller.
  if (name === "." || name === "..") return false;
  return isSafeVersionName(name);
}

/** The library root: `<data-dir>/versions`. */
export function versionsRoot(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  return paths.versions;
}

/** Absolute install directory for a version. Throws on an unsafe name. */
export function installDirFor(version, options = {}) {
  if (!isVersionDirName(version)) {
    throw new Error(`Refusing to build an install path from an unsafe version name: ${version}`);
  }
  return path.join(versionsRoot(options), version);
}

/**
 * The path flavour for a target platform.
 *
 * Mirrors `pathFor(platform)` in `state.js`: the flavour must follow the TARGET
 * platform, not the host, or resolving a POSIX path with Windows rules (or the
 * reverse) mixes separators and produces a false answer. Every path decision in
 * this module routes through here so the two can never disagree.
 */
export function pathFlavour(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Whether `candidate` is inside the library root.
 *
 * The containment check every destructive operation routes through. It is
 * deliberately lexical (`resolve` + separator-aware compare) rather than
 * `realpath`-based: it must work for a path that does not exist yet, and it must
 * not follow a symlink out of the library and then claim the target is safe.
 *
 * Case handling: Windows compares case-insensitively, POSIX case-sensitively.
 * Getting this wrong in the permissive direction is a security bug; in the strict
 * direction it is a spurious refusal, which is the failure mode we prefer.
 */
export function isPathInsideVersions(candidate, options = {}) {
  const platform = options.platform ?? process.platform;
  const flavour = pathFlavour(platform);

  const root = flavour.resolve(versionsRoot(options));
  const target = flavour.resolve(String(candidate ?? ""));

  const normalize = platform === "win32" ? (value) => value.toLowerCase() : (value) => value;

  const rootNorm = normalize(root);
  const targetNorm = normalize(target);
  const separator = flavour.sep;

  if (rootNorm === targetNorm) return false; // the root itself is not "inside" it
  return targetNorm.startsWith(rootNorm.endsWith(separator) ? rootNorm : rootNorm + separator);
}

/**
 * Whether two paths name the same place.
 *
 * THE ONE PATH-IDENTITY PREDICATE IN THE LAUNCHER. Two operations depend on it
 * and must agree exactly: installing over a version that is currently running
 * (`harness-install.js`) and deleting a version that is currently running
 * (`library.js`, Step 4). If they disagreed, one guard would fire and the other
 * would not, and the failure mode is destroying the tree of the harness the user
 * is using - or overwriting it with an install that then cannot start.
 *
 * WHY STRING COMPARISON IS NOT ENOUGH, in order of how often each bites:
 *   1. Trailing separators - `...\versions\1.0.0\` and `...\versions\1.0.0`.
 *   2. Separator flavour - `\` from `runtime-state.json`, `/` from a JS caller.
 *   3. Case - `c:\users\...` vs `C:\Users\...`; Windows paths are
 *      case-insensitive and `runtime-state.json` stores whatever was current.
 *   4. `.` and `..` segments.
 *   5. 8.3 short names and symlinks - `C:\PROGRA~1` vs `C:\Program Files`,
 *      a junction, or a mapped drive. These are ONLY resolvable against the
 *      filesystem, which is why the exported wrapper below calls `realpathSync`.
 *
 * This function is pure and lexical, so it is fully unit-testable for cases 1-4
 * on any platform. Case 5 is handled by [`resolvesToSamePath`].
 */
export function pathsAreIdentical(left, right, options = {}) {
  const platform = options.platform ?? process.platform;
  const flavour = pathFlavour(platform);

  const leftResolved = flavour.resolve(String(left ?? ""));
  const rightResolved = flavour.resolve(String(right ?? ""));

  if (platform !== "win32") return leftResolved === rightResolved;
  return leftResolved.toLowerCase() === rightResolved.toLowerCase();
}

/**
 * [`pathsAreIdentical`], with both sides canonicalized through the filesystem
 * first.
 *
 * `realpathSync` cannot resolve a path that does not exist, and a version being
 * installed for the first time does not exist yet - so a failure to resolve is
 * not an error, it just means the lexical comparison is the best available answer.
 * Both sides are resolved independently so a symlinked runtime-state entry and a
 * real install directory still compare equal.
 */
export function resolvesToSamePath(left, right, options = {}) {
  const canonical = (value) => {
    try {
      return fs.realpathSync(String(value));
    } catch {
      return String(value);
    }
  };

  if (pathsAreIdentical(left, right, options)) return true;
  return pathsAreIdentical(canonical(left), canonical(right), options);
}

/**
 * `sha256:<hex>` of an install's harness `package.json`.
 *
 * WHY THIS FILE, AND NOT THE WHOLE TREE: hashing a full install means reading
 * hundreds of megabytes, which is far too slow to do during enumeration. The
 * harness's own manifest is small, stable in content (npm rewrites it only when
 * the version actually changes), and specific enough to catch the failure this
 * field exists for - a truncated or substituted install.
 *
 * Returns null when the manifest is missing, so a partial install still
 * enumerates instead of throwing.
 */
export function checksumFor(installDir) {
  const manifest = path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
  try {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(manifest)).digest("hex");
    return `sha256:${digest}`;
  } catch {
    return null;
  }
}

/**
 * The full state of one version, as far as the filesystem knows.
 *
 * @param {string} version
 * @param {{paths?: object, checksums?: boolean, validate?: boolean}} [options]
 *   `validate: false` skips tree validation and reports a directory that
 *   contains `bin.js` as installed. Used only where a caller has already
 *   validated (the install path) or wants a cheap existence probe.
 * @returns {{version: string, state: string, installDir: string, binPath: string,
 *            hasBin: boolean, hasIncompleteMarker: boolean, checksum: string|null,
 *            problems: Array}}
 */
export function readLibraryEntry(version, options = {}) {
  const installDir = installDirFor(version, options);
  const binPath = harnessBinPath(installDir);
  const markerPath = path.join(installDir, INCOMPLETE_MARKER);

  let hasDir = false;
  try {
    hasDir = fs.statSync(installDir).isDirectory();
  } catch {
    hasDir = false;
  }

  if (!hasDir) {
    return {
      version,
      state: LIBRARY_STATE.ABSENT,
      installDir,
      binPath,
      hasBin: false,
      hasIncompleteMarker: false,
      checksum: null,
      problems: [],
    };
  }

  const hasIncompleteMarker = isFile(markerPath);
  const hasBin = isFile(binPath);

  // The cheap probe: `catalogue.js` uses this shape when it only needs to know
  // whether the directory a catalogue entry names still exists.
  if (options.validate === false) {
    return {
      version,
      state: hasBin ? LIBRARY_STATE.INSTALLED : LIBRARY_STATE.PARTIAL,
      installDir,
      binPath,
      hasBin,
      hasIncompleteMarker,
      checksum: options.checksums === true ? checksumFor(installDir) : null,
      problems: [],
    };
  }

  const validation = validateInstallTree(version, installDir);
  return {
    version,
    state: validation.ok ? LIBRARY_STATE.INSTALLED : LIBRARY_STATE.PARTIAL,
    installDir,
    binPath,
    hasBin,
    hasIncompleteMarker,
    checksum: options.checksums === true ? checksumFor(installDir) : null,
    problems: validation.problems,
  };
}

/** True when a version directory exists and passes validation. */
export function isInstalledInLibrary(version, options = {}) {
  return readLibraryEntry(version, options).state === LIBRARY_STATE.INSTALLED;
}

/**
 * Every directory in the library root, with launcher-owned entries separated.
 *
 * Never throws on an unreadable root: a missing `versions/` means an empty
 * library, which is a normal first-run state, not an error.
 *
 * @returns {{versions: string[], staging: string[], corrupt: string[], other: string[]}}
 */
export function scanLibraryRoot(options = {}) {
  const root = versionsRoot(options);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { versions: [], staging: [], corrupt: [], other: [] };
    }
    throw error;
  }

  const result = { versions: [], staging: [], corrupt: [], other: [] };

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(STAGING_PREFIX)) {
      result.staging.push(name);
    } else if (name.startsWith(CORRUPT_PREFIX)) {
      result.corrupt.push(name);
    } else if (isVersionDirName(name) && entry.isDirectory()) {
      result.versions.push(name);
    } else {
      // `catalogue.json`, `.lock`, a stray file, or a symlink. Recorded so a
      // diagnostic can show it, never treated as a version.
      result.other.push(name);
    }
  }

  for (const key of Object.keys(result)) result[key].sort();
  return result;
}

/**
 * Enumerates the library.
 *
 * ORDERING. The primary key is `installedAt` descending - "recent versions by
 * date", which is what section 3.8's submenu shows. Versions the catalogue does
 * not know about (installed by an older build, or by hand) have no date, so they
 * sort after the dated ones, by version string descending. The ordering is
 * deterministic for a given library, because an unordered list feeding a menu is
 * a bug that shows up as a reshuffling menu.
 *
 * `checksums` is OFF by default: hashing every install on every enumeration
 * would make a status poll read hundreds of megabytes. The catalogue populates
 * its checksums at install time instead.
 *
 * @param {{paths?: object, validate?: boolean, checksums?: boolean,
 *          installedAt?: Record<string, string>}} [options]
 * @returns {Array<object>} entries, installed and partial together
 */
export function listInstalledVersions(options = {}) {
  const scan = scanLibraryRoot(options);
  const installedAt = options.installedAt ?? {};

  const entries = scan.versions.map((version) => {
    const entry = readLibraryEntry(version, options);
    return { ...entry, installedAt: installedAt[version] ?? null };
  });

  entries.sort((left, right) => {
    const leftDated = left.installedAt !== null;
    const rightDated = right.installedAt !== null;

    if (leftDated !== rightDated) return leftDated ? -1 : 1;

    if (leftDated && rightDated && left.installedAt !== right.installedAt) {
      return left.installedAt < right.installedAt ? 1 : -1; // newest first
    }

    // Version-string descending. Not semantic-version ordering: a version
    // string is not guaranteed to parse as semver (the registry could publish
    // anything), and a comparator that silently mis-orders unparseable input is
    // worse than one that is merely alphabetical.
    if (left.version === right.version) return 0;
    return left.version < right.version ? 1 : -1;
  });

  return entries;
}

/** Just the versions whose trees validate. */
export function listReadyVersions(options = {}) {
  return listInstalledVersions(options).filter((entry) => entry.state === LIBRARY_STATE.INSTALLED);
}

/**
 * Leftovers from installs that never completed.
 *
 * Covers both halves of the problem: staging directories abandoned by a crash,
 * and - in the in-place fallback mode - version directories still carrying the
 * `.incomplete` marker. Neither is a version, and both are safe to delete: a
 * staging directory is by definition not the version it was staging.
 *
 * The marker-bearing directories are returned as VERSION names, because that is
 * how they must be deleted and how the UI will show them.
 */
export function partialInstallDirs(options = {}) {
  const scan = scanLibraryRoot(options);
  const marked = scan.versions.filter((version) =>
    isFile(path.join(versionsRoot(options), version, INCOMPLETE_MARKER)),
  );

  return { staging: scan.staging, incomplete: marked, corrupt: scan.corrupt };
}

/**
 * A one-line-per-entry human summary, for the launcher log and for pause-point
 * reporting. Not used by any control flow - the UI consumes the structured form.
 */
export function describeLibrary(entries) {
  if (entries.length === 0) return "  (the version library is empty)";

  return entries
    .map((entry) => {
      const when = entry.installedAt ?? "unknown date";
      const detail =
        entry.state === LIBRARY_STATE.INSTALLED
          ? entry.checksum ?? "no checksum"
          : describeProblems(entry.problems).replace(/\s+/g, " ").trim();
      return `  ${entry.version}  [${entry.state}]  installedAt=${when}  ${detail}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Machine-readable reasons a delete was refused or was a no-op.
 *
 * Stable strings: 2C's storage prompt matches on them to choose its wording, and
 * Phase 3's UI will render them.
 */
export const DELETE_REASON = Object.freeze({
  /** Deleted (or would delete, on a dry run). */
  OK: "deleted",
  /** An unsafe version name. Refused before any path was built. */
  UNSAFE_VERSION: "unsafe-version",
  /** The resolved path is not inside the library root. Refused before any I/O. */
  OUTSIDE_LIBRARY: "outside-library",
  /** The version is the one the recorded harness is running from. */
  RUNNING_VERSION: "running-version",
  /** The directory carries an `.incomplete` marker (a crashed install). */
  INCOMPLETE_INSTALL: "incomplete-install",
  /** Nothing on disk for this version - a no-op, not a failure. */
  NOT_INSTALLED: "not-installed",
  /** Another library operation holds the lock. */
  LOCKED: "locked",
  /** The removal itself failed. */
  FAILED: "failed",
});

/**
 * Directories in the library root that belong to a version but are NOT the
 * version's own directory: a staging directory from an interrupted install, and
 * the "moved aside" backup used by a force reinstall.
 *
 * MATCHED BY EXACT PREFIX, WITH THE SUFFIX RULE MADE EXPLICIT. A naive
 * `startsWith(".staging-" + version)` would also match a DIFFERENT version:
 * deleting `1.0.0` would sweep `.staging-1.0.0-rc.2-abc`. The staging name is
 * always `.staging-<version>-<nonce>`, and the backup is always
 * `.staging-<version>-replaced-<ts>`, so the boundary is the dash after the
 * version - which is exact, because a version name cannot contain a dash-free
 * suffix that a longer version could also satisfy (`1.0.0` vs `1.0.0-x` differ at
 * the character after the version, and both are checked literally).
 */
export function leftoverDirsFor(version, options = {}) {
  const root = versionsRoot(options);
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const stagingPrefix = `${STAGING_PREFIX}${version}-`;
  return entries
    .filter((name) => name.startsWith(stagingPrefix))
    .map((name) => path.join(root, name))
    .sort();
}

/** File count and total bytes under a path. Zero-shaped for a missing path. */
export function measureTree(target) {
  const result = { files: 0, directories: 0, bytes: 0, exists: false };

  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return result;
  }
  result.exists = true;

  if (!stat.isDirectory()) {
    result.files = 1;
    result.bytes = stat.size;
    return result;
  }

  result.directories = 1;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory is counted as existing but not enumerated.
      // Reporting a smaller number is better than throwing out of a dry run.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.directories += 1;
        walk(full);
      } else {
        result.files += 1;
        try {
          result.bytes += fs.lstatSync(full).size;
        } catch {
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  };

  walk(target);
  return result;
}

/**
 * Confirms the target is not the harness that is currently running.
 *
 * THE SAME PREDICATE AS THE INSTALL GUARD (`harness-install.js`), deliberately:
 * if the two guards disagreed about "the same path", one would fire and the other
 * would not, and the failure mode is destroying the tree of the harness the user is
 * using. Shared through [`resolvesToSamePath`], which is unit-tested for casing,
 * separators and `.`/`..`.
 *
 * An `options.runtimeState` may be supplied (a fixture or a test), otherwise
 * `runtime-state.json` is read. A missing or unreadable state file means nothing is
 * recorded, which is normal for a fresh data directory.
 */
export function runningVersionInfo(version, options = {}) {
  const paths = options.paths ?? resolveStatePaths();

  // An unsafe name never gets as far as a path join. `installDirFor` throws for one,
  // and this function is called from a guard chain that must not throw - a version
  // that cannot name a directory cannot be the running one.
  let target;
  try {
    target = installDirFor(version, { paths });
  } catch {
    return { running: false, pid: null, installDir: null, recordedAt: null };
  }

  const read = options.runtimeState ?? readRuntimeState(paths.runtimeState);
  if (read === null || read.status !== "ok") {
    return { running: false, pid: null, installDir: null, recordedAt: null };
  }

  const recorded = read.state.installDir;
  if (typeof recorded !== "string" || recorded.length === 0) {
    return { running: false, pid: null, installDir: null, recordedAt: null };
  }

  if (!resolvesToSamePath(recorded, target, options)) {
    return { running: false, pid: null, installDir: recorded, recordedAt: null };
  }

  return {
    running: true,
    pid: Number.isInteger(read.state.pid) ? read.state.pid : null,
    installDir: recorded,
    recordedAt: typeof read.state.recordedAt === "string" ? read.state.recordedAt : null,
  };
}

/**
 * Everything a delete would remove, without removing anything.
 *
 * THIS IS THE SEAM 2C's STORAGE PROMPT CALLS. Section 3.1 requires that exceeding
 * the cache limit PROMPTS and never silently evicts, so the prompt needs to say
 * exactly what the user is agreeing to: this version, this many files, this many
 * bytes. A dry run does not take the library lock - it is read-only, and its answer
 * describes the library as it is at the moment it looks.
 */
export function planDelete(version, options = {}) {
  const root = versionsRoot(options);
  const leftOvers = leftoverDirsFor(version, options);

  let installDir = null;
  let nameIsSafe = true;
  try {
    installDir = installDirFor(version, options);
  } catch {
    nameIsSafe = false;
  }

  // Two different questions, both worth answering:
  //   `nameIsSafe`        - could a path be built at all?
  //   `nameIsExactVersion` - is this an exact version, or a dist-tag/range?
  // The second is what the delete guard refuses on, because `next` CAN build a path
  // and would otherwise be reported as "not installed" rather than refused.
  const nameIsExactVersion = isSafeVersionName(version);

  const insideLibrary = nameIsSafe ? isPathInsideVersions(installDir, options) : false;

  const versionTree = nameIsSafe ? measureTree(installDir) : { files: 0, directories: 0, bytes: 0, exists: false };
  const leftovers = leftOvers.map((dir) => ({ path: dir, ...measureTree(dir) }));

  const totals = {
    files: versionTree.files + leftovers.reduce((sum, entry) => sum + entry.files, 0),
    directories: versionTree.directories + leftovers.reduce((sum, entry) => sum + entry.directories, 0),
    bytes: versionTree.bytes + leftovers.reduce((sum, entry) => sum + entry.bytes, 0),
  };

  return {
    version,
    nameIsSafe,
    nameIsExactVersion,
    insideLibrary,
    installDir,
    libraryRoot: root,
    present: versionTree.exists || leftovers.length > 0,
    versionTree,
    leftovers,
    totals,
    hasIncompleteMarker: nameIsSafe ? isFile(path.join(installDir, INCOMPLETE_MARKER)) : false,
    // Guarded: `readLibraryEntry` throws for a name that cannot be a directory, and a
    // PLAN must never throw - its whole job is to describe a delete, including the
    // deletes that will be refused. Found by the Step 4 test, whose first case deletes
    // `../../evil`.
    entry: nameIsSafe ? readLibraryEntry(version, { ...options, validate: false }) : null,
  };
}

/** Formats a byte count for a message. Deliberately coarse: this is prose. */
function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Deletes one version from the library.
 *
 * THE ONLY DESTRUCTIVE OPERATION IN THE LAUNCHER. Every guard runs BEFORE any
 * mutation, and each one exists because a plausible mistake would otherwise destroy
 * something that cannot be recovered:
 *
 *   1. `isSafeVersionName` - the version becomes a path. `../../evil` must never
 *      reach `fs.rmSync`, and neither must a dist-tag (`next` would name a
 *      directory that does not exist today but might tomorrow).
 *   2. `isPathInsideVersions` - computed from the VALIDATED NAME, never from
 *      catalogue content, so a hand-edited catalogue entry cannot redirect a
 *      deletion outside the library.
 *   3. The running-version check - the harness currently serving the user must not
 *      have its tree deleted out from under it.
 *   4. The `.incomplete` marker - a crashed install. REFUSED by default; the
 *      explicit cleanup entry point is [`deletePartialVersion`].
 *
 * The lock is taken for a REAL delete and not for a dry run: the lock's contract is
 * "serialize library mutations", and a real delete both removes a tree and rewrites
 * `catalogue.json` - the same file a concurrent install rewrites.
 *
 * @param {string} version
 * @param {{paths?: object, dryRun?: boolean, runtimeState?: object,
 *          catalogue?: object, lock?: boolean}} [options]
 * @returns {{ok: boolean, deleted: boolean, dryRun: boolean, reason: string,
 *            message: string, version: string, installDir: string|null,
 *            plan: object, catalogue: string, error: string|null}}
 */
export async function deleteVersion(version, options = {}) {
  const dryRun = options.dryRun === true;
  const plan = planDelete(version, options);

  const refuse = (reason, message) => ({
    ok: false,
    deleted: false,
    dryRun,
    reason,
    message,
    version,
    installDir: plan.installDir,
    plan,
    catalogue: "unchanged",
    error: null,
  });

  // --- guards, all before any mutation --------------------------------------

  if (!plan.nameIsExactVersion) {
    return refuse(
      DELETE_REASON.UNSAFE_VERSION,
      `Refusing to delete ${JSON.stringify(version)}: it is not a valid version name, so it cannot ` +
        `name a directory in the version library. Expected an exact version such as "0.2.0-rc.2"; ` +
        `a dist-tag, a range, or a path is not accepted here.`,
    );
  }

  if (!plan.insideLibrary) {
    return refuse(
      DELETE_REASON.OUTSIDE_LIBRARY,
      `Refusing to delete ${version}: its resolved path (${plan.installDir}) is not inside the ` +
        `version library (${plan.libraryRoot}).`,
    );
  }

  const running = runningVersionInfo(version, options);
  if (running.running) {
    return refuse(
      DELETE_REASON.RUNNING_VERSION,
      `Refusing to delete the running version ${version}; stop the harness or choose another version. ` +
        `(runtime-state.json records pid ${running.pid ?? "unknown"} running from ${running.installDir})`,
    );
  }

  if (plan.hasIncompleteMarker && options.allowPartial !== true) {
    return refuse(
      DELETE_REASON.INCOMPLETE_INSTALL,
      `Refusing to delete ${version}: it carries an .incomplete marker ` +
        `(${path.join(plan.installDir, INCOMPLETE_MARKER)}), so it is the remnant of an install that ` +
        `was interrupted rather than a version you installed. Use deletePartialVersion() to remove it ` +
        `deliberately, which also sweeps the staging directories it may have left behind.`,
    );
  }

  // --- the dry run stops here -----------------------------------------------

  if (dryRun) {
    return {
      ok: true,
      deleted: false,
      dryRun: true,
      reason: plan.present ? DELETE_REASON.OK : DELETE_REASON.NOT_INSTALLED,
      message: plan.present
        ? `Would delete ${version}: ${plan.totals.files} file(s), ${plan.totals.directories} ` +
          `director${plan.totals.directories === 1 ? "y" : "ies"}, ${humanBytes(plan.totals.bytes)}` +
          `${plan.leftovers.length > 0 ? `, including ${plan.leftovers.length} leftover director${plan.leftovers.length === 1 ? "y" : "ies"}` : ""}.`
        : `${version} is not in the version library; nothing would be deleted.`,
      version,
      installDir: plan.installDir,
      plan,
      catalogue: "unchanged",
      error: null,
    };
  }

  // --- nothing to do --------------------------------------------------------

  if (!plan.present) {
    return {
      ok: true,
      deleted: false,
      dryRun: false,
      reason: DELETE_REASON.NOT_INSTALLED,
      message: `${version} is not in the version library; nothing was deleted.`,
      version,
      installDir: plan.installDir,
      plan,
      catalogue: "unchanged",
      error: null,
    };
  }

  // --- the real thing, under the library lock -------------------------------

  const runDelete = async () => {
    for (const target of [plan.installDir, ...plan.leftovers.map((entry) => entry.path)]) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        return {
          ok: false,
          deleted: false,
          dryRun: false,
          reason: DELETE_REASON.FAILED,
          message:
            `Deleted part of ${version} and then failed on ${target}: ${error.message}. ` +
            `The version may be partly removed; enumerate the library before acting on it again.`,
          version,
          installDir: plan.installDir,
          plan,
          catalogue: "unchanged",
          error: error.message,
        };
      }
    }

    // The catalogue entry goes only after the tree is gone, so a failure leaves the
    // entry describing something that still exists rather than nothing at all.
    const { removeEntry } = await import("./catalogue.js");
    const removed = removeEntry(version, { paths: options.paths });

    return {
      ok: true,
      deleted: true,
      dryRun: false,
      reason: DELETE_REASON.OK,
      message:
        `Deleted ${version} (${plan.totals.files} file(s), ${humanBytes(plan.totals.bytes)})` +
        `${plan.leftovers.length > 0 ? ` and ${plan.leftovers.length} leftover director${plan.leftovers.length === 1 ? "y" : "ies"}` : ""}.` +
        `${removed.removed ? "" : " It had no catalogue entry."}`,
      version,
      installDir: plan.installDir,
      plan,
      catalogue: removed.removed ? "recorded" : "unchanged",
      error: null,
    };
  };

  if (options.lock === false) return runDelete();

  const { withLock } = await import("./library-lock.js");
  try {
    return await withLock(runDelete, { paths: options.paths, reason: `delete ${version}` });
  } catch (error) {
    if (error?.name === "LibraryLockedError") {
      return {
        ok: false,
        deleted: false,
        dryRun: false,
        reason: DELETE_REASON.LOCKED,
        message: error.message,
        version,
        installDir: plan.installDir,
        plan,
        catalogue: "unchanged",
        error: error.message,
      };
    }
    throw error;
  }
}

/**
 * The explicit cleanup entry point for a partial or broken version.
 *
 * WHY THIS IS A SEPARATE FUNCTION RATHER THAN AN OPTION. Deleting a partial tree is
 * a different intent from deleting a version the user installed, and the call site
 * should say which one it means: `deletePartialVersion("0.1.4")` is self-documenting
 * where `deleteVersion("0.1.4", { allowPartial: true })` requires reading the
 * options. It also matches how 2C will use it - the storage prompt holds
 * `partialInstallDirs()`'s list, so "these are partial, offer to clean them" is the
 * shape it already has.
 *
 * ONE IMPLEMENTATION, TWO ENTRY POINTS (section 3.8's rule). This is a thin,
 * explicit wrapper over `deleteVersion`; it adds no delete logic of its own, so the
 * guards can never drift between the two.
 *
 * It still refuses the RUNNING version and anything outside the library: "this tree
 * is broken" is not a reason to delete the harness that is currently serving.
 */
export async function deletePartialVersion(version, options = {}) {
  const result = await deleteVersion(version, { ...options, allowPartial: true });
  return {
    ...result,
    partial: true,
    message: result.ok
      ? `Cleaned up the partial install of ${version}: ${result.message}`
      : result.message,
  };
}

/**
 * Chooses which versions to offer for deletion when the cache limit is exceeded
 * (section 3.1: PROMPT, never silently evict).
 *
 * THE LAUNCHER NEVER CALLS THIS TO DELETE ANYTHING. It answers "if the user agrees,
 * what should we suggest?" and stops there - the whole point of the section 3.1
 * rule is that a human decides. Nothing here acquires the lock or touches the disk.
 *
 * ORDERING, and why:
 *   1. PARTIAL installs first. They are broken, they cost the most bytes for the
 *      least value, and nobody loses a working version by removing them.
 *   2. Then oldest `installedAt` first - the natural eviction order, and the one a
 *      user expects when a limit is enforced.
 *   3. Undated versions (no catalogue entry) after dated ones, by version string.
 *   4. THE RUNNING VERSION IS NEVER A CANDIDATE, and neither is the preferred
 *      version from settings, because offering it would produce a refusal the user
 *      cannot act on.
 *
 * @param {{paths?: object, limit?: number, entries?: Array, installedAt?: object,
 *          runningVersion?: string|null, protect?: string[]}} [options]
 * @returns {{candidates: Array, kept: Array, overBy: number, limit: number}}
 */
export function selectVersionsToDelete(options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 10;
  const entries =
    options.entries ??
    listInstalledVersions({ paths: options.paths, installedAt: options.installedAt });

  const protectedVersions = new Set(
    [options.runningVersion, ...(options.protect ?? [])].filter((value) => typeof value === "string"),
  );

  const candidates = entries
    .filter((entry) => !protectedVersions.has(entry.version))
    .map((entry) => ({
      version: entry.version,
      state: entry.state,
      installedAt: entry.installedAt ?? null,
      partial: entry.state !== LIBRARY_STATE.INSTALLED,
    }))
    .sort((left, right) => {
      if (left.partial !== right.partial) return left.partial ? -1 : 1;

      const leftDated = left.installedAt !== null;
      const rightDated = right.installedAt !== null;
      if (leftDated !== rightDated) return leftDated ? -1 : 1;

      if (leftDated && rightDated && left.installedAt !== right.installedAt) {
        return left.installedAt < right.installedAt ? -1 : 1; // oldest first
      }

      if (left.version === right.version) return 0;
      return left.version < right.version ? -1 : 1;
    });

  const overBy = Math.max(0, entries.length - limit);

  return {
    candidates: candidates.slice(0, overBy),
    kept: entries.filter((entry) => protectedVersions.has(entry.version)).map((entry) => entry.version),
    overBy,
    limit,
  };
}
