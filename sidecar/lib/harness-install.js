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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HARNESS_PACKAGE } from "./version-manager.js";
import { killTree } from "./platform.js";
import { resolveStatePaths } from "./state.js";

/** Relative path of the harness entry point inside a version directory. */
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

/** Raised when npm exits non-zero, or the install does not produce bin.js. */
export class InstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InstallError";
    this.exitCode = details.exitCode;
    this.outputTail = details.outputTail ?? "";
  }
}

/**
 * Rejects anything that could escape the version directory or alias a path.
 *
 * A version string comes from the registry, but it is still untrusted input to
 * a path join: `1.0.0/../../evil` must never become a directory name.
 */
export function isSafeVersionName(version) {
  return typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version);
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
 * Installs one harness version into the local library.
 *
 * Idempotent by default: an already-complete install short-circuits unless
 * `force` is set, so the fast path (section 3.3) never touches the network.
 *
 * Resolves to `{ version, installDir, binPath, skipped, tag, exitCode }`.
 * Throws [`InstallError`] when npm fails or the entry point is missing.
 *
 * @param {string} version exact version, e.g. "0.1.5-rc.2"
 * @param {{force?: boolean, tag?: string, paths?: object, npmCommand?: string,
 *          timeoutMs?: number, deps?: object}} [options]
 */
export async function installVersion(version, options = {}) {
  if (!isSafeVersionName(version)) {
    throw new InstallError(`Refusing to install an unsafe version name: ${version}`);
  }

  const paths = options.paths ?? resolveStatePaths();
  const installDir = versionInstallDir(version, { paths });
  const binPath = harnessBinPath(installDir);

  if (!options.force && isInstalled(version, { paths })) {
    return { version, installDir, binPath, skipped: true, tag: options.tag, exitCode: 0 };
  }

  fs.mkdirSync(installDir, { recursive: true });

  const invocation = buildInstallInvocation(version, installDir, { ...options, paths });

  if (typeof invocation.command !== "string" || invocation.command.length === 0) {
    throw new InstallError(
      "Could not locate npm to install the harness. Looked for $npm_execpath, npm-cli.js next to " +
        `the node binary (${process.execPath}), and the standard global npm locations.`,
    );
  }

  const { code, output } = await runNpm(invocation.command, invocation.args, options);

  if (code !== 0) {
    throw new InstallError(
      `npm install failed for ${HARNESS_PACKAGE}@${version} (exit code ${code}). ` +
        `Command: ${invocation.command} ${invocation.args.join(" ")}`,
      { exitCode: code, outputTail: tail(output) },
    );
  }

  if (!fs.existsSync(binPath)) {
    throw new InstallError(
      `npm reported success but the harness entry point is missing at ${binPath}. ` +
        `The published package layout may have changed.`,
      { exitCode: code, outputTail: tail(output) },
    );
  }

  return { version, installDir, binPath, skipped: false, tag: options.tag, exitCode: code };
}

/**
 * Convenience used by the startup path: install if absent, otherwise skip.
 * Returns the same shape as [`installVersion`].
 */
export async function ensureVersionInstalled(version, options = {}) {
  return installVersion(version, { ...options, force: options.force ?? false });
}
