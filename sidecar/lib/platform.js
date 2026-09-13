/**
 * Cross-platform process primitives for harness adopt/reap
 * (docs/PROJECT_DSH-DOCK.md sections 2.3 and 2.7).
 *
 * The adopt/reap decision in section 2.3 is:
 *   - pid alive AND port responsive -> adopt
 *   - pid alive BUT port dead       -> kill, then start fresh
 *   - pid dead                      -> clean state file, start fresh
 *
 * That needs three primitives, and this module is the seam for all three:
 *
 *   isAlive(pid)                      - liveness
 *   commandLineFor(pid)               - identity (which process is this?)
 *   killTree(pid)                     - reaping
 *
 * Porting status (Phase 1 is Windows-first, per decision 2 of the plan):
 *
 *   isAlive          all platforms, no shelling out - `process.kill(pid, 0)`
 *   killTree         all platforms (taskkill on Windows, process group on POSIX)
 *   commandLineFor   Windows implemented and tested.
 *                    POSIX returns null, which callers report as "unknown"
 *                    identity. Phase 4 adds `ps -o command=` (macOS) and
 *                    `/proc/<pid>/cmdline` (Linux). Until then the identity
 *                    check on POSIX cannot confirm the process is ours, and it
 *                    says so rather than guessing.
 *
 * Deliberately NOT used anywhere in this project (section 2.7):
 *   - `Get-NetTCPConnection -LocalPort` - misses IPv6-only listeners
 *   - `localhost` in any address     - resolves inconsistently on Windows
 *
 * Every function here returns or throws; none of them logs, and none of them
 * ever kills a pid it was not explicitly handed.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** Grace period between SIGTERM and SIGKILL on POSIX. Windows is unaffected. */
export const KILL_GRACE_MS = 4000;

/** How long `killTree` waits for the process to disappear before giving up. */
export const KILL_VERIFY_TIMEOUT_MS = 6000;

/** PowerShell invocation used to read a process command line on Windows. */
const PWSH_EXE = "powershell.exe";

/** Hard cap on the PowerShell probe, so a wedged shell cannot hang adopt/reap. */
const CIM_PROBE_TIMEOUT_MS = 15000;

/**
 * True if `pid` names a live process.
 *
 * `process.kill(pid, 0)` performs no signalling: it only asks the OS whether
 * the process exists and is reachable. It behaves the same on Windows, macOS
 * and Linux, which is why liveness needs no platform branch at all.
 *
 * `EPERM` means the process exists but belongs to another user - that still
 * counts as alive, and treating it as dead would be a lie about state.
 *
 * Only `pid > 0` is accepted: on POSIX a negative pid targets a process group
 * and `0` targets the caller's own group, so a corrupt state file containing
 * `-1` or `0` must never reach `process.kill`.
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

/**
 * Runs a command and captures stdout, with a timeout.
 *
 * IMPORTANT (constraint inherited from Phase 0, see src-tauri/NOTES.md):
 * a Node-to-Node PIPED stdio spawn fails with EPERM in confined execution
 * environments. This helper is unrelated to that hazard: it launches a
 * first-party OS binary (`powershell.exe`, `taskkill.exe`), not another Node
 * process, so piped capture is permitted. Do not reuse it for Node children.
 */
function runCapture(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${exe} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Returns the full command line of `pid` on Windows, or `null` when the
 * process does not exist.
 *
 * Uses CIM (`Win32_Process.CommandLine`) rather than `Get-Process`, because
 * the whole point of the identity check is to see the arguments - the
 * install directory appears only in the command line.
 *
 * Throws on probe failure (no PowerShell, access denied, timeout) so the
 * caller can distinguish "process is gone" from "I could not tell", which are
 * different answers and must not be conflated.
 */
async function commandLineForWindows(pid) {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" ` +
    `-ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { Write-Output 'null' } ` +
    `else { $p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress }`;

  const { code, stdout, stderr } = await runCapture(
    PWSH_EXE,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    CIM_PROBE_TIMEOUT_MS,
  );

  if (code !== 0) {
    const detail = stderr.trim() || `exit code ${code}`;
    throw new Error(`PowerShell CIM probe failed: ${detail}`);
  }

  const text = stdout.trim();
  if (text.length === 0 || text === "null") return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`PowerShell CIM probe returned unparseable output: ${error.message}`);
  }

  if (parsed === null) return null;
  const commandLine = Array.isArray(parsed) ? parsed[0]?.CommandLine : parsed.CommandLine;
  return typeof commandLine === "string" && commandLine.length > 0 ? commandLine : null;
}

/**
 * Returns the full command line of `pid`, or `null` if the process is gone or
 * its command line cannot be read on this platform.
 *
 * See the porting table at the top of this file: Phase 1 implements Windows
 * only. POSIX returns null, which downstream code reports as "unknown"
 * identity rather than a negative match.
 *
 * @param {number} pid
 * @param {{platform?: NodeJS.Platform}} [options] - `platform` is injectable
 *   for tests so the POSIX branch is exercised on a Windows machine.
 */
export async function commandLineFor(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform !== "win32") return null;
  return commandLineForWindows(pid);
}

/**
 * Pure command-line comparison. No I/O, no platform globals beyond the
 * injectable `platform` - so the matching rules are directly testable.
 *
 * `installDir` is matched as a path SEGMENT, never as a bare substring:
 * scanning `...\DSH-Dock\versions\0.1.5-rc.2\...` for `...\versions\0.1.5-rc`
 * would otherwise match a different version whose prefix happens to agree.
 *
 * Windows command lines routinely mix separators (`C:/a\b`) and case, so
 * separators are normalized and comparison is case-insensitive there. POSIX
 * paths are compared case-sensitively.
 */
export function commandLineMatchesInstallDir(commandLine, installDir, platform = process.platform) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  if (typeof installDir !== "string" || installDir.length === 0) return false;

  const fold = (value) => value.split("\\").join("/").replace(/\/+$/, "");
  const haystack = fold(commandLine);
  const needle = fold(installDir);
  if (needle.length === 0) return false;

  const insensitive = platform === "win32";
  const match = insensitive
    ? haystack.toLowerCase().includes(needle.toLowerCase())
    : haystack.includes(needle);
  if (!match) return false;

  // Guard the segment boundary described above. `indexOf` on the folded forms
  // keeps the offset aligned because folding is length-preserving.
  const at = insensitive
    ? haystack.toLowerCase().indexOf(needle.toLowerCase())
    : haystack.indexOf(needle);
  const after = haystack.charAt(at + needle.length);
  return after === "" || after === "/";
}

/**
 * Decides whether `pid` is the harness installed in `installDir`.
 *
 * Returns a discriminated result instead of a boolean, because "not ours" and
 * "cannot tell" lead to different actions (reap vs. adopt) and must not be
 * collapsed:
 *
 *   { status: "match",   ... }  - command line contains the install dir
 *   { status: "mismatch",... }  - command line read, install dir absent
 *   { status: "unknown", ... }  - no command line available (dead, or POSIX
 *                                 in Phase 1), or the probe itself failed
 *
 * `unknown` is deliberately NOT treated as a match: adopting a process we
 * cannot identify is the worst of the available failures.
 */
export async function identifyHarness(pid, installDir, options = {}) {
  if (!isAlive(pid)) {
    return { status: "unknown", reason: "process is not alive", commandLine: null };
  }

  let commandLine;
  try {
    commandLine = await commandLineFor(pid, options);
  } catch (error) {
    return { status: "unknown", reason: `probe failed: ${error.message}`, commandLine: null };
  }

  if (commandLine === null) {
    const platform = options.platform ?? process.platform;
    const reason =
      platform === "win32"
        ? "process disappeared or its command line is unreadable"
        : `command-line identity is not implemented on ${platform} in Phase 1`;
    return { status: "unknown", reason, commandLine: null };
  }

  if (commandLineMatchesInstallDir(commandLine, installDir, options.platform ?? process.platform)) {
    return { status: "match", reason: "command line contains the install directory", commandLine };
  }

  return {
    status: "mismatch",
    reason: "process is alive but its command line does not name our install directory",
    commandLine,
  };
}

/**
 * Best-effort immediate termination of a single pid. Used only by `killTree`.
 *
 * Returns true when the signal was delivered or the process was already gone.
 */
function signalOnce(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ESRCH");
  }
}

/**
 * Waits for `pid` to disappear, up to `timeoutMs`.
 *
 * Resolves to true as soon as the process is gone, false on timeout. Polling
 * is the only portable option here: `taskkill`'s own exit code does not
 * distinguish "killed" from "was already gone" reliably enough to trust.
 */
async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(150);
  }
  return !isAlive(pid);
}

/**
 * Kills a process and its descendants, then verifies it is actually gone.
 *
 * Why a tree and not just the pid: a detached harness may have children of its
 * own, and section 2.7 records that cancelling a job does not kill
 * grandchildren. Killing the parent alone can leave the listener bound.
 *
 * Windows: `taskkill /T /F`. `/T` covers descendants; `/F` is required because
 * Node cannot deliver a real `SIGTERM` to a Windows process - `process.kill`
 * terminates unconditionally there, so a "graceful then force" sequence would
 * be theatre. Exit code 128 means "no such process", which is success for our
 * purposes.
 *
 * POSIX: signal the process group (`-pid`) because detached children are
 * group leaders, escalating SIGTERM -> SIGKILL after `KILL_GRACE_MS`.
 *
 * Returns `{ ok, method, waitedMs, note }`. A `false` `ok` means the process
 * is still alive and the caller must NOT record the port as free.
 */
export async function killTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const startedAt = Date.now();

  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: true, method: "noop", waitedMs: 0, note: "invalid pid; nothing to kill" };
  }

  if (!isAlive(pid)) {
    return { ok: true, method: "noop", waitedMs: 0, note: "process already gone" };
  }

  if (platform === "win32") {
    let result;
    try {
      result = await runCapture("taskkill.exe", ["/PID", String(pid), "/T", "/F"], CIM_PROBE_TIMEOUT_MS);
    } catch (error) {
      return {
        ok: !isAlive(pid),
        method: "taskkill",
        waitedMs: Date.now() - startedAt,
        note: `taskkill could not run: ${error.message}`,
      };
    }

    // 0 = killed; 128 = not found (already gone, which is the desired state).
    const accepted = result.code === 0 || result.code === 128;
    const gone = await waitForDeath(pid, KILL_VERIFY_TIMEOUT_MS);
    return {
      ok: gone,
      method: "taskkill /T /F",
      waitedMs: Date.now() - startedAt,
      note: accepted
        ? gone
          ? "killed and verified gone"
          : "taskkill reported success but the pid is still alive"
        : `taskkill exit ${result.code}: ${result.stderr.trim() || "no stderr"}`,
    };
  }

  // POSIX: the harness is spawned detached, so it leads its own process group.
  const groupSignalled = (() => {
    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      return signalOnce(pid, "SIGTERM");
    }
  })();

  if (!groupSignalled) {
    return {
      ok: !isAlive(pid),
      method: "SIGTERM",
      waitedMs: Date.now() - startedAt,
      note: "SIGTERM could not be delivered",
    };
  }

  if (await waitForDeath(pid, KILL_GRACE_MS)) {
    return { ok: true, method: "SIGTERM", waitedMs: Date.now() - startedAt, note: "terminated gracefully" };
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    signalOnce(pid, "SIGKILL");
  }

  const gone = await waitForDeath(pid, KILL_VERIFY_TIMEOUT_MS);
  return {
    ok: gone,
    method: "SIGKILL",
    waitedMs: Date.now() - startedAt,
    note: gone ? "escalated to SIGKILL" : "still alive after SIGKILL",
  };
}
