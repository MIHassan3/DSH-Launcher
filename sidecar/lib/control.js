/**
 * Harness lifecycle as an HTTP control surface
 * (docs/PROJECT_DSH-DOCK.md sections 2.2, 2.3, 3.3).
 *
 * This module owns the four states the UI can observe and the three routes that
 * move between them. It holds no harness logic of its own - every step is
 * Step 3's adopt/reap, Step 2's install, or Step 4's spawn, composed here.
 *
 * SOURCE OF TRUTH. `runtime-state.json` is the record of a RUNNING harness;
 * this module adds only the two facts a state file cannot express - "a start is
 * currently in flight" and "the last attempt failed". It deliberately does NOT
 * cache a second copy of the running harness, because a second copy is a second
 * thing to drift.
 *
 * START IS ASYNCHRONOUS. A cold boot is ~46s and the budget is 300s, so
 * `/harness/start` must never block an HTTP response on the boot. It answers
 * `202 Accepted` immediately and the UI polls `/harness/status`. Concurrency is
 * handled by a single in-flight promise: two simultaneous starts await the same
 * promise, so exactly one spawn can happen.
 */

import fs from "node:fs";

import { adoptOrReap, probeUrl, stopRecordedHarness } from "./harness.js";
import { ensureVersionInstalled } from "./harness-install.js";
import { generateInstanceId, launcherLogFor, startHarness } from "./harness-start.js";
import { resolveLatestRcVersion } from "./registry.js";
import { harnessLogFile, readRuntimeState, resolveStatePaths } from "./state.js";

/** How long a status probe may take before the harness counts as unresponsive. */
export const STATUS_PROBE_TIMEOUT_MS = 1500;

/** How many trailing log lines an error message carries. */
export const ERROR_LOG_LINES = 20;

/** Observable lifecycle states. */
export const STATUS = Object.freeze({
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  ERROR: "error",
});

/**
 * Reads the last `maxLines` lines of a file. Returns "" when unreadable.
 * Also de-duplicates consecutive blank lines so a short tail is informative.
 */
export function tailLines(file, maxLines = ERROR_LOG_LINES) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds the diagnostic text attached to a failed start.
 *
 * Requirement: a failure must name the failing step AND carry the last ~20 lines
 * of the relevant log, so the user can see what broke without opening a file.
 * The launcher log is preferred (it has the timing and the step); the harness
 * log is appended when it says something different.
 *
 * Requirement: never let diagnostics make a success look like a failure, so
 * every read here is failure-tolerant.
 */
export function describeFailure(message, launcherLog, harnessLog) {
  const parts = [message];
  const launcherTail = launcherLog ? tailLines(launcherLog) : "";
  const harnessTail = harnessLog ? tailLines(harnessLog) : "";

  if (launcherTail) parts.push(`--- launcher log (${launcherLog}) ---\n${launcherTail}`);
  if (harnessTail && harnessTail !== launcherTail) {
    parts.push(`--- harness log (${harnessLog}) ---\n${harnessTail}`);
  }
  return parts.join("\n\n");
}

export class HarnessControl {
  /**
   * @param {{paths?: object, startFn?: Function, installFn?: Function,
   *          registryFn?: Function, adoptFn?: Function, stopFn?: Function,
   *          probeFn?: Function, log?: Function}} [options]
   *   The function options are injection seams for tests; production passes
   *   none of them and every real implementation is used.
   */
  constructor(options = {}) {
    this.paths = options.paths ?? resolveStatePaths();
    this.startFn = options.startFn ?? startHarness;
    this.installFn = options.installFn ?? ensureVersionInstalled;
    this.registryFn = options.registryFn ?? resolveLatestRcVersion;
    this.adoptFn = options.adoptFn ?? adoptOrReap;
    this.stopFn = options.stopFn ?? stopRecordedHarness;
    this.probeFn = options.probeFn ?? probeUrl;
    this.log = options.log ?? ((line) => process.stderr.write(`[sidecar] ${line}\n`));

    /** `null` when no start is in flight. */
    this.startPromise = null;
    /** Populated when the most recent start attempt failed; cleared on success. */
    this.lastError = null;
    /** True between "start accepted" and "start settled". */
    this.starting = false;
    /** Human-readable progress note while starting. */
    this.progress = null;
    /** Harness log of the most recent start attempt, for error diagnostics. */
    this.lastLogFile = null;
  }

  /** Reads the recorded harness, or null. Never throws. */
  recorded() {
    const read = readRuntimeState(this.paths.runtimeState);
    return read.status === "ok" ? read.state : null;
  }

  /**
   * Current observable status.
   *
   * Reads `runtime-state.json` and, when a harness is recorded, probes its URL
   * VERBATIM (token included, per Step 3). A recorded process whose URL does not
   * answer is reported as `error` rather than `running`: the UI must not be told
   * a dead page is live.
   *
   * @param {{probe?: boolean}} [options] set `probe: false` for a cheap read
   */
  async status(options = {}) {
    const state = this.recorded();
    const base = {
      status: STATUS.STOPPED,
      version: null,
      url: null,
      pid: null,
      startedAt: null,
      instanceId: null,
      logFile: null,
      launcherLog: null,
      lastError: this.lastError,
      message: null,
    };

    if (this.starting) {
      return {
        ...base,
        status: STATUS.STARTING,
        // Surface the in-flight version when the previous state still knows it.
        version: state?.harnessVersion ?? null,
        message: this.progress ?? "Starting the harness...",
      };
    }

    if (state === null) {
      return {
        ...base,
        status: this.lastError ? STATUS.ERROR : STATUS.STOPPED,
        message: this.lastError ? null : "No harness is running.",
      };
    }

    const enriched = {
      ...base,
      version: state.harnessVersion,
      url: state.url,
      pid: state.pid,
      startedAt: state.startedAt,
      instanceId: state.instanceId,
      logFile: state.logFile ?? null,
      launcherLog: state.logFile ? launcherLogFor(state.logFile) : null,
    };

    if (options.probe === false) {
      return { ...enriched, status: STATUS.RUNNING, message: null };
    }

    const probe = await this.probeFn(state.url, { timeoutMs: STATUS_PROBE_TIMEOUT_MS });
    if (probe.reachable) {
      return { ...enriched, status: STATUS.RUNNING, message: null };
    }

    return {
      ...enriched,
      status: STATUS.ERROR,
      message:
        `The recorded harness (pid ${state.pid}) is not answering on its URL ` +
        `(${probe.error ?? probe.reason}). Stop it and start again.`,
    };
  }

  /**
   * Starts the harness if it is not already usable.
   *
   * Returns immediately with `{ code, payload }`:
   *   200 - a harness is already running (nothing was done)
   *   202 - a start was accepted or is already in flight
   *
   * Idempotent under concurrency: the in-flight promise is shared, so N
   * simultaneous calls cause exactly one start sequence.
   */
  async start() {
    if (this.startPromise !== null) {
      // A start is already in flight; share it rather than starting a second.
      return { code: 202, payload: await this.status() };
    }

    // Already running? Adopt and report 200. This is the fast path (section 3.3).
    const current = await this.status();
    if (current.status === STATUS.RUNNING) {
      return { code: 200, payload: current };
    }

    this.starting = true;
    this.progress = "Checking for an existing harness...";
    this.lastError = null;

    this.startPromise = this.runStart()
      .catch((error) => {
        this.lastError = error?.message ?? String(error);
        this.log(`harness start failed: ${this.lastError}`);
      })
      .finally(() => {
        this.starting = false;
        this.progress = null;
        this.startPromise = null;
      });

    // Do not await: the whole point is that the HTTP response is immediate.
    void this.startPromise;

    return {
      code: 202,
      payload: {
        status: STATUS.STARTING,
        version: null,
        url: null,
        pid: null,
        startedAt: null,
        instanceId: null,
        logFile: null,
        launcherLog: null,
        lastError: null,
        message: "Starting the harness...",
      },
    };
  }

  /**
   * The actual start sequence: adopt -> reap -> install -> spawn.
   *
   * Each stage is already-proven logic from Steps 3 and 4; this method only
   * orders them and turns any failure into a first-class error message.
   *
   * Any throw is wrapped so the message names the failing step and carries the
   * last ~20 lines of the relevant log.
   */
  async runStart() {
    const step = { name: "adopt" };
    try {
      this.progress = "Checking for an existing harness...";
      const decision = await this.adoptFn({ paths: this.paths });
      this.log(`start: adopt/reap decision = ${decision.decision} (${decision.reasons.join("; ")})`);

      if (decision.decision === "adopt") {
        this.progress = null;
        return decision.state;
      }

      if (decision.startFresh === false) {
        // A reap failed, so the port may still be held. Starting a second
        // harness here is the worst available outcome (Step 3 decision).
        throw new Error(
          `Cannot start a harness: ${decision.reasons.join("; ")}. ` +
            `An existing process could not be cleared, so starting another one could ` +
            `collide with it.`,
        );
      }

      step.name = "resolve";
      this.progress = "Resolving the harness version...";
      const { version, tag } = await this.registryFn();
      this.log(`start: resolved ${version} via dist-tag '${tag}'`);

      step.name = "install";
      this.progress = `Ensuring ${version} is installed...`;
      const install = await this.installFn(version, { paths: this.paths, tag });
      this.log(`start: ${install.skipped ? "already installed" : "installed"} ${version}`);

      step.name = "spawn";
      this.progress = `Starting ${version} (this can take up to 5 minutes on first run)...`;

      // Choose the instance id HERE, before spawning, and remember the log
      // paths. If the spawn or the readiness wait fails, the error must be able
      // to attach the log tail - and the log file only exists because we named
      // it. Setting this after a successful start would leave the most common
      // failure (a boot that never becomes ready) with no diagnostics at all.
      const instanceId = generateInstanceId();
      this.lastLogFile = harnessLogFile(instanceId);

      const descriptor = await this.startFn({
        binPath: install.binPath,
        harnessVersion: version,
        installDir: install.installDir,
        paths: this.paths,
        instanceId,
      });

      // Record only AFTER readiness: a state file must never describe a harness
      // that never announced a URL.
      const { recordRunningHarness } = await import("./harness.js");
      recordRunningHarness(
        {
          instanceId: descriptor.instanceId,
          pid: descriptor.pid,
          port: descriptor.port,
          url: descriptor.url,
          harnessVersion: version,
          installDir: install.installDir,
          logFile: descriptor.logFile,
          startedAt: new Date().toISOString(),
        },
        { paths: this.paths },
      );

      this.progress = null;
      this.log(`start: harness ready - pid ${descriptor.pid} ${descriptor.url}`);
      return descriptor;
    } catch (error) {
      throw new Error(
        describeFailure(
          `Harness start failed during the "${step.name}" step: ${error.message}`,
          this.lastLogFile ? launcherLogFor(this.lastLogFile) : null,
          this.lastLogFile,
        ),
      );
    }
  }

  /**
   * Stops the recorded harness.
   *
   * Uses Step 3's identity-checked stop, so a PID that has been recycled onto a
   * foreign process is never killed. Returns `{ code, payload }` with a message
   * that names what actually happened.
   */
  async stop() {
    // A stop during an in-flight start must not race the spawn; wait it out.
    if (this.startPromise !== null) {
      await this.startPromise;
    }

    const result = await this.stopFn({ paths: this.paths });
    this.lastError = null;

    const refused = (result.reasons ?? []).some((reason) => /refused to stop/.test(reason));
    const message = refused
      ? "Recorded process was not ours; left alone and state cleared."
      : result.stopped
        ? "Harness stopped."
        : "No running harness to stop.";

    this.log(`stop: stopped=${result.stopped} refused=${refused}`);
    return {
      code: 200,
      payload: {
        status: STATUS.STOPPED,
        version: null,
        url: null,
        pid: null,
        startedAt: null,
        instanceId: null,
        logFile: null,
        launcherLog: null,
        lastError: null,
        message,
      },
    };
  }

  /**
   * Forces a clean slate: stop whatever is recorded, then start again.
   * Used by the UI's "Restart" and by tests.
   */
  async restart() {
    await this.stop();
    return this.start();
  }

  /**
   * Routes one parsed request. Returns `{ code, payload }`, or null when the
   * path is not a control route (so the caller can 404).
   *
   * @param {string} method
   * @param {string} pathname
   */
  async handle(method, pathname) {
    if (pathname === "/harness/status" && method === "GET") {
      const payload = await this.status();
      return { code: 200, payload };
    }

    if (pathname === "/harness/start" && (method === "POST" || method === "GET")) {
      return this.start();
    }

    if (pathname === "/harness/stop" && (method === "POST" || method === "GET")) {
      return this.stop();
    }

    if (pathname === "/harness/restart" && (method === "POST" || method === "GET")) {
      return this.restart();
    }

    return null;
  }

  /**
   * Awaiting this in tests (and in the sidecar's shutdown path) guarantees no
   * spawn is still in flight. Never rejects.
   */
  async settled() {
    if (this.startPromise !== null) await this.startPromise;
  }
}

/**
 * Convenience factory used by `service.js`.
 *
 * When `DSH_DOCK_START_ON_BOOT` is `"1"`, a start is kicked off as soon as the
 * control exists - the "always-warm background server" of section 1.1. It is off
 * by default so a bare sidecar stays inert.
 */
export function createHarnessControl(options = {}) {
  const control = new HarnessControl(options);
  if (process.env.DSH_DOCK_START_ON_BOOT === "1") {
    void control.start();
  }
  return control;
}
