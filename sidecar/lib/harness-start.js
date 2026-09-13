/**
 * Spawning the harness and observing its readiness
 * (docs/PROJECT_DSH-DOCK.md sections 2.2, 2.3, 3.3).
 *
 * THE READINESS MODEL - read this before changing anything here.
 *
 * The harness prints its listening URL exactly ONCE per boot:
 *
 *     dsh web: http://127.0.0.1:<port>?<token>
 *
 * (verified in @deepseek-ai/dsh-web-app, `announceReady`). That line appears
 * only after the Loader config tree has settled AND both the web server and the
 * connection services exist - which is precisely the "first boot builds a plugin
 * tree" wait that can take minutes. So readiness is OBSERVED, never guessed:
 * there is no fixed sleep and no short probe anywhere in this file.
 *
 * Consequences that shape the implementation:
 *
 *  1. The log must be a FRESH file per instance. The URL is printed once; if a
 *     previous run's log were reused, a stale URL would be parsed and the
 *     launcher would confidently point at a dead port. Hence truncate-on-open.
 *  2. The poll re-reads the log from offset 0 every time. Logs here are small
 *     (well under a megabyte); a from-zero scan is trivially correct, whereas
 *     tailing from "current end" can miss a line written before the first poll.
 *  3. A timeout is not "the harness is broken" - it may just be a slow first
 *     boot. The error therefore carries the log path and its tail, so the
 *     failure is diagnosable from the launcher UI and from disk afterwards.
 *
 * The child is spawned detached with stdio redirected to the log file and then
 * `unref()`d, so it survives the launcher closing (section 2.2). Nothing here
 * ever waits on the child: a detached harness is not ours to reap on exit.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveNpmRunner } from "./harness-install.js";
import { harnessLogFile, resolveStatePaths } from "./state.js";

/**
 * Default readiness budget, in milliseconds.
 *
 * Five minutes, matching the previous generation's 240s allowance plus margin.
 * A first boot on a slow machine has to install and build the web profile's
 * plugin tree; a cold start that takes three minutes is normal, not a fault.
 */
export const READINESS_BUDGET_MS = 300_000;

/** How often the log is re-scanned while waiting. */
export const READINESS_POLL_MS = 400;

/**
 * Windows `CREATE_NO_WINDOW` (0x08000000).
 *
 * Suppresses the console that Windows would otherwise allocate for the detached
 * harness, which showed up as a stray black `node.exe` window beside the
 * launcher. `windowsHide` does not cover this case - see the spawn options.
 *
 * Exported so the test suite can assert the flag without restating the magic
 * number, and so the value has exactly one definition.
 */
export const CREATE_NO_WINDOW = 0x08000000;

/**
 * Flag order matters for readability only; the launcher passes absolute values
 * and never a bare `localhost` (section 2.7).
 */
export const HARNESS_ARGS = Object.freeze([
  "--profile",
  "web",
  "--host",
  "127.0.0.1",
  // Explicitly 0: the OS assigns a free port, which is what removes port
  // conflicts entirely (section 2.2).
  "--port",
  "0",
  // Never hand off to the system browser: the harness UI loads in the Tauri
  // webview (section 2.6).
  "--no-open",
]);

/** Raised when the harness never announced a URL within the budget. */
export class HarnessStartError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HarnessStartError";
    this.logFile = details.logFile;
    this.exitCode = details.exitCode;
    this.elapsedMs = details.elapsedMs;
    this.logTail = details.logTail ?? "";
  }
}

/**
 * Matches a harness URL in a line of log output.
 *
 * Accepts `http` or `https`, the loopback literal (and `localhost`, for
 * robustness against a future harness change even though our own addresses are
 * always the IPv4 literal), and an optional port and path/query. The trailing
 * class stops at whitespace and at the delimiters that end an inline mention
 * (`"`, `'`, backtick, `)`, `]`, `}`).
 *
 * The harness also prints a trailing `(LAN: ...)` suffix when a LAN address is
 * sampled; the match simply stops at the space before it.
 */
export const HARNESS_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?[^\s"'`)\]}]*/;

/** True when the URL carries the harness's per-boot token. */
export function hasToken(url) {
  return typeof url === "string" && /[?&]token=/.test(url);
}

/**
 * Parses the harness URL out of a block of log text.
 *
 * Returns `{ url, line }`, or null when no URL has been printed yet. Lines
 * mentioning `dsh web:` are preferred, because that is the harness's documented
 * readiness line; the bare-URL scan is the fallback covering a future format
 * change, per the Step 1 decision (prefix preferred, never required).
 *
 * A URL without a token is REJECTED here rather than returned. It would be
 * unusable (the webview would be refused) and would very likely be a URL from
 * some other source in the log, not the readiness announcement.
 */
export function parseHarnessUrl(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.includes("dsh web:")) continue;
    const match = HARNESS_URL_PATTERN.exec(line);
    if (match && hasToken(match[0])) return { url: match[0], line };
  }

  for (const line of lines) {
    const match = HARNESS_URL_PATTERN.exec(line);
    if (match && hasToken(match[0])) return { url: match[0], line };
  }

  return null;
}

/** Reads the tail of a log file for error reporting. Never throws. */
export function readLogTail(logFile, limit = 4000) {
  try {
    const text = fs.readFileSync(logFile, "utf8");
    return text.length <= limit ? text : `...${text.slice(text.length - limit)}`;
  } catch (error) {
    return `(log unreadable: ${error.message})`;
  }
}

/**
 * Appends a launcher-side breadcrumb to the instance's LAUNCHER log.
 *
 * WHY A SEPARATE FILE - observed behavior, not a precaution:
 *
 * The harness truncates its own stdout file during boot, which would
 * silently erase any writes we make to harness-<id>.log after spawn.
 * Launcher diagnostics therefore go to harness-<id>.launcher.log.
 * Do not merge these files. Do not write to harness-<id>.log from us.
 *
 * This is measured behavior, not a precaution. On a real boot:
 *
 *   t=0    harness-<id>.log = "...[dsh-dock] waiting up to 300s..."  (our line)
 *   t=~1s  harness-<id>.log = 87 bytes; our line GONE
 *   t=9.8s harness-<id>.log = "dsh web: http://..." + "..." + our ready line
 *
 * Reading the harness log is unaffected - the URL line is stable once written -
 * so only our WRITES needed relocating.
 *
 * Never throws: diagnostics must not be able to fail a start.
 */
function appendBreadcrumb(logFile, message) {
  const line = `[dsh-dock] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(launcherLogFor(logFile), line, "utf8");
  } catch {
    // Best-effort; stderr already carried the message.
  }
}

/**
 * Path of the launcher-owned sidecar log for an instance.
 *
 * Sits beside the harness log in `logs/`, with a distinct suffix so the two are
 * never confused: `harness-<id>.log` is the harness's own output (and may be
 * rewritten by it), `harness-<id>.launcher.log` is ours and is append-only.
 */
export function launcherLogFor(harnessLogFile) {
  return harnessLogFile.replace(/\.log$/i, ".launcher.log");
}

/** Builds a sortable, filesystem-safe id: timestamp plus a short random suffix. */
export function generateInstanceId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

/**
 * Waits for the harness's readiness line to appear in its log file.
 *
 * Resolves `{ url, line, elapsedMs, logFile }`. Rejects with
 * [`HarnessStartError`] on timeout, on early process exit, or if the log file
 * disappears.
 *
 * @param {{logFile: string, timeoutMs?: number, pollMs?: number,
 *          child?: import("node:child_process").ChildProcess,
 *          onTick?: (elapsedMs: number) => void}} options
 */
export function waitForHarnessUrl(options) {
  const { logFile } = options;
  const timeoutMs = options.timeoutMs ?? READINESS_BUDGET_MS;
  const pollMs = options.pollMs ?? READINESS_POLL_MS;
  const startedAt = Date.now();

  // The budget is logged up front so a user's "first boot failed" report has a
  // breadcrumb showing how long the launcher was actually willing to wait.
  appendBreadcrumb(
    logFile,
    `waiting up to ${Math.round(timeoutMs / 1000)}s for the harness URL (instance ${options.instanceId ?? "unknown"})...`,
  );

  let exited = null;
  if (options.child) {
    options.child.once("exit", (code, signal) => {
      exited = { code, signal };
    });
  }

  /**
   * Reports an exit that happened BEFORE this function was called.
   *
   * Listening for `exit` is not enough: a harness that dies immediately can
   * have exited before the listener was attached (and `once` never replays), so
   * the wait would sit out the whole budget for a process that is already gone.
   * `exitCode`/`signalCode` are the durable record of that.
   */
  const observedExit = () => {
    if (exited !== null) return exited;
    const code = options.child?.exitCode;
    const signal = options.child?.signalCode;
    if (code === null && signal === null) return null; // still running
    if (code === undefined && signal === undefined) return null; // no child handle
    return { code, signal: signal ?? null };
  };

  return new Promise((resolve, reject) => {
    const finishWith = (fn, value) => {
      clearInterval(timer);
      fn(value);
    };

    const fail = (reason, extra = {}) => {
      const elapsedMs = Date.now() - startedAt;
      appendBreadcrumb(logFile, `harness readiness FAILED after ${elapsedMs}ms: ${reason}`);
      finishWith(
        reject,
        new HarnessStartError(
          `Harness did not become ready after ${elapsedMs}ms: ${reason}. Log: ${logFile}`,
          { logFile, elapsedMs, logTail: readLogTail(logFile), ...extra },
        ),
      );
    };

    const poll = () => {
      const gone = observedExit();

      let text;
      try {
        // From offset 0 every time (see the note at the top of this file).
        text = fs.readFileSync(logFile, "utf8");
      } catch (error) {
        if (gone !== null) {
          fail(`the harness process exited (code ${gone.code}) before printing a URL`, {
            exitCode: gone.code,
          });
          return;
        }
        if (error.code !== "ENOENT") {
          fail(`could not read the harness log: ${error.message}`);
          return;
        }
        text = "";
      }

      const found = parseHarnessUrl(text);
      if (found !== null) {
        // A URL wins even if the process has since exited, so a harness that
        // announced and then died is reported as ready and fails later at the
        // probe, with the URL in hand for diagnosis.
        const elapsedMs = Date.now() - startedAt;
        appendBreadcrumb(
          logFile,
          `harness ready after ${elapsedMs}ms: ${found.url} ` +
            `[harness log ${fs.statSync(logFile).size} bytes]`,
        );
        finishWith(resolve, { url: found.url, line: found.line, elapsedMs, logFile });
        return;
      }

      if (gone !== null) {
        fail(`the harness process exited (code ${gone.code}) before printing a URL`, {
          exitCode: gone.code,
        });
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        fail(
          `no URL line within the ${Math.round(timeoutMs / 1000)}s budget. ` +
            `A slow first boot is the usual cause; the log tail is attached`,
        );
        return;
      }

      options.onTick?.(Date.now() - startedAt);
    };

    const timer = setInterval(poll, pollMs);
    // Poll immediately as well, so an already-ready harness is not delayed by a
    // full poll interval - and so an already-dead one fails at once.
    poll();
  });
}

/**
 * Builds the spawn options for the harness process.
 *
 * Extracted so the console-suppression flags are unit-testable without starting
 * a real process. See the comments on each option for why they are all needed.
 *
 * @param {{logFd: number, platform?: NodeJS.Platform, cwd?: string, env?: object}} params
 */
export function buildHarnessSpawnOptions({ logFd, platform = process.platform, cwd, env }) {
  return {
    cwd: cwd ?? process.cwd(),
    // Survives the launcher closing (section 2.2).
    detached: true,
    // The harness is a black box; its environment is passed through unchanged,
    // which is how $DSH_HOME reaches it (section 2.4).
    env: env ?? process.env,
    stdio: ["ignore", logFd, logFd],
    // `windowsHide` alone is NOT enough on Windows.
    //
    // `windowsHide` maps to STARTF_USESHOWWINDOW/SW_HIDE, which hides the
    // window of a console the child ALREADY has. The sidecar is a plain Node
    // process, so the detached harness is created as a console process and gets
    // a console of its own - a black node.exe window appeared beside the
    // launcher. CREATE_NO_WINDOW suppresses that console outright.
    //
    // Both are set: `windowsHide` covers non-console child windows, and
    // `creationFlags` covers the console case. Unlike `detached`,
    // creationFlags does not affect process-group membership here, so the
    // harness still survives the launcher exiting.
    windowsHide: true,
    ...(platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
  };
}

/**
 * Starts the harness detached and waits for it to announce its URL.
 *
 * Resolves to a descriptor of the running harness:
 *   { instanceId, pid, url, port, logFile, installDir, harnessVersion, elapsedMs }
 *
 * The caller records this with `recordRunningHarness`; this function does not
 * touch `runtime-state.json` itself, so a failed start can never leave a
 * half-written state file behind.
 *
 * `--port 0` means the OS chooses; the port is derived from the announced URL,
 * so the descriptor's `port` is a convenience for humans and diagnostics and is
 * never used to rebuild the URL.
 *
 * @param {{binPath: string, harnessVersion: string, installDir: string,
 *          instanceId?: string, paths?: object, timeoutMs?: number,
 *          nodePath?: string, env?: object, onTick?: Function}} options
 */
export function startHarness(options) {
  const paths = options.paths ?? resolveStatePaths();
  const instanceId = options.instanceId ?? generateInstanceId();
  const logFile = harnessLogFile(instanceId);
  const nodePath = options.nodePath ?? process.execPath;
  const binPath = options.binPath;

  if (typeof binPath !== "string" || binPath.length === 0) {
    throw new HarnessStartError("startHarness requires an absolute binPath");
  }
  if (!path.isAbsolute(binPath)) {
    // Guards the Step 1 lesson: a relative entry path makes Windows store a
    // shortened command line, which breaks the identity check used by adopt.
    throw new HarnessStartError(
      `binPath must be absolute so the recorded command line can be identified later: ${binPath}`,
    );
  }
  if (!fs.existsSync(binPath)) {
    throw new HarnessStartError(`Harness entry point not found: ${binPath}`);
  }

  fs.mkdirSync(paths.logs, { recursive: true });

  // Truncate on open: the URL is printed once per boot, so a reused log would
  // let a stale URL be parsed (see the note at the top of this file).
  const logFd = fs.openSync(logFile, "w");

  let child;
  try {
    child = spawn(
      nodePath,
      [binPath, ...HARNESS_ARGS],
      buildHarnessSpawnOptions({
        logFd,
        cwd: options.cwd,
        env: options.env,
        platform: options.platform ?? process.platform,
      }),
    );
  } catch (error) {
    fs.closeSync(logFd);
    throw new HarnessStartError(`Could not spawn the harness: ${error.message}`, { logFile });
  }

  // The child holds its own duplicate of the descriptor; ours can go now.
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new HarnessStartError("The harness process started without a pid", { logFile });
  }

  process.stderr.write(
    `[sidecar] spawned harness pid ${child.pid} (${options.harnessVersion ?? "unknown version"})\n`,
  );

  // Detach from the sidecar: the harness must outlive the launcher (section 2.2).
  child.unref();

  return waitForHarnessUrl({
    logFile,
    timeoutMs: options.timeoutMs,
    child,
    onTick: options.onTick,
    instanceId,
  }).then((ready) => ({
    instanceId,
    pid: child.pid,
    url: ready.url,
    // Parsed for humans/diagnostics only; the URL is always used verbatim.
    port: Number(new URL(ready.url).port),
    logFile,
    installDir: options.installDir,
    harnessVersion: options.harnessVersion,
    elapsedMs: ready.elapsedMs,
    spawnLine: ready.line,
  }));
}

/**
 * Locates the harness entry point for a version directory.
 *
 * Returns the absolute `bin.js` path, which is what must be spawned - not a
 * `.cmd` shim, for the CVE-2024-27980 reason documented in `harness-install.js`.
 */
export function harnessRunnerFor(binPath, options = {}) {
  const nodePath = options.nodePath ?? process.execPath;
  return { command: nodePath, args: [binPath, ...HARNESS_ARGS] };
}

/**
 * Reports whether npm can be located, for diagnostics in the launcher UI.
 * Re-exported so the UI has one place to ask about "can we install at all?".
 */
export function npmAvailability(options = {}) {
  return resolveNpmRunner(options);
}
