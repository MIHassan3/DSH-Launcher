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
 *
 * TWO START ENTRY POINTS, ONE SEQUENCE (Phase 2B). `start()` resolves the version
 * the registry says is current; `startSpecificVersion()` starts a version the
 * caller names. Both run the SAME `runStartSequence`, because a switch differs
 * from a start in exactly one respect - the version it targets - and duplicating
 * the adopt/spawn/record sequence to express that would give the launcher two
 * copies of its most failure-prone code path.
 */

import fs from "node:fs";

import { readInstalledAt } from "./catalogue.js";
import { adoptOrReap, probeUrl, stopRecordedHarness } from "./harness.js";
import { ensureVersionInstalled } from "./harness-install.js";
import { generateInstanceId, launcherLogFor, startHarness } from "./harness-start.js";
import { listInstalledVersions } from "./library.js";
import { resolveLatestRcVersion } from "./registry.js";
import { harnessLogFile, readRuntimeState, resolveStatePaths } from "./state.js";

/** How long a status probe may take before the harness counts as unresponsive. */
export const STATUS_PROBE_TIMEOUT_MS = 1500;

/** How many trailing log lines an error message carries. */
export const ERROR_LOG_LINES = 20;

/**
 * How long the library enumeration behind `recentVersions` is reused, in ms.
 *
 * The status payload is read by THREE callers on different cadences: the shell's
 * 5s menu watcher, the dashboard's 500ms poll, and every `harness_status` command.
 * Re-enumerating on each of those would make the launcher's hottest read path
 * O(versions) with roughly three `stat` calls per version - measured at 1-6ms for
 * two versions, but paid ten times a second by the UI alone.
 *
 * The library changes on human timescales (an install or a delete, both minutes
 * apart), so one second of staleness is invisible. The delay only ever affects the
 * version LIST; the running version and every other status field are read fresh.
 */
export const LIBRARY_SUMMARY_TTL_MS = 1000;


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

    /**
     * Memo for `librarySummary()`. Two fields rather than one so a clock that
     * jumps backwards (a laptop waking from sleep, a manual clock change) degrades
     * to a fresh read instead of a stale result that never expires.
     */
    this.libraryCache = { at: 0, value: null };
  }

  /** Reads the recorded harness, or null. Never throws. */
  recorded() {
    const read = readRuntimeState(this.paths.runtimeState);
    return read.status === "ok" ? read.state : null;
  }

  /**
   * The version the recorded harness is running, or null when none is recorded.
   *
   * The switch flow reads this BEFORE stopping so its result can name the version
   * it replaced - which is what makes a failed switch's error message, and the
   * "switch back" affordance beside it, possible at all.
   *
   * Deliberately a fresh read and never the memo: the record changes at exactly
   * the moments a caller cares about, and one small JSON read is not worth caching.
   */
  harnessVersion() {
    return this.recorded()?.harnessVersion ?? null;
  }

  /**
   * The version library as the menu and the dashboard need it.
   *
   * Returns the WHOLE library, newest-first, not the five the menu displays: the
   * submenu applies its own limit, and "Show all versions..." must open a manager
   * that holds every version rather than only the ones the menu happened to show.
   *
   * `state` is carried so the UI can render `partial` entries distinctly, and the
   * `installedAt` dates come from the ADVISORY catalogue - which is why the
   * ordering falls back to the version string that `listInstalledVersions` already
   * produces when a library has never been catalogued (section 8.1's cold-start
   * decision). Nothing here consults the catalogue to decide whether a version
   * exists; the filesystem is the ground truth (Q67).
   *
   * Never throws: an unreadable library is an empty list, not a failed status.
   *
   * @returns {{versions: Array<{version: string, state: string, installedAt: string|null}>,
   *            running: string|null, stale: boolean}}
   */
  librarySummary(options = {}) {
    const now = Date.now();
    const ttl = options.ttlMs ?? LIBRARY_SUMMARY_TTL_MS;

    if (
      this.libraryCache.value !== null &&
      now - this.libraryCache.at < ttl &&
      now >= this.libraryCache.at
    ) {
      return this.copySummary(this.libraryCache.value, true);
    }

    let versions = [];
    try {
      const installedAt = readInstalledAt({ paths: this.paths });
      // `validate: false` is deliberate and is NOT the rewire being undone. This
      // is a display list on the launcher's hottest read path, and its job is to
      // say which versions are on disk and which of them look complete enough to
      // report distinctly. The one place a tree must PROVABLY validate before it
      // can be started is the start path, which asks `isInstalledAndValid` - so a
      // tree this list calls `installed` but validation rejects is still repaired
      // rather than adopted.
      //
      // MEASURED, on the two real 2A trees: full validation 2.40 ms/call vs 0.20
      // ms/call without - twelve times the cost, because validation opens and then
      // reads a package.json per version. Both are small; the reason to skip it is
      // that this runs on the shell's 5s watcher AND the dashboard's 500ms poll,
      // and the cost is O(versions) with two file reads each rather than O(1).
      versions = listInstalledVersions({ paths: this.paths, installedAt, validate: false }).map((entry) => ({
        version: entry.version,
        state: entry.state,
        installedAt: entry.installedAt ?? null,
      }));
    } catch (error) {
      // A status read must never fail because enumeration did. The error is
      // reported rather than swallowed, because a library that cannot be read is
      // worth knowing about - but it does not cost the caller its status.
      this.log(`library enumeration failed: ${error.message}`);
      versions = [];
    }

    const value = { versions, running: this.harnessVersion() };
    this.libraryCache = { at: now, value };
    return this.copySummary(value, false);
  }

  /**
   * Hands out a summary that shares NO mutable structure with the memo.
   *
   * WHY THIS IS NOT `{ ...value }`. A shallow spread copies the container but not
   * the array inside it, so `summary.versions.push(...)` would write straight into
   * the cache and every later reader would see a version that does not exist. Found
   * by the real-library probe, which mutated the returned array and then found the
   * mutation still there. Every entry is copied too, for the same reason one level
   * down.
   *
   * The copy costs a few microseconds for a handful of versions; the alternative is
   * a cache that any caller can corrupt by accident.
   */
  copySummary(value, stale) {
    return {
      versions: value.versions.map((entry) => ({ ...entry })),
      running: value.running,
      stale,
    };
  }

  /**
   * Current observable status.
   *
   * Reads `runtime-state.json` and, when a harness is recorded, probes its URL
   * VERBATIM (token included, per Step 3). A recorded process whose URL does not
   * answer is reported as `error` rather than `running`: the UI must not be told
   * a dead page is live.
   *
   * @param {{probe?: boolean, inFlightVersion?: string|null,
   *          libraryTtlMs?: number}} [options] set `probe: false` for a cheap read;
   *   `inFlightVersion` names the version a caller has just asked to start, so a
   *   switch can report "starting 0.2.0-rc.1" instead of the version it is replacing
   */
  async status(options = {}) {
    // ONE read of the record, shared by every branch below. `librarySummary()`
    // already reads it for the `running` field, and the base payload reports that
    // same value, so the status and the version list can never describe two
    // different harnesses - which was possible while the two read the file
    // independently.
    const library = this.librarySummary({ ttlMs: options.libraryTtlMs });
    const state = this.recorded();

    const base = {
      status: STATUS.STOPPED,
      version: library.running,
      url: null,
      pid: null,
      startedAt: null,
      instanceId: null,
      logFile: null,
      launcherLog: null,
      lastError: this.lastError,
      message: null,
      // `librarySummary()` hands out copies (see `copySummary`), so this is a
      // second copy of an already-private array - cheap, and it keeps `status()`
      // from depending on that guarantee to be correct.
      recentVersions: library.versions.map((entry) => ({ ...entry })),
    };

    if (this.starting) {
      return {
        ...base,
        status: STATUS.STARTING,
        // The version being started when the caller named one, otherwise whatever
        // the previous record still knows. Reporting the requested version is
        // about to be true and is the more useful answer - but only when it was
        // actually requested, because inventing it for a registry start would be a
        // claim made before anything resolved it.
        version: options.inFlightVersion ?? library.running,
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

    // The version is deliberately null here: at this instant it has not been
    // resolved yet, and the honest answer is "not known" rather than the previous
    // harness's version. `status()` reports the in-flight version once the
    // sequence reaches the spawn stage.
    return { code: 202, payload: await this.statusPayload(null) };
  }

  /**
   * Starts a version the CALLER names, rather than the one the registry says is
   * current.
   *
   * This is the start half of a switch, and it exists so that a switch is
   * expressed as "start this specific version" rather than as a second copy of the
   * start sequence. The caller (the version manager) owns stopping the previous
   * harness and deciding whether the target needs installing; this method owns
   * everything after that, and reuses the SAME adopt/reap decision and the SAME
   * spawn-and-record path as an ordinary start.
   *
   * The registry is still consulted when the target is not already installed -
   * through `installFn`, which resolves what it needs for the version it is told to
   * install. `registryFn` is NOT called: "start exactly this version" and "ask the
   * registry what is current" are different instructions, and mixing them would
   * make a switch land on a version the user did not choose.
   *
   * @param {string} version exact version, e.g. "0.2.0-rc.2"
   * @param {{source?: string, operation?: string}} [options] `source` labels the
   *   progress text ("switch" vs "explicit"); `operation` is only for logs.
   */
  async startSpecificVersion(version, options = {}) {
    if (typeof version !== "string" || version.length === 0) {
      throw new Error("startSpecificVersion requires a version");
    }

    if (this.startPromise !== null) {
      // A start is already in flight; share it rather than starting a second.
      return { code: 202, payload: await this.status() };
    }

    // Already running THE SAME VERSION? Adopt and report 200 (section 3.3's fast
    // path). A start for a genuinely different version falls through: the adopt
    // decision below will find the old harness and reap it.
    const current = await this.status();
    if (current.status === STATUS.RUNNING && current.version === version) {
      return { code: 200, payload: current };
    }

    this.starting = true;
    this.progress = "Checking for an existing harness...";
    this.lastError = null;

    this.startPromise = this.runStartSequence({
      version,
      source: options.source ?? "explicit",
      operation: options.operation ?? `start ${version}`,
    })
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
        ...(await this.statusPayload(version)),
        status: STATUS.STARTING,
        version,
        message: `Starting ${version}...`,
      },
    };
  }

  /**
   * Builds the `202 Accepted` payload for an accepted start.
   *
   * Shared by both start entry points so they cannot report different shapes. The
   * version is named when the caller already knows it, and null when it is still
   * being resolved, which is the honest answer rather than a guess.
   */
  async statusPayload(version = null) {
    const library = this.librarySummary();
    return {
      status: STATUS.STARTING,
      version,
      url: null,
      pid: null,
      startedAt: null,
      instanceId: null,
      logFile: null,
      launcherLog: null,
      lastError: null,
      message: "Starting the harness...",
      recentVersions: library.versions.map((entry) => ({ ...entry })),
    };
  }

  /**
   * The actual start sequence: adopt -> reap -> resolve -> install -> spawn.
   *
   * Each stage is already-proven logic from Steps 3 and 4; this method only
   * orders them and turns any failure into a first-class error message. Both start
   * entry points run THIS sequence, with `options.version` deciding whether the
   * resolve stage asks the registry or accepts the caller's answer.
   *
   * Any throw is wrapped so the message names the failing step and carries the
   * last ~20 lines of the relevant log.
   *
   * @param {{version?: string, tag?: string, source?: string,
   *          operation?: string, onPhase?: Function}} [options]
   */
  async runStartSequence(options = {}) {
    const source = options.source ?? "registry";
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

      let version = options.version;
      let tag = options.tag;

      if (typeof version !== "string" || version.length === 0) {
        step.name = "resolve";
        this.progress = "Resolving the harness version...";
        const resolved = await this.registryFn();
        version = resolved.version;
        tag = resolved.tag;
        this.log(`start: resolved ${version} via dist-tag '${tag}'`);
      }

      step.name = "install";
      this.progress = `Ensuring ${version} is installed...`;
      const install = await this.installFn(version, { paths: this.paths, tag });
      this.log(`start: ${install.skipped ? "already installed" : "installed"} ${version}`);

      step.name = "spawn";
      this.progress = `Starting ${version} (this can take up to 5 minutes on first run)...`;
      options.onPhase?.(source === "switch" ? "starting" : "spawning", { version });

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
      // The wrapper text names the step, and for a switch it also names the
      // version. That matters because a failed switch's error text is the user's
      // ONLY diagnostic (Q80), so it has to say which version did not come up.
      const subject = source === "switch" ? "Version switch" : "Harness start";
      throw new Error(
        describeFailure(
          `${subject} failed during the "${step.name}" step: ${error.message}`,
          this.lastLogFile ? launcherLogFor(this.lastLogFile) : null,
          this.lastLogFile,
        ),
      );
    }
  }

  /**
   * The registry-driven start sequence.
   *
   * Named separately from `runStartSequence` because the registry path and the
   * switch path are different OPERATIONS sharing one implementation: this one asks
   * the registry which version is current, while `startSpecificVersion` already
   * knows. Both order the same adopt/reap, install, spawn and record steps.
   */
  async runStart() {
    return this.runStartSequence({ source: "registry", operation: "start" });
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
   * @param {URLSearchParams} [search] parsed query parameters. Accepted and
   *   deliberately unused: the harness lifecycle takes no parameters, and the third
   *   argument exists so the router can call this and `version-jobs.js`'s handler
   *   with ONE shape. A positional `undefined` that a caller omits is `undefined`,
   *   which the default replaces, so a two-argument caller keeps working - the
   *   signature is widened, never changed.
   */
  async handle(method, pathname, search = new URLSearchParams()) {
    void search;

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
