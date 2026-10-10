/**
 * Version management: a switch, a download, and the progress both report
 * (docs/PROJECT_DSH-DOCK.md sections 3.1, 3.6, 3.8, 2.3).
 *
 * WHAT THIS MODULE IS. `control.js` owns the harness LIFECYCLE - start, stop,
 * adopt, reap, and the status a UI polls. This module owns the version LIBRARY's
 * two long-running operations, downloading a version and switching to one, and the
 * progress surface a UI polls while they run. It deliberately holds no lifecycle
 * logic of its own: a switch is composed from `control.js`'s start sequence and
 * `library.js`'s three-state read, so there is one implementation of each step.
 *
 * WHY AN OPERATION IS NOT AN HTTP REQUEST. A cold install is minutes and a switch
 * includes a boot, so neither can be answered inside a response. Both are accepted
 * (`202`) and tracked in a JOB the caller polls - the same shape `/harness/start`
 * already has, deliberately, because two accept-then-poll conventions in one
 * sidecar would be one too many.
 *
 * THE FOUR PHASES ARE FOR DOWNLOADS, AND THEY ARE THE ONLY PROGRESS THIS MODULE
 * INVENTS. A switch's progress is NOT duplicated here: a switch IS a start from the
 * harness's point of view, so its `stopping -> installing -> starting` stages ride
 * on `/harness/status`'s existing `starting` + `message` fields, which the dashboard
 * already polls. One mechanism per concern - this route owns installs, that one
 * owns boots.
 *
 * THE LAST FINISHED JOB IS RETAINED. That single decision is what makes polling
 * reconnect-safe rather than merely pollable: a UI that reattaches after the
 * operation ended still learns the outcome instead of finding silence. If the
 * SIDECAR restarted, the job is gone and the honest answer is `busy: false` with no
 * job - the library is then the source of truth, and a directory in state `partial`
 * IS the visible debris of an interrupted install. That is the same "filesystem is
 * ground truth, bookkeeping is advisory" rule the catalogue follows (Q67), applied
 * to progress.
 *
 * No I/O at import time, and every dependency is injectable, so a test can drive the
 * whole surface against a scratch library with a stub registry and a stub installer.
 */

import { readInstalledAt } from "./catalogue.js";
import {
  LIBRARY_STATE,
  deletePartialVersion,
  deleteVersion,
  isSafeVersionName,
  listInstalledVersions,
  readLibraryEntry,
} from "./library.js";
import { acquireLock, releaseLock } from "./library-lock.js";
import { fetchPackument, readDistTag } from "./registry.js";
import { resolveStatePaths } from "./state.js";
/**
 * The shared constants keep their home in `version-manager.js`, and the name of THIS
 * file is what changed to respect that.
 *
 * This module was first written as `version-manager.js`, which collided with the
 * Phase 0 module that already owns `MIN_SUPPORTED_DSH` and `HARNESS_PACKAGE`.
 * Importing those from an identically-named file inside this module created a cycle
 * through `registry.js`, and ESM reported it as the OLD module "not providing an
 * export" - a misleading symptom for a naming mistake, worth recording because the
 * obvious reading of that error ("my export is missing") is wrong.
 *
 * So the constants file keeps its name and contents, and this module is
 * `version-jobs.js`: it owns the long-running version OPERATIONS - download and
 * switch - and the progress they report, which is what "jobs" names.
 */
import { HARNESS_PACKAGE, MIN_SUPPORTED_DSH } from "./version-manager.js";

/** Kinds of long-running job this module runs. */
export const JOB_KIND = Object.freeze({
  DOWNLOAD: "download",
  SWITCH: "switch",
});

/** The progress phases a DOWNLOAD reports (section 3.6, Phase 2B scope). */
export const PHASE = Object.freeze({
  RESOLVING: "resolving",
  DOWNLOADING: "downloading",
  LINKING: "linking",
  VALIDATING: "validating",
});

/** The stages a SWITCH reports. Reported in the job message, not as a phase. */
export const SWITCH_STAGE = Object.freeze({
  CHECKING: "checking",
  STOPPING: "stopping",
  INSTALLING: "installing",
  STARTING: "starting",
});

/** How long a registry listing is reused, in ms. `?refresh=1` bypasses it. */
export const LISTING_TTL_MS = 60 * 1000;

/**
 * How many versions `GET /registry/versions` returns, newest first.
 *
 * A BOUND, NOT A FILTER. The package publishes 30 versions today; the cap exists so
 * a future package with thousands cannot turn one UI refresh into a multi-megabyte
 * response. `truncated` and `total` are reported alongside, so a client can tell
 * "this is everything" from "this is the newest 50" - silently dropping the
 * difference is the failure mode a cap without those fields would create.
 */
export const AVAILABLE_VERSIONS_LIMIT = 50;

/** Human text per phase, so the UI never invents its own wording. */
export const PHASE_MESSAGES = Object.freeze({
  [PHASE.RESOLVING]: "Checking the npm registry...",
  [PHASE.DOWNLOADING]:
    "Downloading the harness (about 370 MB on a first run; a warm cache is far faster)...",
  [PHASE.LINKING]: "Linking the downloaded files into the version library...",
  [PHASE.VALIDATING]: "Checking that the installed tree is complete...",
});

/** The success message for a finished job, per kind. */
function successMessage(kind, version) {
  return kind === JOB_KIND.SWITCH
    ? `Switched to ${version}.`
    : `Installed ${version} into the version library.`;
}

/**
 * Compares two version strings by their components.
 *
 * Deliberately small, and deliberately NOT a semver implementation. It answers one
 * question in production - "is this below `MIN_SUPPORTED_DSH`?" - where both sides
 * are simple versions of the form `1.2.3` or `1.2.3-pre.4`. (The available-version
 * LIST is ordered by the registry's `time` map, not by this function; see
 * `available()`.)
 *
 * PRE-RELEASE IDENTIFIERS COMPARE NUMERICALLY PER DOT-SEPARATED PART, and that is
 * not a refinement - it is the difference between right and wrong. Comparing
 * `"rc.10" < "rc.9"` as strings is TRUE ('1' < '9'), so a naive implementation
 * reports rc.10 as OLDER than rc.9. With ten or more pre-releases in a series - which
 * this package has already reached on other lines - that would mark a newer version
 * as below the minimum and badge it as unsupported.
 *
 * Identifiers follow semver's rule closely enough for this purpose: numeric parts
 * compare as numbers, numeric parts sort BELOW alphanumeric ones, and a longer list
 * of otherwise-equal parts wins (`alpha.1` < `alpha.1.1`). A pre-release always sorts
 * below the release it belongs to.
 *
 * Anything unparseable returns 0 ("equal"). That is the safe direction: the
 * consequence of 0 is "not below the minimum", and the alternative - declaring a
 * user's installed version unsupported because our regex did not recognise it - is a
 * claim we would be making without evidence.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(value ?? ""),
    );
    if (match === null) return null;
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? null : match[4].split("."),
    };
  };

  const comparePre = (a, b) => {
    if (a === null && b === null) return 0;
    // A release outranks its own pre-releases.
    if (a === null) return 1;
    if (b === null) return -1;

    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const left = a[index];
      const right = b[index];
      // A shorter list of otherwise-equal parts sorts lower (`alpha` < `alpha.1`).
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      if (left === right) continue;

      const leftNumeric = /^\d+$/.test(left);
      const rightNumeric = /^\d+$/.test(right);

      // Numeric identifiers always have lower precedence than alphanumeric ones.
      if (leftNumeric && !rightNumeric) return -1;
      if (!leftNumeric && rightNumeric) return 1;

      if (leftNumeric && rightNumeric) {
        const difference = Number(left) - Number(right);
        if (difference !== 0) return difference < 0 ? -1 : 1;
        continue;
      }

      return left < right ? -1 : 1;
    }
    return 0;
  };

  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return 0;

  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }

  return comparePre(a.pre, b.pre);
}

/**
 * The version-library operations a UI can drive, plus the progress it polls.
 *
 * Every dependency is an option so a test can run the whole thing against fixtures:
 * `installFn` (the real installer by default), `listFn`, `deleteFn`,
 * `partialDeleteFn`, `packumentFn`, and `control` (an existing `HarnessControl`).
 */
export class VersionManager {
  /**
   * @param {{paths?: object, control?: object, installFn?: Function,
   *          listFn?: Function, deleteFn?: Function, partialDeleteFn?: Function,
   *          packumentFn?: Function, log?: Function, now?: Function,
   *          versionNameCheck?: Function}} [options]
   */
  constructor(options = {}) {
    this.paths = options.paths ?? resolveStatePaths();
    this.control = options.control ?? null;
    this.installFn = options.installFn ?? null;
    this.listFn = options.listFn ?? null;
    this.deleteFn = options.deleteFn ?? null;
    this.partialDeleteFn = options.partialDeleteFn ?? null;
    this.packumentFn = options.packumentFn ?? null;
    this.log = options.log ?? ((line) => process.stderr.write(`[sidecar] ${line}\n`));
    this.now = options.now ?? (() => Date.now());

    /**
     * The shared version-name predicate. Seeded from `library.js`, the
     * authoritative definition, so the check that guards a ROUTE and the check that
     * guards a DIRECTORY NAME cannot drift apart (Q71). Injectable only so a test
     * can hand in the same function explicitly.
     */
    this.versionNameCheck = options.versionNameCheck ?? isSafeVersionName;

    /** The single in-flight mutation, or null. Serializes EVERY library change. */
    this.jobPromise = null;
    /** The observable job. `busy` is derived from `jobPromise`, never stored. */
    this.job = this.idleJob();
    /** Memo for the registry listing. */
    this.listing = { at: 0, value: null };
  }

  /** The installer, resolved on first use so import order stays trivial. */
  async installer() {
    if (this.installFn !== null) return this.installFn;
    const module = await import("./harness-install.js");
    this.installFn = module.ensureVersionInstalled;
    return this.installFn;
  }

  idleJob() {
    return {
      id: null,
      kind: null,
      version: null,
      phase: null,
      message: null,
      startedAt: null,
      finishedAt: null,
      ok: null,
      reason: null,
      error: null,
      /**
       * Facts about the version this job acted on, carried on the JOB rather than
       * derived by the UI.
       *
       * `belowMinimum` is the sidecar's own comparison against `MIN_SUPPORTED_DSH`, and
       * `minimumSupported` is the value it compared against. Both are reported so the
       * UI can badge an outcome (Q77: mark, never block) WITHOUT re-implementing the
       * comparison or assuming which minimum was in force when the job ran - a
       * download can be started from the installed list, where `/registry/versions` was
       * never fetched.
       *
       * These were dead fields for one revision: `progress()` whitelists what it
       * returns, so setting them on the job was invisible. Caught by asking whether a
       * fact reaches a caller, which is this phase's recurring question.
       */
      belowMinimum: null,
      minimumSupported: null,
    };
  }

  // -------------------------------------------------------------------------
  // Progress surface
  // -------------------------------------------------------------------------

  /**
   * The current job, shaped for a poller.
   *
   * `busy` is computed from the in-flight promise rather than stored, because a
   * stored flag is a second copy of "is something running", and a second copy is a
   * thing that can drift out of step with reality.
   */
  progress() {
    const busy = this.jobPromise !== null;
    const started = this.job.startedAt === null ? null : Date.parse(this.job.startedAt);
    const ended = this.job.finishedAt === null ? this.now() : Date.parse(this.job.finishedAt);

    return {
      busy,
      id: this.job.id,
      kind: this.job.kind,
      version: this.job.version,
      phase: this.job.phase,
      message: this.job.message,
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt,
      elapsedMs: started === null ? null : Math.max(0, ended - started),
      /**
       * The supported-floor facts for this job's version.
       *
       * TOP-LEVEL as well as inside `job`, deliberately: a poller that only ever looks
       * at the summary - the shape a progress indicator uses while a job runs - still
       * sees which floor was in force, and does not have to reach into `job` for a fact
       * that is about the VERSION rather than about the outcome.
       */
      belowMinimum: this.job.belowMinimum,
      minimumSupported: this.job.minimumSupported,
      // RETAINED AFTER COMPLETION, deliberately: this is what lets a UI that was
      // closed during a two-minute install still show the outcome when it reopens.
      // `busy: false` WITH a job means "the last one finished like this".
      job: {
        ok: this.job.ok,
        reason: this.job.reason,
        error: this.job.error,
        finishedAt: this.job.finishedAt,
        belowMinimum: this.job.belowMinimum,
        minimumSupported: this.job.minimumSupported,
      },
    };
  }

  /** Replaces the observable job's mutable fields. Kept in one place. */
  setJob(patch) {
    Object.assign(this.job, patch);
  }

  /**
   * Advances the job's phase and logs it.
   *
   * A phase is reported for DOWNLOADS. A switch leaves `phase` null and reports its
   * stage through `message` plus `/harness/status`, because a switch's progress is a
   * boot's progress (see the module note).
   */
  setPhase(phase, extra = {}) {
    this.setJob({ phase, message: PHASE_MESSAGES[phase] ?? this.job.message, ...extra });
    this.log(`job ${this.job.id ?? "(none)"} ${this.job.kind ?? "-"} ${this.job.version ?? "-"}: phase=${phase}`);
    return this.progress();
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  /**
   * Starts one job, or refuses because another is already running.
   *
   * ONE JOB AT A TIME, FOR THE WHOLE LIBRARY. Two concurrent installs would fight
   * over the library lock anyway (`library-lock.js` refuses the second), and a
   * switch during an install would stop the harness and only then discover it cannot
   * install - losing the user's session to a bookkeeping collision. Serializing here
   * is therefore not a limitation; it is what keeps that collision unreachable.
   *
   * @returns {{accepted: boolean, code: number, payload: object}}
   */
  beginJob(kind, version, work) {
    if (this.jobPromise !== null) {
      return {
        accepted: false,
        code: 409,
        payload: {
          ...this.progress(),
          ok: false,
          error: "another-operation-in-flight",
          message:
            `Another version operation is already running (${this.job.kind} ${this.job.version}, ` +
            `phase ${this.job.phase ?? "starting"}). Wait for it to finish.`,
        },
      };
    }

    this.job = {
      ...this.idleJob(),
      id: `${kind}-${version}-${this.now().toString(36)}`,
      kind,
      version,
      startedAt: new Date(this.now()).toISOString(),
      phase: kind === JOB_KIND.DOWNLOAD ? PHASE.RESOLVING : null,
      message:
        kind === JOB_KIND.SWITCH ? `Switching to ${version}...` : PHASE_MESSAGES[PHASE.RESOLVING],
      // Known the moment a job starts, because the job is about exactly one version.
      // Reported here rather than derived by the UI, so a badge cannot disagree with
      // the floor the sidecar actually judged the version against.
      belowMinimum: compareVersions(version, MIN_SUPPORTED_DSH) < 0,
      minimumSupported: MIN_SUPPORTED_DSH,
    };

    this.jobPromise = Promise.resolve()
      .then(() => work())
      .then((result) => {
        this.setJob({
          ok: true,
          reason: result?.reason ?? "ok",
          error: null,
          finishedAt: new Date(this.now()).toISOString(),
          phase: null,
          message: result?.message ?? successMessage(kind, version),
        });
        this.log(`job ${this.job.id} finished ok: ${this.job.message}`);
        return result;
      })
      .catch((error) => {
        this.setJob({
          ok: false,
          reason: error?.reason ?? error?.step ?? "failed",
          error: error?.message ?? String(error),
          finishedAt: new Date(this.now()).toISOString(),
          phase: null,
          message:
            kind === JOB_KIND.SWITCH
              ? `Switching to ${version} failed: ${error?.message ?? String(error)}`
              : `Installing ${version} failed: ${error?.message ?? String(error)}`,
        });
        this.log(`job ${this.job.id} FAILED: ${this.job.error}`);
        return null;
      })
      .finally(() => {
        this.jobPromise = null;
      });

    // Deliberately not awaited: the HTTP response must be immediate.
    void this.jobPromise;

    return { accepted: true, code: 202, payload: this.progress() };
  }

  /**
   * Waits out any in-flight job. Never rejects.
   *
   * The sidecar's shutdown awaits this BEFORE closing the server, for the same
   * reason `control.settled()` exists: abandoning a job mid-flight would leave a
   * staged directory, or a stopped harness with no state file, behind a process that
   * is already gone.
   */
  async settled() {
    if (this.jobPromise !== null) await this.jobPromise;
  }

  /**
   * Whether another process holds the library lock, with an explanation.
   *
   * READ-ONLY, AND THAT IS THE POINT. This is called before a switch stops anything,
   * so it must not create, take over or release a lock - a probe that mutated lock
   * state would be able to cause the very collision it is checking for.
   *
   * IT ASKS THE SAME QUESTION THE INSTALLER WILL. `acquireLock`'s verdict is
   * derived rather than re-implemented, so the probe and the mutation it guards
   * cannot disagree. Concretely: an UNREADABLE lock file is stale by
   * `library-lock.js`'s rule ("no live holder can be claimed"), `withLock` takes it
   * over, and this probe must therefore report it as NOT held. Reporting it as held
   * would refuse the switch to protect a lock the install was about to steal - the
   * user would be told to fix a file that was going to be replaced anyway, and the
   * probe would be STRICTER than the operation it guards.
   *
   * `acquireLock` WRITES a lock file when it succeeds, so a successful acquire here
   * is released immediately. That matches `install-flow.js`'s existing observation
   * that an unreadable lock is treated as stale, and it is why the caller must not
   * hold anything: this probe's whole lifetime is one function call.
   */
  lockHeld() {
    const acquired = acquireLock({
      paths: this.paths,
      reason: "switch lock probe",
      now: this.now(),
    });

    if (acquired.acquired) {
      // Nothing was held, and our own probe lock goes away at once.
      const released = releaseLock({ paths: this.paths });
      if (!released.released) {
        // Worth a line: it means something took the lock between our acquire and
        // our release, which is a race the retry in `withLock` will handle but which
        // is unusual enough to be visible.
        this.log(`switch probe: could not release its own lock (${released.reason})`);
      }
      return { held: false, holder: null, stale: false, reason: "no live holder" };
    }

    if (acquired.error !== null) {
      // The lock could not even be created - a permissions or path problem. That is
      // not "held", and it is not safe to ignore either, so it is reported as held
      // with the real reason attached rather than guessed at.
      return { held: true, holder: acquired.holder, stale: false, reason: acquired.error };
    }

    return {
      held: true,
      holder: acquired.holder,
      stale: false,
      reason: acquired.stolen === false ? "held by a live process" : "held",
    };
  }

  // -------------------------------------------------------------------------
  // The library, as a UI needs to see it
  // -------------------------------------------------------------------------

  /**
   * Every version on disk, newest-first, with its state.
   *
   * Uses the CHEAP completeness probe, because this feeds a hot read path. The
   * verdict it gives is the same one the start path reaches for every case except an
   * unreadable or unparseable manifest - and the start path is the strict one, so a
   * disagreement can only ever lead to a repair, never to adopting a broken tree.
   */
  library() {
    try {
      const installedAt = readInstalledAt({ paths: this.paths });
      const list = this.listFn ?? listInstalledVersions;
      return list({ paths: this.paths, installedAt, validate: false }).map((entry) => ({
        version: entry.version,
        state: entry.state,
        installedAt: entry.installedAt ?? null,
        hasIncompleteMarker: entry.hasIncompleteMarker === true,
      }));
    } catch (error) {
      // A list that cannot be read is an empty list plus a log line, never a failed
      // status: the caller is rendering, not deciding.
      this.log(`version list failed: ${error.message}`);
      return [];
    }
  }

  /** One version's state. Never throws, not even for an unsafe name. */
  entryState(version) {
    try {
      const entry = readLibraryEntry(version, { paths: this.paths, validate: false });
      return entry.state;
    } catch {
      return LIBRARY_STATE.ABSENT;
    }
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Installs one exact version into the library, reporting the four phases.
   *
   * The four phases are seeded here so a poller sees one IMMEDIATELY rather than an
   * empty field for the first milliseconds; from then on the installer's own
   * `onPhase` reports are authoritative, because the installer is the only thing
   * that knows when npm actually started and when the tree check actually ran.
   */
  download(version) {
    return this.beginJob(JOB_KIND.DOWNLOAD, version, async () => {
      const installFn = await this.installer();

      this.setPhase(PHASE.DOWNLOADING);

      const result = await installFn(version, {
        paths: this.paths,
        force: false,
        onPhase: (phase) => this.setPhase(phase),
      });

      return {
        reason: result.skipped ? "already-installed" : "installed",
        message: result.skipped
          ? `${version} was already installed and valid; nothing was downloaded.`
          : successMessage(JOB_KIND.DOWNLOAD, version),
        installDir: result.installDir,
        skipped: result.skipped === true,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Switch
  // -------------------------------------------------------------------------

  /**
   * Switches the running harness to `version`.
   *
   * THE GUARD ORDER IS THE WHOLE DESIGN (Q82). Each step is cheap, and each one
   * exists because doing it later costs the user something:
   *
   *   1. refuse a version name that could not name a directory (in the route);
   *   2. refuse if another JOB is running (two switches, or a switch during a
   *      download) - before anything is stopped;
   *   3. refuse if another PROCESS holds the library lock (in the route) - before
   *      anything is stopped. THIS IS THE IMPORTANT ONE: a stop followed by an
   *      install that cannot take the lock would leave the user with no harness for
   *      no reason at all;
   *   4. stop the recorded harness, identity-checked - a foreign pid is never
   *      killed, and a refusal aborts the switch;
   *   5. install ONLY if the target is not already installed, which on the common
   *      path means no install at all: a switch between two installed versions is a
   *      stop and a spawn, nothing more;
   *   6. start the named version through `control.js`'s own sequence, which writes
   *      `runtime-state.json` only after the harness announces a URL.
   *
   * WHY THE INSTALL COMES AFTER THE STOP, given that is the riskier ordering. A
   * version whose tree is `partial` AND is recorded as running is refused by
   * `installVersion`'s running-version guard, so installing before the stop would
   * turn a repair into a hard `InstallError`. Stopping first is what makes the repair
   * path work, and it is also what makes the switch truthful: from the moment we
   * stop, the user has no harness, and the state file says so.
   *
   * WHAT A FAILURE LEAVES BEHIND. The harness is stopped, the job carries the
   * failing step and the underlying message, `runtime-state.json` is cleared and the
   * NEW state was never written, and the previous version is still installed. There
   * is deliberately NO rollback - see Q80: the harness is already down and its
   * per-boot token is already dead, so "rolling back" is a second stop-and-start
   * arriving at a URL that is not the one the user was on. `previousVersion` is
   * reported instead, so the UI can offer the way back as a CLICK rather than
   * performing it silently.
   */
  switchTo(version) {
    const startedAt = this.now();

    return this.beginJob(JOB_KIND.SWITCH, version, async () => {
      const installFn = await this.installer();

      if (this.control === null) {
        const error = new Error(
          "No harness control is wired in, so a switch cannot stop or start anything. Nothing was changed.",
        );
        error.reason = "no-control";
        throw error;
      }

      // --- what we are replacing, read BEFORE anything is stopped ------------
      // Read first so the message can name it. After the stop it is gone, and a
      // failure message that cannot say what the user lost is not actionable.
      const previousVersion = this.control.harnessVersion();

      // --- 4. stop -----------------------------------------------------------
      this.setJob({
        message: `Stopping the running harness${previousVersion ? ` (${previousVersion})` : ""}...`,
      });
      const stop = await this.control.stop();
      const stopMessage = stop?.payload?.message ?? null;
      this.log(`switch: stop -> ${stopMessage}`);

      // A stop REFUSED on identity means a foreign process owns the recorded pid.
      // Starting a second harness now could collide with whatever is really
      // listening, so the switch stops here rather than pressing on. (The harness
      // may also not have been running at all, which is not a refusal - that is
      // `No running harness to stop.` and the switch proceeds.)
      if (/not ours|left alone/i.test(stopMessage ?? "")) {
        const error = new Error(
          `Refusing to switch: the recorded process is not our harness, so it was left alone ` +
            `(${stopMessage}). Nothing was started, because a second harness could collide with ` +
            `whatever is listening. Stop it yourself, or clear runtime-state.json, then try again.`,
        );
        error.reason = "identity-mismatch";
        throw error;
      }

      // --- 5. install, only when it is actually needed -----------------------
      const state = this.entryState(version);
      let install = null;

      if (state === LIBRARY_STATE.INSTALLED) {
        this.setJob({ message: `${version} is already installed; starting it...` });
        this.log(`switch: ${version} is installed; no install needed`);
      } else {
        this.setJob({ message: `Installing ${version} (this can take a few minutes)...` });
        this.log(`switch: ${version} is ${state}; installing`);

        try {
          install = await installFn(version, {
            paths: this.paths,
            force: false,
            onPhase: (phase) => this.setPhase(phase),
          });
        } catch (error) {
          // NAME THE STATE THE USER IS ACTUALLY IN. This is the "harness stopped,
          // install failed" case, and the message is the only diagnostic they get
          // (Q80) - so it says that nothing is running, what failed, and that the
          // way back is still installed.
          const wrapped = new Error(
            `The previous harness was stopped and ${version} could not be installed, so no harness is ` +
              `running now. ${error?.message ?? error}` +
              (previousVersion
                ? ` The previous version (${previousVersion}) is still installed; switching back to it ` +
                  `will start a harness again.`
                : ""),
          );
          wrapped.reason = "install-failed";
          wrapped.step = error?.step ?? null;
          throw wrapped;
        }
      }

      // --- 6. start ----------------------------------------------------------
      this.setJob({ message: `Starting ${version}...` });

      // `startSpecificVersion` reuses `control.js`'s adopt/spawn/record sequence and
      // never consults the registry: "start exactly this version" and "ask the
      // registry what is current" are different instructions, and mixing them would
      // land the user on a version they did not choose.
      const started = await this.control.startSpecificVersion(version, {
        source: "switch",
        operation: `switch to ${version}`,
      });

      // The start is accepted asynchronously (202) and `control.js` owns the boot
      // from here. Awaiting its settlement is what makes `busy` on THIS job mean
      // "the switch is finished" rather than "the switch was requested" - which is
      // what a caller polling `/versions/progress` needs to be true.
      await this.control.settled();

      const status = await this.control.status();
      if (status.status !== "running") {
        const error = new Error(
          `${version} was installed and started, but the harness did not come up` +
            `${status.lastError ? `: ${status.lastError}` : ` (status: ${status.status}).`}` +
            (previousVersion ? ` The previous version (${previousVersion}) is still installed.` : ""),
        );
        error.reason = "start-failed";
        throw error;
      }

      return {
        reason: "switched",
        message: successMessage(JOB_KIND.SWITCH, version),
        previousVersion,
        install: install === null ? "not-needed" : install.skipped ? "already-installed" : "installed",
        elapsedMs: this.now() - startedAt,
        started: started.code,
        status: status.status,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /**
   * Removes one version from the library.
   *
   * A partial tree goes through `deletePartialVersion` and a complete one through
   * `deleteVersion`, so the two intents stay explicit (2A's decision) and 2C's
   * storage cleanup inherits one implementation rather than a second copy of the
   * delete rules.
   *
   * The RUNNING version is refused by `library.js` itself, not here: that guard lives
   * with the destructive operation, where no caller can bypass it by forgetting to
   * ask.
   */
  async remove(version, options = {}) {
    if (this.jobPromise !== null) {
      return {
        accepted: false,
        code: 409,
        payload: {
          ok: false,
          error: "another-operation-in-flight",
          message:
            `Another version operation is already running (${this.job.kind} ${this.job.version}), so ` +
            `nothing was deleted.`,
        },
      };
    }

    const deleteFn = options.partial
      ? this.partialDeleteFn ?? deletePartialVersion
      : this.deleteFn ?? deleteVersion;

    let result;
    try {
      result = await deleteFn(version, { paths: this.paths });
    } catch (error) {
      result = {
        ok: false,
        deleted: false,
        reason: "failed",
        message: `Deleting ${version} failed: ${error.message}`,
        error: error.message,
      };
    }

    return { accepted: true, code: result.ok ? 200 : 409, payload: { ...result, version } };
  }

  // -------------------------------------------------------------------------
  // Registry listing
  // -------------------------------------------------------------------------

  /**
   * The channel a version belongs to, derived from the packument's dist-tags.
   *
   * A version can hold SEVERAL tags: `0.2.0-rc.2` is both `latest` and `next` today.
   * `latest` wins the tie, because that is the channel a user means by "stable", and
   * reporting it as only an RC would read as if the stable channel did not exist.
   * `allChannels` carries the rest, so the UI can show that a version is both.
   *
   * The channel names match `settings.json`'s vocabulary and the menu's, so no
   * surface has to translate between two spellings.
   */
  channelFor(version, distTags) {
    const tags = { "dist-tags": distTags ?? {} };
    const matches = [];
    if (readDistTag(tags, "latest") === version) matches.push({ channel: "stable", tag: "latest" });
    if (readDistTag(tags, "next") === version) matches.push({ channel: "rc", tag: "next" });
    if (readDistTag(tags, "alpha") === version) matches.push({ channel: "alpha", tag: "alpha" });

    if (matches.length === 0) return { channel: "other", distTag: null, allChannels: [] };
    return {
      channel: matches[0].channel,
      distTag: matches[0].tag,
      allChannels: matches.map((match) => match.channel),
    };
  }

  /**
   * Available versions from the registry, newest first by publish date.
   *
   * ORDERING USES THE PACKUMENT'S OWN `time` MAP, NOT a semver comparison. A
   * hand-rolled comparator would be a parser to maintain and to get subtly wrong
   * (`0.2.0-rc.10` vs `0.2.0-rc.9`), while the registry already publishes an
   * authoritative timestamp per version - which is also the order a user means by
   * "newest". The package's own key order happens to be chronological too, but
   * relying on JSON key order would be relying on something no spec promises.
   *
   * `installed` and `state` come from the LOCAL library, because a UI needs both
   * halves to decide whether a row offers "Download" or "Switch".
   */
  async available(options = {}) {
    const refresh = options.refresh === true;
    const now = this.now();

    if (
      !refresh &&
      this.listing.value !== null &&
      now - this.listing.at < LISTING_TTL_MS &&
      now >= this.listing.at
    ) {
      return { ...this.listing.value, fromCache: true };
    }

    const packumentFn = this.packumentFn ?? fetchPackument;
    const packument = await packumentFn(HARNESS_PACKAGE, options.packumentOptions ?? {});

    const distTags = packument?.["dist-tags"] ?? {};
    const time = packument?.time ?? {};

    const published = Object.keys(packument?.versions ?? {}).map((version) => ({
      version,
      publishedAt: typeof time[version] === "string" ? time[version] : null,
    }));

    published.sort((left, right) => {
      if (left.publishedAt === right.publishedAt) return left.version < right.version ? 1 : -1;
      // An undated version sorts LAST, never first: "unknown date" must not be
      // presented as "newest".
      if (left.publishedAt === null) return 1;
      if (right.publishedAt === null) return -1;
      return left.publishedAt < right.publishedAt ? 1 : -1;
    });

    const local = new Map(this.library().map((entry) => [entry.version, entry]));
    const minimum = options.minimumSupported ?? MIN_SUPPORTED_DSH;

    const versions = published.map((entry) => {
      const { channel, distTag, allChannels } = this.channelFor(entry.version, distTags);
      const localEntry = local.get(entry.version);
      return {
        version: entry.version,
        channel,
        distTag,
        allChannels,
        publishedAt: entry.publishedAt,
        installed: localEntry?.state === LIBRARY_STATE.INSTALLED,
        state: localEntry?.state ?? LIBRARY_STATE.ABSENT,
        hasIncompleteMarker: localEntry?.hasIncompleteMarker === true,
        // Q77: MARK, NEVER OMIT. The user is sovereign, and hiding a version is
        // blocking by another name.
        belowMinimum: compareVersions(entry.version, minimum) < 0,
      };
    });

    const truncated = versions.length > AVAILABLE_VERSIONS_LIMIT;
    const value = {
      fetchedAt: new Date(now).toISOString(),
      package: HARNESS_PACKAGE,
      channelTags: {
        stable: distTags.latest ?? null,
        rc: distTags.next ?? null,
        alpha: distTags.alpha ?? null,
      },
      versions: versions.slice(0, AVAILABLE_VERSIONS_LIMIT),
      total: versions.length,
      truncated,
      limit: AVAILABLE_VERSIONS_LIMIT,
      minimumSupported: minimum,
    };

    this.listing = { at: now, value };
    return { ...value, fromCache: false };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Routes one version/registry request.
   *
   * Returns `{ code, payload }`, or `null` when the path is not ours so the caller
   * can 404. `search` carries the query parameters, which is why `service.js` passes
   * it down: a switch names its target with `?version=`, while
   * `/registry/download/<version>` puts the version in a path segment, where the
   * phase specification asks for it.
   */
  async handle(method, pathname, search = new URLSearchParams()) {
    const get = method === "GET";
    const post = method === "POST";

    if (get && pathname === "/versions/progress") {
      return { code: 200, payload: this.progress() };
    }

    if (get && pathname === "/versions/status") {
      return {
        code: 200,
        payload: {
          progress: this.progress(),
          library: this.library(),
          running: this.control?.harnessVersion?.() ?? null,
          minimumSupported: MIN_SUPPORTED_DSH,
        },
      };
    }

    if (get && pathname === "/registry/versions") {
      try {
        return { code: 200, payload: await this.available({ refresh: search.get("refresh") === "1" }) };
      } catch (error) {
        return {
          code: 503,
          payload: {
            ok: false,
            error: "registry-unreachable",
            message:
              `Could not read the version list from the npm registry: ${error.message}. ` +
              `Nothing was changed, and the locally installed versions are unaffected.`,
          },
        };
      }
    }

    if (post && pathname.startsWith("/registry/download/")) {
      const version = safeDecode(pathname.slice("/registry/download/".length));
      return this.downloadRoute(version);
    }

    if ((post || get) && pathname === "/versions/switch") {
      return this.switchRoute(search.get("version"));
    }

    if (post && pathname === "/library/delete") {
      const version = search.get("version");
      if (version === null || version.length === 0) {
        return {
          code: 400,
          payload: { ok: false, error: "missing-version", message: "A ?version= parameter is required." },
        };
      }
      return this.remove(version, { partial: search.get("partial") === "1" });
    }

    return null;
  }

  /** Validates a version name, then starts a download. */
  downloadRoute(version) {
    const refusal = this.refuseBadTarget(version);
    if (refusal !== null) return refusal;
    return this.download(version);
  }

  /** Validates a version name, probes the lock, then starts a switch. */
  switchRoute(version) {
    const refusal = this.refuseBadTarget(version);
    if (refusal !== null) return refusal;

    // THE PRE-STOP LOCK PROBE (Q82 step 3). Refusing here costs nothing; refusing
    // after the stop costs the user their session.
    const lock = this.lockHeld();
    if (lock.held) {
      return {
        code: 409,
        payload: {
          ok: false,
          error: "library-locked",
          message:
            `Another version library operation is in progress${lock.holder ? ` (${lock.holder})` : ""}, so the ` +
            `switch was not started and the running harness was left alone. ${lock.reason ?? ""}`.trim(),
          holder: lock.holder,
        },
      };
    }

    return this.switchTo(version);
  }

  /**
   * The shared version-name gate for both routes.
   *
   * Returns a response object, or `null` when the name is acceptable. Uses
   * `library.js`'s predicate, so a name this refuses is exactly a name
   * `installDirFor` would refuse - one definition, two callers (Q71).
   */
  refuseBadTarget(version) {
    if (version === null || version === undefined || String(version).length === 0) {
      return {
        code: 400,
        payload: {
          ok: false,
          error: "missing-version",
          message:
            "A version is required. Expected an exact version such as 0.2.0-rc.2; a dist-tag is not accepted.",
        },
      };
    }

    if (!this.versionNameCheck(version)) {
      return {
        code: 400,
        payload: {
          ok: false,
          error: "invalid-version",
          message:
            `Refusing ${JSON.stringify(String(version))}: it is not an exact version, so it cannot name a ` +
            `directory in the version library. Expected something like "0.2.0-rc.2"; a dist-tag, a range or ` +
            `a path is not accepted.`,
        },
      };
    }

    return null;
  }
}

/**
 * `decodeURIComponent` that never throws.
 *
 * A malformed escape in a URL - `%zz` - makes `decodeURIComponent` throw, and a
 * throw inside a route handler becomes a 500 for what is really a bad request. The
 * raw value is returned instead, so the version-name gate refuses it as an invalid
 * version, which is the accurate diagnosis.
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
