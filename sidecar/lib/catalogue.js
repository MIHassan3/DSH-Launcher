/**
 * The version library catalogue
 * (docs/PROJECT_DSH-DOCK.md section 3.1, Phase 2 milestone 5).
 *
 * WHY A CATALOGUE EXISTS AT ALL. The filesystem can answer "is this version
 * installed?" perfectly well - and that answer is the only one that matters. It
 * cannot answer "when was it installed?", "did the user ask for it or did
 * auto-update bring it?", or "is this the same tree it was at install time?".
 * Without those, section 3.8's "up to 5 recent versions by date" has no date to
 * sort by, the `cache_limit` prompt has nothing to order evictions by, and a
 * silently corrupted install is indistinguishable from a good one.
 *
 * So: one launcher-owned JSON file, `<data-dir>/versions/catalogue.json`,
 * recording those three facts per version.
 *
 * IT IS ADVISORY. THIS IS THE LOAD-BEARING PROPERTY. Everything in this module
 * is designed so that the catalogue being absent, stale, truncated, unparseable,
 * unreadable, or written by a different build makes the launcher behave exactly
 * as it would with an empty catalogue - never worse. Two consequences that are
 * enforced by tests, not by convention:
 *
 *   1. A version that is on disk but not in the catalogue is STILL INSTALLED.
 *      `library.js` enumerates the filesystem and this module supplies dates; it
 *      is never consulted to decide existence.
 *   2. A catalogue entry naming a version that is not on disk is IGNORED. The
 *      install directory is derived from the (validated) version name, never
 *      from the string stored here, so a catalogue entry cannot redirect a
 *      delete, a switch or an enumeration at a path of its choosing.
 *
 * AND A WRITE FAILURE IS NEVER AN INSTALL FAILURE. By the time `recordInstall`
 * runs, the version is on disk, validated and runnable. Failing the install
 * because an advisory index could not be updated would destroy working software
 * to keep a bookkeeping file consistent. Every write path returns a recorded /
 * unrecorded result instead of throwing.
 *
 * No I/O happens at import time; every path comes from an explicit `paths`
 * object, so a test can point the whole catalogue at a scratch directory.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CORRUPT_PREFIX,
  LIBRARY_ROOT_FILES,
  checksumFor,
  isVersionDirName,
  versionsRoot,
} from "./library.js";
import { resolveStatePaths, writeJsonAtomic } from "./state.js";

/** Name of the catalogue file inside the library root. */
export const CATALOGUE_FILE_NAME = LIBRARY_ROOT_FILES[0];

/**
 * Schema version of the catalogue document.
 *
 * Bumped only for an INCOMPATIBLE change. A newer document (a catalogue written
 * by a later build) is treated as unreadable and preserved, not guessed at: a
 * field this build does not understand could mean anything, and acting on a
 * partial reading of it is how a bookkeeping file starts losing data.
 */
export const CATALOGUE_SCHEMA_VERSION = 1;

/**
 * Refuse to parse a catalogue larger than this.
 *
 * A catalogue entry is a few hundred bytes; a library of hundreds of versions is
 * still well under 100 KB. A file this large is not a catalogue - it is a
 * truncated write, a log file that landed in the wrong place, or corruption. The
 * guard exists so that "degrade gracefully" cannot itself become an
 * out-of-memory.
 */
export const MAX_CATALOGUE_BYTES = 1024 * 1024;

/**
 * Machine-readable reasons an install could not be recorded.
 *
 * Stable strings: they are returned to the caller and logged, and Phase 2B's UI
 * may render them.
 */
export const UNRECORDED_REASON = Object.freeze({
  WRITE_FAILED: "write-failed",
  UNSAFE_VERSION: "unsafe-version",
});

/** The result of reading the catalogue. */
export const CATALOGUE_STATUS = Object.freeze({
  OK: "ok",
  ABSENT: "absent",
  CORRUPT: "corrupt",
});

/**
 * An empty, valid catalogue document.
 *
 * Returned (or written) wherever "there is nothing to say" is the honest answer,
 * so callers never have to handle a null shape.
 */
export function emptyCatalogue(now = new Date().toISOString()) {
  return { schemaVersion: CATALOGUE_SCHEMA_VERSION, updatedAt: now, versions: {} };
}

/** Absolute path of the catalogue file for a given library. */
export function cataloguePath(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  return options.file ?? path.join(paths.versions, CATALOGUE_FILE_NAME);
}

/**
 * Whether an install entry has the shape this build expects.
 *
 * Returns a list of problems (empty means valid), mirroring the house style of
 * `validateRuntimeState`: report every problem, because the person reading it is
 * already looking at a failure.
 */
export function validateCatalogueEntry(version, entry) {
  const problems = [];
  const where = `versions[${JSON.stringify(version)}]`;

  if (!isVersionDirName(version)) {
    problems.push(`${where}: not a valid version name`);
  }

  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`${where}: not a JSON object`);
    return problems;
  }

  if (typeof entry.installedAt !== "string" || Number.isNaN(Date.parse(entry.installedAt))) {
    problems.push(`${where}.installedAt: expected an ISO 8601 timestamp, got ${JSON.stringify(entry.installedAt)}`);
  }

  if (typeof entry.source !== "string" || entry.source.length === 0) {
    problems.push(`${where}.source: expected a non-empty string, got ${JSON.stringify(entry.source)}`);
  }

  if (typeof entry.installDir !== "string" || entry.installDir.length === 0) {
    problems.push(`${where}.installDir: expected a non-empty string, got ${JSON.stringify(entry.installDir)}`);
  }

  if (entry.checksum !== null && entry.checksum !== undefined) {
    if (typeof entry.checksum !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.checksum)) {
      problems.push(`${where}.checksum: expected "sha256:<64 hex>" or null, got ${JSON.stringify(entry.checksum)}`);
    }
  }

  return problems;
}

/**
 * Whether a parsed document is a catalogue this build can use.
 *
 * A SINGLE MALFORMED ENTRY IS TOLERATED; a malformed DOCUMENT is not. The split
 * is deliberate: one bad entry (a hand-edited file, a crash mid-write by an older
 * build in a future release) must not cost the user every date in the library,
 * so bad entries are dropped at read time and named. A document whose top level
 * is wrong - not an object, no schemaVersion, a newer schemaVersion - tells us we
 * do not understand the file at all, and guessing is worse than degrading.
 *
 * @returns {{ok: true, document: object, droppedEntries: string[]} |
 *           {ok: false, problems: string[]}}
 */
export function validateCatalogueDocument(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problems: ["the catalogue is not a JSON object"] };
  }

  if (value.schemaVersion !== CATALOGUE_SCHEMA_VERSION) {
    return {
      ok: false,
      problems: [
        `schemaVersion must be ${CATALOGUE_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)}` +
          (typeof value.schemaVersion === "number" && value.schemaVersion > CATALOGUE_SCHEMA_VERSION
            ? " (written by a newer build; refusing to interpret it)"
            : ""),
      ],
    };
  }

  if (value.versions === null || typeof value.versions !== "object" || Array.isArray(value.versions)) {
    return { ok: false, problems: [`versions must be a JSON object, got ${JSON.stringify(value.versions)}`] };
  }

  const problems = [];
  const kept = {};
  const droppedEntries = [];

  for (const [version, entry] of Object.entries(value.versions)) {
    const entryProblems = validateCatalogueEntry(version, entry);
    if (entryProblems.length > 0) {
      droppedEntries.push(version);
      problems.push(...entryProblems);
    } else {
      kept[version] = entry;
    }
  }

  const updatedAt =
    typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
      ? value.updatedAt
      : new Date(0).toISOString();

  return {
    ok: true,
    document: { schemaVersion: CATALOGUE_SCHEMA_VERSION, updatedAt, versions: kept },
    droppedEntries,
    problems,
  };
}

/**
 * Moves an unusable catalogue aside so the next write starts from a clean file.
 *
 * The bad file is PRESERVED, never deleted: it may be the only remaining record
 * of what the library contained, and a bookkeeping bug that silently destroys its
 * own evidence is unreportable. `rename` is used rather than copy so the library
 * root never holds two copies of a possibly-large file.
 *
 * @returns {{movedTo: string|null, reason: string}}
 */
export function quarantineCatalogue(options = {}) {
  const file = cataloguePath(options);
  const root = versionsRoot(options);
  const stamp = (options.now ?? new Date().toISOString()).replace(/[:.]/g, "-");

  // A candidate name, then a suffixed one on collision. Never overwrite: two
  // quarantines in the same millisecond must both survive.
  const candidates = [
    path.join(root, `${CORRUPT_PREFIX}${stamp}`),
    path.join(root, `${CORRUPT_PREFIX}${stamp}-${randomBytes(3).toString("hex")}`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) continue;
    try {
      fs.renameSync(file, candidate);
      return { movedTo: candidate, reason: "preserved" };
    } catch (error) {
      return { movedTo: null, reason: `could not preserve it: ${error.message}` };
    }
  }

  return { movedTo: null, reason: "every candidate quarantine name was taken" };
}

/**
 * Reads the catalogue.
 *
 * Returns a discriminated result and NEVER throws, for the same reason
 * `readRuntimeState` does not: every caller would otherwise have to invent the
 * same three-way handling, and an unreadable bookkeeping file must not be able to
 * abort a startup.
 *
 * `document` is ALWAYS present and always valid - an empty catalogue when there
 * is nothing usable on disk - so a caller that only wants the dates can ignore
 * `status` entirely.
 *
 * @returns {{status: string, document: object, path: string,
 *            problems: string[], droppedEntries: string[],
 *            quarantinedTo: string|null, quarantinedReason: string|null}}
 */
export function readCatalogue(options = {}) {
  const file = cataloguePath(options);
  const base = {
    path: file,
    problems: [],
    droppedEntries: [],
    quarantinedTo: null,
    quarantinedReason: null,
  };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ...base, status: CATALOGUE_STATUS.ABSENT, document: emptyCatalogue() };
    }
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: [`unreadable: ${error.message}`],
    };
  }

  if (stat.isDirectory()) {
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: ["the catalogue path is a directory, not a file"],
    };
  }

  if (stat.size > MAX_CATALOGUE_BYTES) {
    const quarantine = options.quarantine === false ? null : quarantineCatalogue(options);
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: [`the catalogue is ${stat.size} bytes, over the ${MAX_CATALOGUE_BYTES}-byte limit`],
      quarantinedTo: quarantine?.movedTo ?? null,
      quarantinedReason: quarantine?.reason ?? null,
    };
  }

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: [`unreadable: ${error.message}`],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const quarantine = options.quarantine === false ? null : quarantineCatalogue(options);
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: [`not valid JSON: ${error.message}`],
      quarantinedTo: quarantine?.movedTo ?? null,
      quarantinedReason: quarantine?.reason ?? null,
    };
  }

  const validation = validateCatalogueDocument(parsed);
  if (!validation.ok) {
    const quarantine = options.quarantine === false ? null : quarantineCatalogue(options);
    return {
      ...base,
      status: CATALOGUE_STATUS.CORRUPT,
      document: emptyCatalogue(),
      problems: validation.problems,
      quarantinedTo: quarantine?.movedTo ?? null,
      quarantinedReason: quarantine?.reason ?? null,
    };
  }

  // Individual bad entries are dropped and NAMED, but the document is still
  // usable: one hand-edited line must not cost every other version its date.
  // The status stays `ok` - the file was read and understood - and
  // `droppedEntries` carries what was discarded, so a caller that cares can say
  // so without every caller having to handle a fourth status.
  return {
    ...base,
    status: CATALOGUE_STATUS.OK,
    document: validation.document,
    problems: validation.problems,
    droppedEntries: validation.droppedEntries,
  };
}

/** A map of version -> installedAt, ready for `listInstalledVersions`. */
export function installedAtMap(document) {
  const map = {};
  for (const [version, entry] of Object.entries(document?.versions ?? {})) {
    map[version] = entry.installedAt ?? null;
  }
  return map;
}

/** Convenience: read the catalogue and return only the dates. */
export function readInstalledAt(options = {}) {
  return installedAtMap(readCatalogue(options).document);
}

/**
 * Quarantine siblings already present in the library root, newest name last.
 *
 * Used only to REPORT a preservation that already happened, never to create one.
 * The names are timestamped and sort correctly as strings, so no `stat` call is
 * needed.
 */
export function quarantineFiles(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  try {
    return fs
      .readdirSync(paths.versions)
      .filter((entry) => entry.startsWith(CORRUPT_PREFIX))
      .sort()
      .map((entry) => path.join(paths.versions, entry));
  } catch {
    return [];
  }
}

/**
 * Writes the catalogue atomically (sibling temp file + rename).
 *
 * Reuses `state.js`'s `writeJsonAtomic`, which is the same primitive
 * `runtime-state.json` uses: a reader can never observe a half-written
 * catalogue, and a crash leaves an obvious `.tmp` artifact rather than a file
 * that parses to something wrong.
 *
 * @returns {{written: boolean, path: string, error: string|null}}
 */
export function writeCatalogue(document, options = {}) {
  const file = cataloguePath(options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, document);
    return { written: true, path: file, error: null };
  } catch (error) {
    return { written: false, path: file, error: error.message };
  }
}

/**
 * Records one installed version.
 *
 * NEVER THROWS AND NEVER FAILS AN INSTALL. The version is already on disk and
 * validated by the time this is called; the only question is whether the
 * bookkeeping was updated. The result says which, so the caller can log it and
 * carry on.
 *
 * Reading first and rewriting the whole document (rather than appending) is
 * deliberate: it is a read-modify-write on a file that is rewritten atomically,
 * so a lost update needs two writers, and the launcher is one process with one
 * in-flight install guarded by the library lock (see `library-lock.js`).
 *
 * @param {string} version
 * @param {{paths?: object, now?: string, source?: string, installDir?: string,
 *          checksum?: string|null, packageName?: string,
 *          document?: object}} [options] `document` skips the read, for callers
 *   that already hold one (tests, and a future batch operation).
 * @returns {{recorded: boolean, reason: string|null, message: string, entry: object|null,
 *            catalogue: string, error: string|null}}
 */
export function recordInstall(version, options = {}) {
  if (!isVersionDirName(version)) {
    return {
      recorded: false,
      reason: UNRECORDED_REASON.UNSAFE_VERSION,
      message: `Refusing to record ${JSON.stringify(version)}: not a valid version name.`,
      entry: null,
      catalogue: "unrecorded",
      error: null,
    };
  }

  const now = options.now ?? new Date().toISOString();
  const installDir = options.installDir ?? version;

  // The install directory is stored RELATIVE to the library root, because an
  // absolute path is machine-specific: copying a data directory to another drive
  // would otherwise leave every entry pointing at a place that no longer exists.
  // It is also advisory - `library.js` derives the real path from the version
  // name - so a wrong value here can mislead a human but can never redirect an
  // operation.
  const relative =
    typeof installDir === "string" && path.isAbsolute(installDir)
      ? path.relative(versionsRoot(options), installDir)
      : installDir;

  const entry = {
    installedAt: now,
    source: typeof options.source === "string" && options.source.length > 0 ? options.source : version,
    installDir: relative,
    checksum: options.checksum ?? checksumFor(path.join(versionsRoot(options), version)),
    validatedAt: now,
    package: options.packageName ?? "@deepseek-ai/dsh",
  };

  const document =
    options.document ?? readCatalogue({ ...options, quarantine: false }).document;

  const next = {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    updatedAt: now,
    versions: { ...document.versions, [version]: entry },
  };

  const written = writeCatalogue(next, options);
  if (!written.written) {
    return {
      recorded: false,
      reason: UNRECORDED_REASON.WRITE_FAILED,
      message:
        `Installed ${version}, but could not update the version catalogue at ${written.path}: ` +
        `${written.error}. The version is installed and runnable; it will simply have no date ` +
        `until it is installed again.`,
      entry,
      catalogue: "unrecorded",
      error: written.error,
    };
  }

  return {
    recorded: true,
    reason: null,
    message: `Recorded ${version} in the version catalogue (source ${JSON.stringify(entry.source)}).`,
    entry,
    catalogue: "recorded",
    error: null,
  };
}

/**
 * Removes one version's entry.
 *
 * A missing entry is SUCCESS, not an error: the caller's intent is "this version
 * should not be recorded", and it already is not. Mirrors `clearRuntimeState`'s
 * treatment of ENOENT.
 *
 * `document` may be supplied to skip the read, for a caller that already holds a
 * catalogue (a batch delete, or a test that wants to exercise the write failure
 * separately from the read).
 */
export function removeEntry(version, options = {}) {
  if (!isVersionDirName(version)) {
    return {
      removed: false,
      message: `Refusing to remove ${JSON.stringify(version)} from the catalogue: not a valid version name.`,
      catalogue: "unchanged",
      error: null,
    };
  }

  const document = options.document ?? readCatalogue({ ...options, quarantine: false }).document;
  if (!Object.hasOwn(document.versions, version)) {
    return {
      removed: false,
      message: `${version} was not in the version catalogue.`,
      catalogue: "unchanged",
      error: null,
    };
  }

  const versions = { ...document.versions };
  delete versions[version];

  const written = writeCatalogue(
    {
      schemaVersion: CATALOGUE_SCHEMA_VERSION,
      updatedAt: options.now ?? new Date().toISOString(),
      versions,
    },
    options,
  );

  return written.written
    ? { removed: true, message: `Removed ${version} from the version catalogue.`, catalogue: "recorded", error: null }
    : {
        removed: false,
        message: `Removed ${version} from disk, but could not update the catalogue at ${written.path}: ${written.error}.`,
        catalogue: "unrecorded",
        error: written.error,
      };
}

/**
 * Drops entries whose version directory no longer exists.
 *
 * HOUSEKEEPING FOR A FILE THAT IS ALLOWED TO BE STALE. Deleting a version by hand
 * - outside the launcher - leaves its catalogue entry behind. Nothing breaks
 * while that happens (the filesystem is ground truth and the stale entry is never
 * enumerated as a version), but the file grows and the storage prompt's
 * accounting drifts. This tidies it, and reports exactly what it dropped so the
 * action is visible rather than silent.
 *
 * Uses the CHEAP existence probe deliberately: pruning must not pay for a full
 * tree validation of every version in the library.
 */
export function pruneCatalogue(options = {}) {
  const read = readCatalogue({ ...options, quarantine: false });
  const dropped = [];

  for (const version of Object.keys(read.document.versions)) {
    const dir = path.join(versionsRoot(options), version);
    if (!fs.existsSync(dir)) dropped.push(version);
  }

  if (dropped.length === 0) {
    return { pruned: [], catalogue: "unchanged", error: null };
  }

  const versions = { ...read.document.versions };
  for (const version of dropped) delete versions[version];

  const written = writeCatalogue(
    {
      schemaVersion: CATALOGUE_SCHEMA_VERSION,
      updatedAt: options.now ?? new Date().toISOString(),
      versions,
    },
    options,
  );

  return written.written
    ? { pruned: dropped, catalogue: "recorded", error: null }
    : { pruned: [], catalogue: "unrecorded", error: written.error };
}

/**
 * A one-line health report, for the launcher log and for diagnostics.
 *
 * A DIAGNOSTIC MUST NOT MUTATE. This reads with `quarantine: false` on purpose.
 * An earlier version of this function let its read move a corrupt file aside, so
 * asking "how is the catalogue?" twice gave two different answers - the second
 * call reported `absent`, because the first call had just tidied the evidence
 * away. Found by the Step 2 test, not theorised. Quarantining belongs to the
 * paths that actually consume the catalogue.
 *
 * `corrupt` reports a preserved copy when one is already present, so "the
 * catalogue is gone" and "the catalogue is gone and a copy is at X" stay
 * different messages for whoever has to investigate.
 */
export function catalogueHealth(options = {}) {
  const read = readCatalogue({ ...options, quarantine: false });
  const entries = Object.keys(read.document.versions).length;
  const preserved = read.quarantinedTo ?? quarantineFiles(options).at(-1) ?? null;

  switch (read.status) {
    case CATALOGUE_STATUS.ABSENT:
      return {
        status: read.status,
        entries: 0,
        message: `no version catalogue yet at ${read.path}`,
        problems: [],
        quarantinedTo: null,
      };
    case CATALOGUE_STATUS.CORRUPT:
      return {
        status: read.status,
        entries: 0,
        message:
          `the version catalogue at ${read.path} is unusable (${read.problems.join("; ")}); ` +
          (preserved
            ? `a copy was preserved at ${preserved}`
            : `it could not be preserved (${read.quarantinedReason ?? "a diagnostic does not move files"})`) +
          `. The library still enumerates from disk.`,
        problems: read.problems,
        quarantinedTo: preserved,
      };
    default:
      return {
        status: read.status,
        entries,
        message:
          `the version catalogue at ${read.path} has ${entries} entr${entries === 1 ? "y" : "ies"}` +
          (read.droppedEntries.length > 0
            ? `; ${read.droppedEntries.length} unusable entr${read.droppedEntries.length === 1 ? "y was" : "ies were"} dropped (${read.droppedEntries.join(", ")})`
            : ""),
        problems: read.problems,
        quarantinedTo: null,
      };
  }
}

export { checksumFor };
