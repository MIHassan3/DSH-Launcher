/**
 * Installing a harness version into the local version library
 * (docs/PROJECT_DSH-DOCK.md section 3.1).
 *
 * Layout produced, per section 3.1:
 *
 *   <data-dir>/versions/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *
 * The install is `npm install --prefix <version-dir> @deepseek-ai/dsh@<exact>`
 * - never `npm pack`, because the harness's dependency tree is not guaranteed
 * flat (Q5).
 *
 * Design notes:
 *
 *   - The version is ALWAYS pinned exactly. A range like `^0.1.5` would let a
 *     later registry state change what a "reinstall" produces, which breaks the
 *     whole point of a version library.
 *   - `--cache` is pointed INSIDE the launcher data directory. Section 2.4
 *     lists `cache/` for exactly this, and it keeps the launcher from depending
 *     on - or polluting - the user's global npm cache.
 *   - `--ignore-scripts` is deliberately NOT used: the harness needs its own
 *     dependency postinstall steps to produce a runnable tree.
 *   - Failure attaches the tail of npm's output, because "npm install failed"
 *     on its own is not actionable.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordInstall } from "./catalogue.js";
import { STAGING_PREFIX, installDirFor, isPathInsideVersions, resolvesToSamePath } from "./library.js";
import { withLock } from "./library-lock.js";
import { HARNESS_PACKAGE } from "./version-manager.js";
import { killTree } from "./platform.js";
import { readRuntimeState, resolveStatePaths } from "./state.js";
import { INCOMPLETE_MARKER, describeProblems, validateInstallTree } from "./validation.js";

/**
 * Relative path of the harness entry point inside a version directory.
 *
 * DUPLICATED WITH `validation.js` ON PURPOSE, FOR NOW. Phase 2's validation
 * module derives the same path from an install directory. Collapsing the two
 * into one definition would mean either this module importing a path helper from
 * a validation module (inverting the dependency for no gain) or the reverse -
 * and either way it rewrites a constant that Phase 1's tests pin, in a step whose
 * whole point is to be additive. The plan's mitigation applies instead: a test
 * asserts the two derivations agree, so they cannot drift apart silently. The
 * consolidation is a Step 3 change, where the install path is being reworked
 * anyway and the full test tier is in place to catch a mistake.
 */
export const HARNESS_BIN_RELATIVE = path.join(
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

/** Default install budget. First installs are large; never rush this. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** How much npm output to keep for diagnostics. */
const OUTPUT_TAIL_BYTES = 6000;

/**
 * Raised when an install cannot complete.
 *
 * `step` names the phase that failed, because "the install failed" is not
 * actionable and the phases need different responses: `version-name` is a caller
 * bug, `running-version` means stop the harness, `resolve-npm` means npm is not
 * installed, `npm` carries an exit code, `staged` means the staged path was
 * disabled while staging failed, `validate` carries missing paths, and `marker`
 * means the tree is fine but its bookkeeping is not.
 *
 * `missingPaths` is populated only by `validate`, and is the field callers should
 * render: it names every entry the tree is missing, which is exactly what the
 * opaque `ERR_MODULE_NOT_FOUND` at boot never does.
 */
export class InstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InstallError";
    this.exitCode = details.exitCode;
    this.outputTail = details.outputTail ?? "";
    this.step = details.step ?? null;
    this.version = details.version ?? null;
    this.installDir = details.installDir ?? null;
    this.missingPaths = details.missingPaths ?? [];
    this.problems = details.problems ?? [];
    this.stagingDir = details.stagingDir ?? null;
    this.approach = details.approach ?? null;
    this.pid = details.pid ?? null;
  }
}

/**
 * Rejects anything that could escape the version directory, alias a path, or is
 * not an exact version.
 *
 * A version string comes from the registry, but it is still untrusted input to a
 * path join: `1.0.0/../../evil` must never become a directory name.
 *
 * THE PATTERN ENFORCES AN EXACT VERSION SHAPE, and that is a Phase 2 correction.
 * The older pattern was `^[0-9A-Za-z][0-9A-Za-z.+-]*$`, which accepted `next`,
 * `latest` and `alpha` - real npm DIST-TAGS. `installVersion("next")` would have
 * created a directory named `next` and installed whatever
 * `@deepseek-ai/dsh@next` resolved to at that moment, destroying the
 * reproducibility a version library exists to provide.
 *
 * The current pattern requires:
 *   - numeral-only dotted components (`1.2.3`), so `1.x` and `^1.2.3` are refused;
 *   - optional pre-release and build identifiers with a restricted alphabet, which
 *     still admits every real version observed (`0.2.0-rc.2`, `1.2.3-alpha.10`,
 *     `1.2.3+build.5`) while refusing separators, spaces and drive letters;
 *   - a length cap, because the version becomes a directory name and Windows
 *     fails path operations past ~260 characters with an unhelpful error.
 *
 * Deliberately NOT a full semver parser: this is a path-safety and
 * exactness guard, and it must stay cheap (it runs before every install).
 */
export const MAX_VERSION_LENGTH = 128;

export function isSafeVersionName(version) {
  if (typeof version !== "string" || version.length === 0) return false;
  if (version.length > MAX_VERSION_LENGTH) return false;
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}

/**
 * Absolute install directory for a version: `<data-dir>/versions/<version>`.
 *
 * @param {string} version
 * @param {{paths?: ReturnType<typeof resolveStatePaths>}} [options]
 */
export function versionInstallDir(version, options = {}) {
  if (!isSafeVersionName(version)) {
    throw new Error(`Refusing to build an install path from an unsafe version name: ${version}`);
  }
  const paths = options.paths ?? resolveStatePaths();
  return path.join(paths.versions, version);
}

/** Absolute path of the harness entry point inside an install directory. */
export function harnessBinPath(installDir) {
  return path.join(installDir, HARNESS_BIN_RELATIVE);
}

/**
 * True when a version directory holds a complete-looking install.
 *
 * Only checks that the entry point exists and is a file. Actually running it
 * (`node bin.js --version`) is Step 4's readiness concern, not an install-time
 * check - and it would make every "is it installed?" query cost a process.
 */
export function isInstalled(version, options = {}) {
  const dir = versionInstallDir(version, options);
  try {
    return fs.statSync(harnessBinPath(dir)).isFile();
  } catch {
    return false;
  }
}

/**
 * The cheap existence probe, named for what it actually checks.
 *
 * `isInstalled` is, strictly speaking, this function: it has only ever asked
 * whether the entry point is a file. Phase 2 makes the distinction matter, so
 * the honest name now exists alongside the historical one.
 */
export function hasInstallEntryPoint(version, options = {}) {
  return isInstalled(version, options);
}

/**
 * The full Phase 2 validation (section 3.1's known failure mode, milestone 9).
 *
 * Returns the structured result from `validation.js`, so a caller can name every
 * missing path instead of reporting "the install failed".
 */
export function validateInstalledVersion(version, options = {}) {
  return validateInstallTree(version, versionInstallDir(version, options));
}

/**
 * Whether this version's tree passes validation.
 *
 * DELIBERATELY NOT WIRED INTO `isInstalled` YET. `control.js`'s start path calls
 * `installVersion`, which short-circuits on `isInstalled`; widening that check
 * means a version installed by Phase 1 - which section 3.1's validation may well
 * call `partial` - stops being adopted and gets reinstalled instead. That is
 * Phase 2's intended *destination*, but it is a behavior change to a working
 * install, and it belongs in Step 3 next to the staged install and the full
 * fake-npm test tier, not in a step whose contract is "additive only".
 */
export function isInstalledAndValid(version, options = {}) {
  return validateInstalledVersion(version, options).ok;
}

/** Keeps the last `limit` characters of a string, for error reporting. */
function tail(text, limit = OUTPUT_TAIL_BYTES) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `...${value.slice(value.length - limit)}`;
}

/**
 * Finds npm's CLI entry script and returns the command that runs it.
 *
 * WHY NOT just spawn `npm` / `npm.cmd`: since the CVE-2024-27980 fix, Node
 * refuses to spawn `.cmd`/`.bat` files unless `shell: true` is set, failing
 * with `spawn EINVAL`. Enabling the shell would mean building a command line by
 * hand - with a registry-supplied version string in it - which is exactly what
 * that mitigation exists to prevent. Verified live: `spawn npm.cmd` with
 * `shell: false` fails with EINVAL on Node 24.
 *
 * Running `node <npm-cli.js>` sidesteps the shell entirely, works identically on
 * every platform, and removes any dependence on PATH ordering.
 *
 * Candidate order:
 *   1. `$npm_execpath` - npm sets this to its own CLI script when it runs us
 *      (covers `npm run ...` and npx).
 *   2. `npm-cli.js` next to the running node binary - a portable/bundled Node
 *      layout (Phase 4's bundled runtime).
 *   3. The standard global npm locations.
 *
 * @returns {{command: string, prefixArgs: string[], source: string}|null}
 */
export function resolveNpmRunner(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? fs.existsSync;
  const execPath = options.execPath ?? process.execPath;

  const candidates = [];
  const execDir = path.dirname(execPath);

  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    candidates.push({ file: fromEnv, source: "npm_execpath" });
  }

  candidates.push({
    file: path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    source: "bundled-with-node",
  });

  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    candidates.push({ file: path.join(appData, "npm", "node_modules", "npm", "bin", "npm-cli.js"), source: "global-appdata" });
    candidates.push({ file: path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"), source: "global-programfiles" });
  } else {
    const prefix = path.dirname(execDir);
    candidates.push({ file: path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), source: "global-usr" });
    candidates.push({ file: path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), source: "global-local" });
  }

  for (const candidate of candidates) {
    try {
      if (exists(candidate.file)) {
        return {
          command: execPath,
          prefixArgs: [candidate.file],
          source: candidate.source,
        };
      }
    } catch {
      // An unreadable candidate is simply not a candidate.
    }
  }

  return null;
}

/**
 * Builds the npm command line for one install.
 *
 * Exported so tests can assert the exact flags without running npm.
 *
 * `npmCommand` may be a string ("npm.cmd") or a `[command, ...prefixArgs]`
 * array. The array form exists so tests can substitute a deterministic stub
 * npm, which is the only way to exercise the exit-code and spawn-failure
 * branches without failing a real install.
 */
export function buildInstallInvocation(version, installDir, options = {}) {
  const paths = options.paths ?? resolveStatePaths();

  const override = options.npmCommand;
  const runner = override === undefined ? resolveNpmRunner(options) : null;

  const command = override !== undefined ? override[0] : runner?.command;
  const prefixArgs = override !== undefined
    ? (Array.isArray(override) ? override.slice(1) : [])
    : (runner?.prefixArgs ?? []);

  const args = [
    ...prefixArgs,
    "install",
    "--prefix",
    installDir,
    "--cache",
    paths.npmCache,
    "--no-audit",
    "--no-fund",
    "--no-progress",
    "--loglevel",
    "error",
    `${HARNESS_PACKAGE}@${version}`,
  ];

  return { command, args, shell: false, npmSource: runner?.source ?? "override" };
}

/**
 * Runs the install, resolving to `{ code, output }`.
 *
 * npm's stdout/stderr are streamed to this process's stderr as well as
 * captured, so a long first install is visible in the launcher's log instead of
 * looking like a hang. stdout is never touched: it carries the shell handshake.
 */
function runNpm(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (typeof command !== "string" || command.length === 0) {
      reject(new InstallError("No npm executable to run (empty command)"));
      return;
    }

    let child;
    try {
      // DO NOT "simplify" this back to spawn("npm") or spawn("npm.cmd").
      //
      // CVE-2024-27980 (Node's Windows .bat/.cmd argument-injection fix) made
      // Node refuse to spawn `.cmd`/`.bat` files unless `shell: true` is set -
      // it fails with `spawn EINVAL`. Verified live on Node 24: spawning
      // `npm.cmd` this way fails 100% of the time.
      //
      // Setting `shell: true` would "fix" it by handing a command line to
      // cmd.exe - and that line contains a registry-supplied version string,
      // which is precisely the injection the CVE fix exists to prevent.
      //
      // So `resolveNpmRunner()` locates npm's CLI script and we run it with our
      // own Node binary instead. No shell, no PATH dependence, same behavior on
      // every platform.
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: options.shell ?? false,
        // THE `env` OPTION ACTUALLY HAS TO REACH THE CHILD. Until Step 3 it did
        // not: `buildInstallInvocation` accepted an `env`, and `runNpm` dropped it
        // on the floor, so a caller's environment was silently ignored. Nothing
        // failed, because the tests that mattered mutated `process.env` instead -
        // which is exactly how an inert seam hides. Merging over `process.env`
        // (rather than replacing it) keeps PATH, SYSTEMROOT and npm's own
        // variables intact while letting a caller override individual ones.
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
    } catch (error) {
      // `spawn` can throw synchronously (EINVAL for a malformed executable
      // path on Windows) instead of emitting an 'error' event, so both paths
      // must be handled or the failure escapes as an unhandled throw.
      reject(new InstallError(`Could not run ${command}: ${error.message}`));
      return;
    }

    let output = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      // A plain child.kill() only signals the direct child; on Windows npm is a
      // shell shim that spawns further processes, so the tree must go. killTree
      // is the same primitive the harness reaper uses.
      void killTree(child.pid);
      reject(new InstallError(`npm install timed out after ${timeoutMs}ms`, { outputTail: tail(output) }));
    }, timeoutMs);

    const absorb = (chunk) => {
      const text = chunk.toString();
      output += text;
      // Mirror npm's progress to stderr (never stdout).
      process.stderr.write(text);
    };

    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new InstallError(`Could not run ${command}: ${error.message}`));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Belt and braces: a process that dies WHILE being torn down can report a
      // close event before the rejection above is observed. Losing the timeout
      // cause would surface as a second npm error, or worse, a successful
      // install. The failure that caused the kill is the one that must be
      // reported.
      if (timedOut) {
        reject(new InstallError(`npm install timed out after ${timeoutMs}ms`, { outputTail: tail(output) }));
        return;
      }
      resolve({ code, output });
    });
  });
}

/**
 * How a version's tree came to exist on disk.
 *
 * Reported on every successful install, because the two modes have different
 * failure properties and the caller (and the launcher log) must be able to see
 * which one it got.
 */
export const INSTALL_APPROACH = Object.freeze({
  /** Staged into `.staging-*`, validated, then renamed into place. */
  STAGED: "staged",
  /** Installed directly into `<versions>/<version>`, marked `.incomplete` until validated. */
  IN_PLACE: "in-place",
});

/** Marker file written by the in-place approach while an install is in flight. */
export const INCOMPLETE_MARKER_NAME = INCOMPLETE_MARKER;

/** Unique staging directory next to the target, so the rename stays intra-volume. */
export function stagingDirFor(version, options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const nonce = options.nonce ?? `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  return path.join(paths.versions, `${STAGING_PREFIX}${version}-${nonce}`);
}

/**
 * Whether a staged tree looks installable.
 *
 * A cheap pre-check before the rename, so staging content that is obviously wrong
 * never reaches the target and never has to be un-renamed. It is NOT the
 * authoritative check - [`validateInstallTree`] runs on the final path afterwards
 * - but it is what lets the staged path fail EARLY and fall back to in-place
 * instead of corrupting the target.
 */
export function stagingLooksComplete(stagingDir) {
  try {
    return fs.statSync(path.join(stagingDir, "node_modules")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Confirms the target is not the harness that is currently running.
 *
 * WHY THIS GUARD EXISTS: on Windows, renaming over - or deleting - the tree of a
 * running process fails with `EPERM`/`EBUSY`, because the harness holds handles
 * inside `node_modules`. That failure is self-protecting but its message is
 * useless ("EPERM: operation not permitted, rename ..."), and it arrives after
 * minutes of npm work. This turns it into a refusal before anything is touched.
 *
 * THE IDENTITY TEST IS SHARED WITH STEP 4's DELETE REFUSAL
 * ([`resolvesToSamePath`] in `library.js`), deliberately: if the two guards used
 * different notions of "the same path", one would fire and the other would not,
 * and the failure mode is destroying or overwriting the tree in use.
 *
 * A recorded state whose pid is already dead still counts as "the running
 * version" and is still refused. Two reasons: the harness may have been started
 * by a process this launcher cannot see, and - more importantly - allowing the
 * install through on a stale-state technicality would produce exactly the cryptic
 * EPERM this guard exists to prevent. The refusal names the recorded pid so the
 * caller can investigate.
 *
 * @returns {{running: boolean, pid: number|null, recordedAt: string|null, installDir: string|null}}
 */
export function runningVersionGuard(version, options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const target = installDirFor(version, { paths });

  // An unreadable or absent runtime state means nothing is recorded, which is a
  // normal state (a fresh data directory) and not a reason to refuse.
  const read = readRuntimeState(paths.runtimeState);
  if (read.status !== "ok") return { running: false, pid: null, recordedAt: null, installDir: null };

  const recordedDir = read.state.installDir;
  if (typeof recordedDir !== "string" || recordedDir.length === 0) {
    return { running: false, pid: null, recordedAt: null, installDir: null };
  }

  if (!resolvesToSamePath(recordedDir, target, options)) {
    return { running: false, pid: null, recordedAt: null, installDir: recordedDir };
  }

  return {
    running: true,
    pid: Number.isInteger(read.state.pid) ? read.state.pid : null,
    recordedAt: typeof read.state.recordedAt === "string" ? read.state.recordedAt : null,
    installDir: recordedDir,
  };
}

/**
 * Runs npm with the invocation already built, absorbing its output.
 *
 * Split out so the staged and in-place paths run npm EXACTLY the same way - the
 * only difference between them is which directory npm is pointed at.
 */
async function runNpmPhase(version, prefixDir, options) {
  const paths = options.paths ?? resolveStatePaths();
  const invocation = buildInstallInvocation(version, prefixDir, { ...options, paths });

  if (typeof invocation.command !== "string" || invocation.command.length === 0) {
    throw new InstallError(
      "Could not locate npm to install the harness. Looked for $npm_execpath, npm-cli.js next to " +
        `the node binary (${process.execPath}), and the standard global npm locations.`,
      { step: "resolve-npm" },
    );
  }

  const { code, output } = await runNpm(invocation.command, invocation.args, options);

  if (code !== 0) {
    throw new InstallError(
      `npm install failed for ${HARNESS_PACKAGE}@${version} (exit code ${code}). ` +
        `Command: ${invocation.command} ${invocation.args.join(" ")}`,
      { exitCode: code, outputTail: tail(output), step: "npm", command: invocation },
    );
  }

  return { code, output, invocation };
}

/**
 * Validates the tree at `dir` and throws a precise, path-naming error on failure.
 *
 * `installDir` is where the version will ULTIMATELY live, which is not `dir` on
 * the staged path - and the error must name the target, not the staging
 * directory, or the caller cannot act on it. `stagingDir` is passed through so a
 * post-mortem can see where the tree was built.
 *
 * `checkMarker` is false for the in-place path: that path plants `.incomplete`
 * BEFORE npm runs, so a marker-aware check would fail on the installer's own
 * bookkeeping. The marker's meaning ("this install is not finished") is applied
 * by `library.js` at enumeration time, where it belongs.
 */
function validateOrThrow(version, dir, { installDir, stagingDir = null, checkMarker = true, ...extras } = {}) {
  const validation = validateInstallTree(version, dir, { checkMarker });

  if (!validation.ok) {
    throw new InstallError(
      `npm reported success for ${HARNESS_PACKAGE}@${version}, but the installed tree did not ` +
        `validate. ${validation.problems.length} problem(s):\n${describeProblems(validation.problems)}\n` +
        `This is the section 3.1 failure mode: without these, the harness would crash at boot with ` +
        `an opaque ERR_MODULE_NOT_FOUND naming a package you have never heard of.`,
      {
        step: "validate",
        version,
        installDir: installDir ?? dir,
        stagingDir,
        missingPaths: validation.problems.map((problem) => problem.path),
        problems: validation.problems,
        // Spread FIRST, then the caller's explicit extras. An earlier version had
        // this the other way round, and a caller passing `approach: "in-place"` to
        // the IN-PLACE path was silently reported as `staged`, because the standard
        // argument for the staged path won. Order is load-bearing here.
        ...extras,
      },
    );
  }

  return validation;
}

/** Removes `dir` if it exists. Best-effort: a cleanup failure must not mask the real error. */
function removeQuietly(dir, platform = process.platform) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs one harness version into the local library.
 *
 * PARAMETERIZED: any exact version string that passes [`isSafeVersionName`]. NO
 * DIST-TAG IS EVER CONSULTED HERE. `next`/`latest`/`alpha` are resolved to an
 * exact version by the caller (`control.js` via `registry.js`) before this
 * function is reached, because a dist-tag is a moving target and a version library
 * exists precisely so that "what is installed" does not change underneath the
 * user. A test pins this by asserting that no `registry`/`dist-tags` symbol is
 * reachable from this module's invocation path and that a tag-like string is
 * treated as an ordinary (and rejected) version name.
 *
 * TWO INSTALL APPROACHES, in this order:
 *
 *   1. STAGED (`INSTALL_APPROACH.STAGED`). npm is pointed at a sibling
 *      `.staging-<version>-<nonce>` directory, the tree is validated THERE, and
 *      only then is it renamed onto `<versions>/<version>`. The invariant this
 *      buys is the important one: **the final path only ever exists in a
 *      validated state**, so an interrupted or broken install can never be
 *      mistaken for a usable version - not even transiently.
 *   2. IN-PLACE (`INSTALL_APPROACH.IN_PLACE`), used only when staging cannot
 *      work. npm installs directly into `<versions>/<version>`, which is first
 *      marked with `.incomplete`; the marker is removed only after validation
 *      passes, and `listInstalledVersions` treats any directory carrying it as
 *      `partial` regardless of whether `bin.js` exists. The guarantee is weaker
 *      (the directory exists before it is validated) but it is still enforced by
 *      the marker rather than by hope.
 *
 * Idempotent by default: an already-complete install short-circuits unless `force`
 * is set, so the fast path (section 3.3) never touches the network.
 *
 * Resolves to `{ version, installDir, binPath, skipped, tag, exitCode, approach,
 * stagingDir, fallbackReason, validation, catalogue }`.
 *
 * Throws [`InstallError`] for every failure, with `step` naming the failing phase
 * and `missingPaths` naming what validation could not find.
 *
 * @param {string} version exact version, e.g. "0.1.5-rc.2"
 * @param {{force?: boolean, tag?: string, paths?: object, npmCommand?: string,
 *          timeoutMs?: number, approach?: "auto"|"staged"|"in-place",
 *          record?: boolean, runtimeState?: object}} [options]
 */
export async function installVersion(version, options = {}) {
  // --- parameterization guard -----------------------------------------------
  if (!isSafeVersionName(version)) {
    throw new InstallError(
      `Refusing to install a malformed version name: ${JSON.stringify(version)}. ` +
        `Expected an exact version such as "0.2.0-rc.2"; a dist-tag, a range, or a path ` +
        `is not accepted here because the library stores exactly what it was given.`,
      { step: "version-name", version: typeof version === "string" ? version : null },
    );
  }

  const paths = options.paths ?? resolveStatePaths();
  const installDir = versionInstallDir(version, { paths });
  const binPath = harnessBinPath(installDir);

  // --- short circuit ---------------------------------------------------------
  if (!options.force && isInstalled(version, { paths })) {
    return {
      version,
      installDir,
      binPath,
      skipped: true,
      tag: options.tag,
      exitCode: 0,
      approach: null,
      stagingDir: null,
      fallbackReason: null,
      validation: null,
      catalogue: null,
    };
  }

  // --- running-version guard -------------------------------------------------
  // Checked BEFORE the short-circuit above on the force path, and before any
  // filesystem change on every path. See [`runningVersionGuard`].
  const guard = runningVersionGuard(version, { paths });
  if (guard.running) {
    throw new InstallError(
      `Refusing to overwrite the running version ${version}; stop the harness or choose another version. ` +
        `(runtime-state.json records pid ${guard.pid ?? "unknown"} running from ${guard.installDir})`,
      { step: "running-version", version, installDir, pid: guard.pid },
    );
  }

  // --- the install itself, under the library lock ---------------------------
  return withLock(
    async () => {
      // Re-check under the lock: another process could have finished this exact
      // install while we waited, and re-installing it would be wasted minutes.
      if (!options.force && isInstalled(version, { paths })) {
        return {
          version,
          installDir,
          binPath,
          skipped: true,
          tag: options.tag,
          exitCode: 0,
          approach: null,
          stagingDir: null,
          fallbackReason: null,
          validation: null,
          catalogue: null,
        };
      }

      const attempt = options.approach ?? "auto";
      let approach = attempt === "in-place" ? INSTALL_APPROACH.IN_PLACE : INSTALL_APPROACH.STAGED;
      let stagingDir = null;
      let fallbackReason = null;
      let exitCode = 0;
      let validation = null;

      if (approach === INSTALL_APPROACH.STAGED) {
        const staging = await installStaged(version, installDir, { ...options, paths });
        if (staging.installed) {
          stagingDir = staging.stagingDir;
          exitCode = staging.exitCode;
          validation = staging.validation;
        } else {
          // The staged approach could not land. Fall back, and SAY SO: a silent
          // downgrade would hide a real environmental problem from the operator.
          approach = INSTALL_APPROACH.IN_PLACE;
          fallbackReason = staging.reason;
          if (attempt === "staged") {
            throw new InstallError(
              `The staged install of ${version} did not complete and the fallback was disabled: ${staging.reason}`,
              { step: "staged", version, installDir, stagingDir: staging.stagingDir },
            );
          }
        }
      }

      if (approach === INSTALL_APPROACH.IN_PLACE) {
        const inPlace = await installInPlace(version, installDir, {
          ...options,
          paths,
          fallbackReason,
        });
        exitCode = inPlace.exitCode;
        validation = inPlace.validation;
      }

      // --- catalogue --------------------------------------------------------
      // Advisory and non-fatal: by now the version is on disk and validated, and
      // a bookkeeping write must never turn that into a failure (Step 2).
      const catalogued =
        options.record === false
          ? {
              recorded: false,
              reason: "recording was disabled by the caller",
              catalogue: "skipped",
              entry: null,
              error: null,
              message: "The caller asked for the install not to be recorded; nothing was written.",
            }
          : recordInstall(version, {
              paths,
              source: options.source ?? options.tag ?? version,
              installDir,
            });

      return {
        version,
        installDir,
        binPath,
        skipped: false,
        tag: options.tag,
        exitCode,
        approach,
        stagingDir,
        fallbackReason,
        validation,
        catalogue: catalogued,
      };
    },
    { paths, reason: `install ${version}` },
  );
}

/**
 * The staged approach: npm into a sibling, validate, rename onto the target.
 *
 * @returns {{installed: boolean, reason: string|null, stagingDir: string,
 *            exitCode: number, validation: object|null}}
 */
async function installStaged(version, installDir, options) {
  const paths = options.paths ?? resolveStatePaths();
  const stagingDir = stagingDirFor(version, { paths, nonce: options.nonce });

  // A staging directory that already exists would make npm's output ambiguous
  // (files from two runs mixed). It should be impossible - the nonce is unique -
  // so its presence means something is wrong, and starting clean is the safe move.
  removeQuietly(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  const fail = (reason) => ({ installed: false, reason, stagingDir, exitCode: 0, validation: null });

  let npm;
  try {
    npm = await runNpmPhase(version, stagingDir, options);
  } catch (error) {
    // A npm failure inside staging is a REAL install failure, not a reason to
    // fall back: the fallback would simply run the same broken npm again. Clean up
    // and rethrow, so the caller sees npm's own exit code and output tail.
    removeQuietly(stagingDir);
    throw error;
  }

  // Content check on the staging path, so obviously-wrong staging never reaches
  // the target. This is the "npm did not put node_modules where we pointed it"
  // detection that makes the fallback meaningful rather than decorative.
  if (!stagingLooksComplete(stagingDir)) {
    removeQuietly(stagingDir);
    return fail(
      `npm exited 0 but produced no node_modules directory under the staging prefix (${stagingDir}), ` +
        `so npm did not treat --prefix as the install root`,
    );
  }

  // Validate the STAGED tree.
  //
  // A FAILURE HERE ABORTS, it does not fall back. The fallback exists for an
  // ENVIRONMENTAL problem - npm did not install where it was pointed, or the
  // rename could not land - because installing in place is a genuinely different
  // attempt that can succeed. A tree that is structurally incomplete is not an
  // environmental problem: the in-place attempt runs the same npm with the same
  // flags and produces the same tree, so falling back would only double the
  // download before reporting the same failure. (The `--prefix` question is
  // already answered by the content check above: a prefix npm never created has no
  // `node_modules` at all, which is the environmental branch.)
  //
  // The staging directory is removed first: a staged attempt that failed
  // validation is over, and leaving it behind would accumulate hundreds of
  // megabytes of garbage per failed attempt.
  let validation;
  try {
    validation = validateOrThrow(version, stagingDir, {
      installDir,
      stagingDir,
      exitCode: npm.code,
      outputTail: tail(npm.output),
      approach: INSTALL_APPROACH.STAGED,
    });
  } catch (error) {
    removeQuietly(stagingDir);
    throw error;
  }

  const moved = renameOntoTarget(stagingDir, installDir, paths, options);
  if (!moved.ok) {
    removeQuietly(stagingDir);
    return fail(
      `the staged tree could not be renamed onto ${installDir}: ${moved.reason}` +
        (moved.backup === null
          ? ""
          : moved.restored
            ? ` (the previous tree was put back, so ${installDir} still holds what it held before)`
            : ` (the previous tree is at ${moved.backup} and could NOT be put back)`),
    );
  }

  return { installed: true, reason: null, stagingDir, exitCode: npm.code, validation };
}

/**
 * Renames a validated staging directory onto the target.
 *
 * `fs.rename` cannot replace an existing directory on this platform, and a target
 * can legitimately already exist (a `force` reinstall, or a leftover partial tree),
 * so an existing target is first renamed aside to a sibling backup and removed
 * only after the new tree is in place. If the final rename fails, the backup is
 * restored - a failed reinstall must not be how the user loses a version.
 *
 * `options.rename` is an injection seam for TESTS ONLY. The failure path this
 * protects ("the target is never left absent") cannot be provoked inside one temp
 * directory - a real `fs.renameSync` failure needs a cross-volume move or an open
 * handle - so without a seam the restore branch would be untestable and would rot.
 * This mirrors the injection seams `HarnessControl` already uses for the same reason.
 *
 * Exported for that test only; production calls it through [`installVersion`].
 *
 * @returns {{ok: boolean, reason: string|null, backup: string|null, restored: boolean}}
 */
export function renameOntoTarget(stagingDir, installDir, paths, options = {}) {
  const rename = options.rename ?? fs.renameSync;
  let backup = null;

  if (fs.existsSync(installDir)) {
    backup = path.join(paths.versions, `${STAGING_PREFIX}${path.basename(installDir)}-replaced-${Date.now().toString(36)}`);

    try {
      rename(installDir, backup);
    } catch (error) {
      return { ok: false, reason: `the existing tree could not be moved aside: ${error.message}`, backup: null, restored: false };
    }
  }

  try {
    rename(stagingDir, installDir);
  } catch (error) {
    // Put the old tree back before reporting, so the target is never left absent.
    let restored = false;
    if (backup !== null) {
      try {
        rename(backup, installDir);
        restored = true;
      } catch {
        restored = false;
      }
    }
    return { ok: false, reason: error.message, backup, restored };
  }

  if (backup !== null) removeQuietly(backup);
  return { ok: true, reason: null, backup, restored: false };
}

/**
 * The in-place approach: `.incomplete` marker, npm into the target, validate,
 * remove the marker.
 *
 * The marker is written BEFORE npm runs, so a crash at any point leaves a
 * directory that `listInstalledVersions` reports as `partial` rather than as an
 * install - even if an older `bin.js` survived from a previous attempt.
 *
 * WHAT HAPPENS TO A FAILED ATTEMPT. Two cases, both deliberate:
 *
 *   - The directory did NOT exist before this attempt (a fresh install). A failure
 *     removes it entirely. Nothing is left for the UI to show, and nothing is left
 *     for the storage accounting to count, because there is nothing to keep.
 *   - The directory DID exist (a force reinstall over a broken or partial tree). The
 *     directory and its marker are left in place, because destroying content that
 *     was there before this install started is not this install's business. The
 *     marker is the record that it is unusable.
 *
 * A CRASH is a third case and is handled by the marker, not by this function:
 * whatever state the process died in, the marker is on disk and the directory
 * enumerates as `partial`.
 */
async function installInPlace(version, installDir, options) {
  const markerPath = path.join(installDir, INCOMPLETE_MARKER);
  const existedBefore = fs.existsSync(installDir);

  fs.mkdirSync(installDir, { recursive: true });
  // Written with the reason, so a leftover marker explains itself months later.
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        version,
        reason: options.fallbackReason ?? "in-place install",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  let npm;
  try {
    npm = await runNpmPhase(version, installDir, options);
  } catch (error) {
    // Keep the marker when there was content to protect; remove the whole
    // directory when this attempt created it, so a failed first install leaves no
    // empty version behind.
    if (!existedBefore) removeQuietly(installDir);
    throw error;
  }

  let validation;
  try {
    validation = validateOrThrow(version, installDir, {
      installDir,
      checkMarker: false, // this path plants the marker itself, before npm runs
      exitCode: npm.code,
      outputTail: tail(npm.output),
      approach: INSTALL_APPROACH.IN_PLACE,
    });
  } catch (error) {
    // A tree that failed validation is not usable, so the marker must stay - but
    // only if there was something here worth keeping. A fresh install that failed
    // leaves nothing at all, which is what makes "the target is absent" a reliable
    // signal that the version is genuinely not installed.
    if (!existedBefore) removeQuietly(installDir);
    throw error;
  }

  // Validation passed. Only now is the directory allowed to call itself installed.
  try {
    fs.unlinkSync(markerPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // The tree is good; a marker we could not remove would make it look partial
      // forever, so this must be reported rather than swallowed.
      throw new InstallError(
        `Installed and validated ${version}, but the .incomplete marker at ${markerPath} could not be ` +
          `removed, so the version will keep reporting as partial: ${error.message}`,
        { step: "marker", version, installDir },
      );
    }
  }

  return { exitCode: npm.code, validation };
}

/**
 * Convenience used by the startup path: install if absent, otherwise skip.
 * Returns the same shape as [`installVersion`].
 */
export async function ensureVersionInstalled(version, options = {}) {
  return installVersion(version, { ...options, force: options.force ?? false });
}
