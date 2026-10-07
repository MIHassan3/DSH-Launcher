/**
 * Install tree validation
 * (docs/PROJECT_DSH-DOCK.md section 3.1, Phase 2 milestone 9).
 *
 * WHY THIS EXISTS. Section 3.1 names the failure mode directly: "a broken or
 * partially-completed npm install produces a harness that crashes at boot with
 * an opaque ERR_MODULE_NOT_FOUND".
 *
 * That is a genuinely bad diagnostic chain. npm exits 0, the launcher records a
 * successful install, the harness is spawned, it dies during boot, and the only
 * evidence is a Node.js module-resolution stack trace that names an internal
 * package the user has never heard of. Nothing in that chain points at the
 * install, which is where the fault actually is.
 *
 * This module moves the check to where the cause is: immediately after npm
 * exits, while the install is still the subject. Everything here is a pure
 * function of the filesystem - no npm, no network, no spawned process - so it is
 * fully unit-testable against fixture trees.
 *
 * WHAT IT CAN AND CANNOT PROVE. It proves the entries the harness needs in order
 * to BOOT exist and are files. It does NOT prove all ~500 packages of the
 * dependency tree are complete; that would mean hashing hundreds of megabytes or
 * spawning the harness. A tree that passes here can still be broken deeper down -
 * but the two failures actually observed in practice (a missing entry point, and
 * a missing web-app tree) are caught, and a failure that survives this check is
 * at least known to be something other than "the install never finished".
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path of the harness entry point inside an install directory.
 *
 * NOTE ON THE DUPLICATED CONSTANT: `harness-install.js` also derives this path.
 * The duplication is deliberate and pre-existing - see the note below - and a
 * test asserts the two agree, so they cannot drift apart silently.
 */
export function harnessBinPath(installDir) {
  return path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** Directory holding the `@deepseek-ai` scope inside an install directory. */
export function scopeDir(installDir) {
  return path.join(installDir, "node_modules", "@deepseek-ai");
}

/**
 * The `package.json` of an installed package, given its unscoped name.
 *
 * The `@deepseek-ai/` scope is assumed because every package the harness needs
 * lives under it; a differently-scoped package would be a different check.
 */
export function packageJsonPath(installDir, unscopedName) {
  return path.join(scopeDir(installDir), unscopedName, "package.json");
}

/**
 * Whether a path exists and is a regular file.
 *
 * `statSync` is used rather than `existsSync` because a DIRECTORY at the entry
 * point's path is a real (if unusual) corruption: `existsSync` would call it
 * present, and the subsequent `node <dir>` would fail with a confusing error.
 */
export function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a directory. */
export function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where an installed package's `package.json` would be, in the order npm may
 * have put it.
 *
 * npm hoists dependencies to the top level of the prefix when it can, so a
 * package that `@deepseek-ai/dsh` depends on is normally a SIBLING of `dsh`,
 * not a child of it. But npm nests it under `dsh/node_modules/` when there is a
 * version conflict, and that layout is just as valid.
 *
 * Searching both - rather than asserting the hoisted one - is what keeps this
 * check from failing on a legitimate install. Root order matters only for the
 * diagnostic message: the reported location is the first one that exists.
 *
 * @param {string} installDir
 * @param {string} unscopedName e.g. "dsh-web-app"
 * @returns {string[]} candidate paths, hoisted first
 */
export function packageJsonCandidates(installDir, unscopedName) {
  return [
    packageJsonPath(installDir, unscopedName),
    path.join(scopeDir(installDir), "dsh", "node_modules", "@deepseek-ai", unscopedName, "package.json"),
  ];
}

/**
 * True when a package is resolvable from the install directory.
 *
 * `packageName` may be scoped (`@deepseek-ai/dsh-web-app`) or bare; only the
 * `@deepseek-ai` scope is searched, because that is the only scope the harness
 * installs from.
 */
export function isPackageResolvable(installDir, packageName) {
  const unscoped = String(packageName ?? "").replace(/^@[^/]+\//, "");
  if (unscoped.length === 0) return false;
  return packageJsonCandidates(installDir, unscoped).some(isFile);
}

/** The first existing candidate, or the hoisted path when none exist. */
export function resolvedPackagePath(installDir, packageName) {
  const unscoped = String(packageName ?? "").replace(/^@[^/]+\//, "");
  const candidates = packageJsonCandidates(installDir, unscoped);
  return candidates.find(isFile) ?? candidates[0];
}

/**
 * Reads and parses an installed package's `package.json`.
 *
 * Returns a discriminated result, never throws: a manifest that exists but
 * cannot be parsed is a different problem from one that is absent, and the
 * caller needs to say which.
 *
 * @returns {{status: "ok", value: object} |
 *           {status: "absent"} |
 *           {status: "unreadable", problems: string[]} |
 *           {status: "invalid", problems: string[], raw: string}}
 */
export function readPackageJson(installDir, packageName) {
  const candidates = packageJsonCandidates(
    installDir,
    String(packageName ?? "").replace(/^@[^/]+\//, ""),
  );
  const file = candidates.find(isFile);
  if (file === undefined) return { status: "absent" };

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { status: "unreadable", problems: [`${file}: ${error.message}`] };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { status: "invalid", problems: [`${file}: ${error.message}`], raw: text };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", problems: [`${file}: not a JSON object`], raw: text };
  }

  return { status: "ok", value };
}

/**
 * The packages whose absence is known to break the harness at boot, each with the
 * problem code it reports.
 *
 * `@deepseek-ai/dsh-web-app` is the one section 3.1 names. `dsh` itself is on the
 * list because a missing `dsh` package is a more specific diagnosis than "the
 * entry point is missing": it says the tree is broken above `bin.js` rather than
 * below it.
 *
 * The codes are per-package rather than one generic `package-missing`, because
 * the repair differs: a missing `dsh` means the install never happened, while a
 * missing `dsh-web-app` means it happened incompletely and a DIFFERENT dependency
 * failed. A single code would collapse two different investigations into one.
 */
export const REQUIRED_PACKAGES = Object.freeze([
  Object.freeze({ name: "@deepseek-ai/dsh", code: "dsh-package-missing" }),
  Object.freeze({ name: "@deepseek-ai/dsh-web-app", code: "web-app-missing" }),
]);

/**
 * Problem codes. Stable strings: callers and tests match on them, and Phase 2B's
 * UI will render them.
 */
export const PROBLEM = Object.freeze({
  BIN_MISSING: "bin-missing",
  BIN_NOT_A_FILE: "bin-not-a-file",
  DSH_PACKAGE_MISSING: "dsh-package-missing",
  WEB_APP_MISSING: "web-app-missing",
  PACKAGE_JSON_INVALID: "package-json-invalid",
  PACKAGE_JSON_UNREADABLE: "package-json-unreadable",
  INCOMPLETE_MARKER: "incomplete-marker",
  EMPTY_VERSION: "empty-version",
});

/**
 * Name of the marker left by an in-place install while it is in flight.
 *
 * See `installVersion` in `harness-install.js`: the staged install path never
 * needs this, because `<versions>/<version>` only appears once it is complete.
 * It exists so the FALLBACK install mode (in-place, when the staged rename is
 * not available) still keeps the same guarantee - a version directory is only
 * "installed" when validation has passed.
 */
export const INCOMPLETE_MARKER = ".incomplete";

/** Absolute path of an install directory's incomplete marker. */
export function incompleteMarkerPath(installDir) {
  return path.join(installDir, INCOMPLETE_MARKER);
}

/**
 * Validates an install tree.
 *
 * Returns `{ ok, version, installDir, binPath, problems }` where every problem
 * is `{ code, path, detail }`. ALL problems are reported rather than the first,
 * for the same reason `validateRuntimeState` reports them all: the operator is
 * looking at a failure and needs the whole picture, not one clue at a time.
 *
 * TWO QUESTIONS, ONE FUNCTION. "Are the contents complete?" and "is this install
 * finished?" are different questions that share a filesystem walk:
 *
 *   - `checkMarker: true` (the default) answers BOTH, and is what `library.js`
 *     asks when deciding whether a version is `installed` or `partial`.
 *   - `checkMarker: false` answers ONLY the first, and is what the in-place
 *     installer must ask - it plants `.incomplete` BEFORE running npm by design,
 *     so a check that always failed while the marker was present could never
 *     report success. (Found the hard way: the first in-place install failed
 *     validation on its own marker.)
 *
 * @param {string} version
 * @param {string} installDir
 * @param {{checkMarker?: boolean}} [options]
 */
export function validateInstallTree(version, installDir, options = {}) {
  const checkMarker = options.checkMarker ?? true;
  const problems = [];
  const binPath = harnessBinPath(installDir);

  if (typeof version !== "string" || version.length === 0) {
    problems.push({
      code: PROBLEM.EMPTY_VERSION,
      path: installDir,
      detail: "no version was supplied for this install tree",
    });
  }

  // Checked FIRST, and independently of bin.js: an install that was interrupted
  // is not "installed" merely because an older bin.js survived in place.
  if (checkMarker && isFile(incompleteMarkerPath(installDir))) {
    problems.push({
      code: PROBLEM.INCOMPLETE_MARKER,
      path: incompleteMarkerPath(installDir),
      detail:
        "an install was started here and never completed (in-place install mode); " +
        "delete the version and install it again",
    });
  }

  if (!isFile(binPath)) {
    problems.push({
      code: isDirectory(binPath) ? PROBLEM.BIN_NOT_A_FILE : PROBLEM.BIN_MISSING,
      path: binPath,
      detail: isDirectory(binPath)
        ? "the harness entry point exists but is a directory, not a file"
        : "the harness entry point is missing",
    });
  }

  for (const { name, code } of REQUIRED_PACKAGES) {
    const read = readPackageJson(installDir, name);
    const candidate = resolvedPackagePath(installDir, name);

    if (read.status === "absent") {
      problems.push({
        code,
        path: candidate,
        detail:
          `${name} is not resolvable from this install tree (looked in ` +
          `${packageJsonCandidates(installDir, name.replace(/^@[^/]+\//, "")).join(" and ")}); ` +
          `the harness would fail at boot with ERR_MODULE_NOT_FOUND`,
      });
      continue;
    }

    if (read.status === "invalid") {
      problems.push({
        code: PROBLEM.PACKAGE_JSON_INVALID,
        path: candidate,
        detail: `${name}'s package.json is not valid JSON: ${read.problems.join("; ")}`,
      });
      continue;
    }

    if (read.status === "unreadable") {
      problems.push({
        code: PROBLEM.PACKAGE_JSON_UNREADABLE,
        path: candidate,
        detail: `${name}'s package.json could not be read: ${read.problems.join("; ")}`,
      });
    }
  }

  return { ok: problems.length === 0, version, installDir, binPath, problems };
}

/** Convenience wrapper: does this tree pass validation? */
export function isTreeValid(version, installDir) {
  return validateInstallTree(version, installDir).ok;
}

/**
 * Renders problems as a human-readable, multi-line block.
 *
 * Kept separate from validation so the structured form stays available to
 * callers that want to render it themselves (the Phase 3 UI will), while every
 * error string in the launcher has the same shape.
 */
export function describeProblems(problems) {
  return (problems ?? [])
    .map((problem) => `  - [${problem.code}] ${problem.path}\n      ${problem.detail}`)
    .join("\n");
}
