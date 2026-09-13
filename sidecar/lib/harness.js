/**
 * Harness lifecycle: adopt or reap (docs/PROJECT_DSH-DOCK.md sections 2.2, 2.3).
 *
 * Section 2.3 defines the decision table this module implements. Before
 * spawning anything, the core reads `runtime-state.json` and decides:
 *
 *   pid alive AND url responsive -> ADOPT
 *   pid alive BUT url dead       -> REAP, then start fresh
 *   pid dead                     -> clean state, start fresh
 *   no usable state              -> start fresh
 *
 * Phase 1 scope: the DECISION. Spawning lives in Step 4; this module never
 * starts a harness, it only examines and clears the way.
 *
 * TWO PROPERTIES THAT MATTER AND ARE EASY TO GET WRONG:
 *
 * 1. The stored URL is used VERBATIM, token and all. It is never rebuilt from
 *    `port`. The harness's URL carries a per-boot signed token; a reconstructed
 *    `http://127.0.0.1:<port>/` is refused by the harness and would read as
 *    "harness is dead" - a false negative that would kill a healthy harness on
 *    every launch. See the note on the state schema in `state.js`.
 *
 * 2. "PID alive" is NOT sufficient to adopt. A live PID with no usable URL is
 *    reaped rather than adopted, because adopting it would hand the UI a URL
 *    that cannot work. Reaping is the safe, slow choice Phase 1 takes; Phase 2
 *    may instead re-read the log tail to recover the URL.
 *
 * `port` is retained in the state file for humans and diagnostics only; nothing
 * in the decision path depends on it.
 */

import http from "node:http";

import { identifyHarness, isAlive, killTree, commandLineFor } from "./platform.js";
import {
  buildRuntimeState,
  clearRuntimeState,
  readRuntimeState,
  resolveStatePaths,
  writeRuntimeState,
} from "./state.js";

/** How long a single liveness GET may take before the harness counts as dead. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2500;

/**
 * Probes a URL and classifies the result.
 *
 * Returns a discriminated outcome instead of a boolean, because the caller has
 * to distinguish "definitely not listening" from "I could not tell":
 *
 *   { reachable: true,  status }              - an HTTP response arrived
 *   { reachable: false, reason: "unreachable" } - connection refused/reset,
 *                                                DNS failure, or timeout
 *   { reachable: false, reason: "error", error } - the probe itself malfunctioned
 *
 * Redirects are NOT followed. A 3xx proves a server is listening, which is the
 * question being asked; following it would probe a different URL and could hang
 * on an unbounded chain.
 */
export function probeUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    // Guard the input: `http.get` normally throws synchronously on a bad URL.
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      resolve({ reachable: false, reason: "error", error: `invalid URL: ${error.message}` });
      return;
    }

    if (target.protocol !== "http:") {
      // State validation only ever admits `http://127.0.0.1:<port>/...`, so an
      // https URL here means the state was hand-edited or predates validation.
      // Refuse rather than silently probing a different transport.
      resolve({ reachable: false, reason: "error", error: `unsupported protocol: ${target.protocol}` });
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get(
      target,
      { headers: { "user-agent": "dsh-dock-launcher" } },
      (res) => {
        finish({
          reachable: true,
          status: res.statusCode ?? 0,
        });
        // Drain so the socket can be released; the body is never read.
        res.resume();
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    });

    req.on("error", (error) => {
      const code = error?.code ?? "";
      // A refused/reset/aborted connection means nothing is listening (or it
      // died mid-probe). Anything else is a probe malfunction and is reported
      // as such rather than silently reinterpreted as "dead".
      const unreachable = [
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
      ].includes(code);
      finish(
        unreachable
          ? { reachable: false, reason: "unreachable", error: code || error.message }
          : { reachable: false, reason: "error", error: `${code || "unknown"}: ${error.message}` },
      );
    });
  });
}

/**
 * Decides what to do about the harness recorded in `runtime-state.json`.
 *
 * Pure with respect to spawning: it never starts a harness. It may KILL one
 * (that is the whole point of reaping) and may clear or rewrite the state file.
 *
 * Returns a discriminated result; the `decision` field is the interesting part:
 *
 *   "adopt"        - a live harness was found and verified; `state` is usable
 *   "reap"         - a live process had to be killed before starting fresh;
 *                    `kill` describes the outcome, `reapedPid` names the victim
 *   "fresh"        - nothing to adopt or reap; `stateStatus` says why
 *
 * `startFresh` is `decision !== "adopt"` in every non-killed case, and is
 * false only when a reap FAILED (the port may still be held, so the caller must
 * not blindly start a second harness on top of it).
 *
 * @param {{paths?: object, platform?: NodeJS.Platform, probeTimeoutMs?: number}} [options]
 */
export async function adoptOrReap(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const killTreeImpl = options.killTreeImpl ?? killTree;
  const read = readRuntimeState(paths.runtimeState);

  // --- no usable state -----------------------------------------------------
  if (read.status === "absent") {
    return {
      decision: "fresh",
      stateStatus: "absent",
      reasons: ["no runtime-state.json"],
      startFresh: true,
    };
  }

  if (read.status === "invalid") {
    // Corrupt or incomplete state must NOT crash and must NOT be adopted. If it
    // still names a live PID, that process is an orphan we cannot describe, so
    // reap it - but only after confirming it looks like ours, so a garbled file
    // can never be used to kill an unrelated process.
    const rawPid = read.raw?.pid;
    const reasons = [`runtime-state.json is invalid: ${read.problems.join("; ")}`];

    if (Number.isInteger(rawPid) && rawPid > 0 && isAlive(rawPid)) {
      const identity = await describeIdentity(rawPid, read.raw?.installDir, options);
      const reap = await reapProcess(rawPid, options.platform, reasons, identity, killTreeImpl);

      if (reap.kill.ok) {
        clearRuntimeState(paths.runtimeState);
        return {
          decision: "reap",
          stateStatus: "invalid",
          reasons: [...reasons, `reaped pid ${rawPid}`, reap.kill.note],
          startFresh: true,
          reapedPid: rawPid,
          identity,
          kill: reap.kill,
        };
      }

      return {
        decision: "reap",
        stateStatus: "invalid",
        reasons: [...reasons, `could not reap pid ${rawPid}`, reap.kill.note],
        startFresh: false,
        reapedPid: rawPid,
        identity,
        kill: reap.kill,
      };
    }

    // Nothing alive to reap; drop the bad file and move on.
    clearRuntimeState(paths.runtimeState);
    return { decision: "fresh", stateStatus: "invalid", reasons, startFresh: true };
  }

  const state = read.state;

  // --- pid is gone ---------------------------------------------------------
  if (!isAlive(state.pid)) {
    clearRuntimeState(paths.runtimeState);
    return {
      decision: "fresh",
      stateStatus: "ok",
      reasons: [`recorded pid ${state.pid} is not running`],
      startFresh: true,
      staleState: state,
    };
  }

  // --- pid is alive: verify it is ours BEFORE trusting anything else --------
  //
  // Order matters. Identity is checked first so that a stale state file whose
  // PID has been recycled onto an unrelated process cannot cause us to probe,
  // adopt, or kill that process.
  const identity = await describeIdentity(state.pid, state.installDir, options);

  if (identity.status === "mismatch") {
    // The PID exists but is somebody else's. Do not kill it; just forget it.
    clearRuntimeState(paths.runtimeState);
    return {
      decision: "fresh",
      stateStatus: "ok",
      reasons: [
        `pid ${state.pid} is alive but is not our harness (${identity.reason})`,
        "state cleared; the foreign process was left alone",
      ],
      startFresh: true,
      identity,
      staleState: state,
    };
  }

  // --- pid is alive and is (or may be) ours: probe the EXACT stored URL -----
  const probe = await probeUrl(state.url, { timeoutMs: options.probeTimeoutMs });

  if (probe.reachable) {
    return {
      decision: "adopt",
      stateStatus: "ok",
      reasons: [
        `pid ${state.pid} is running`,
        `url answered HTTP ${probe.status}`,
        `identity ${identity.status}`,
      ],
      startFresh: false,
      state,
      probe,
      identity,
    };
  }

  // --- alive but not serving: reap -----------------------------------------
  const reap = await reapProcess(
    state.pid,
    options.platform,
    [probe.reason ?? "unresponsive"],
    identity,
    killTreeImpl,
  );

  if (reap.kill.ok) {
    clearRuntimeState(paths.runtimeState);
    return {
      decision: "reap",
      stateStatus: "ok",
      reasons: [
        `pid ${state.pid} is alive but ${state.url} did not answer (${probe.error ?? probe.reason})`,
        reap.kill.note,
      ],
      startFresh: true,
      reapedPid: state.pid,
      staleState: state,
      probe,
      identity,
      kill: reap.kill,
    };
  }

  return {
    decision: "reap",
    stateStatus: "ok",
    reasons: [
      `pid ${state.pid} is alive but unresponsive, and it could not be killed`,
      reap.kill.note,
    ],
    startFresh: false,
    reapedPid: state.pid,
    staleState: state,
    probe,
    identity,
    kill: reap.kill,
  };
}

/**
 * Determines whether `pid` may be treated as ours.
 *
 * When `installDir` is unknown (invalid state), the command line is still
 * fetched and the verdict is reported as `unknown` with the evidence attached,
 * so the reap is auditable. It never returns `match` without an install dir,
 * because there would be nothing to match against.
 */
async function describeIdentity(pid, installDir, options) {
  if (typeof installDir !== "string" || installDir.length === 0) {
    let commandLine = null;
    try {
      commandLine = await commandLineFor(pid, { platform: options.platform });
    } catch (error) {
      commandLine = `probe failed: ${error.message}`;
    }
    return {
      status: "unknown",
      reason: "no install directory recorded, so identity cannot be confirmed",
      commandLine,
    };
  }

  return identifyHarness(pid, installDir, { platform: options.platform });
}

/**
 * Kills a process, refusing to do so when the identity check says it belongs to
 * somebody else.
 *
 * This guard is the difference between "reap our orphan" and "kill a stranger's
 * process because a PID was recycled". A `mismatch` is never killed; `unknown`
 * is allowed through, because on POSIX identity is unavailable in Phase 1 and
 * refusing there would make reaping impossible.
 *
 * `killTreeImpl` exists so tests can exercise the "kill failed" branch without
 * needing a genuinely unkillable process.
 */
async function reapProcess(pid, platform, reasons, identity, killTreeImpl = killTree) {
  if (identity?.status === "mismatch") {
    return {
      kill: {
        ok: false,
        method: "refused",
        waitedMs: 0,
        note: `refused to kill pid ${pid}: ${identity.reason}`,
      },
      reasons,
    };
  }

  const kill = await killTreeImpl(pid, { platform });
  return { kill, reasons };
}

/**
 * Records a freshly started harness in `runtime-state.json`.
 *
 * Provided here (rather than in Step 4's spawn module) so the state file has a
 * single writer and the URL-is-verbatim rule is enforced in one place: the
 * `url` argument is stored exactly as given, including its token.
 */
export function recordRunningHarness(fields, options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const state = buildRuntimeState(fields);
  writeRuntimeState(state, paths.runtimeState);
  return state;
}

/**
 * Stops the harness recorded in `runtime-state.json` and clears the state.
 *
 * Used by the explicit Stop command (section 2.3, Q7). Unlike adopt/reap this
 * is a user action, so an unresponsive-but-correct process is still killed.
 */
export async function stopRecordedHarness(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const read = readRuntimeState(paths.runtimeState);

  if (read.status !== "ok") {
    clearRuntimeState(paths.runtimeState);
    return { stopped: false, stateStatus: read.status, reasons: ["no usable state to stop"] };
  }

  const state = read.state;
  if (!isAlive(state.pid)) {
    clearRuntimeState(paths.runtimeState);
    return { stopped: false, stateStatus: "ok", reasons: [`pid ${state.pid} was not running`] };
  }

  const identity = await describeIdentity(state.pid, state.installDir, options);
  if (identity.status === "mismatch") {
    clearRuntimeState(paths.runtimeState);
    return {
      stopped: false,
      stateStatus: "ok",
      reasons: [`refused to stop pid ${state.pid}: ${identity.reason}`],
      identity,
    };
  }

  const kill = await killTree(state.pid, { platform: options.platform });
  if (kill.ok) clearRuntimeState(paths.runtimeState);

  return {
    stopped: kill.ok,
    stateStatus: "ok",
    reasons: [kill.note],
    stoppedPid: state.pid,
    identity,
    kill,
  };
}

/** Convenience: the recorded state, or null. Never throws on corrupt input. */
export function currentHarness(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  const read = readRuntimeState(paths.runtimeState);
  return read.status === "ok" ? read.state : null;
}
