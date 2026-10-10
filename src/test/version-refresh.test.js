/**
 * Tests for the poll-cadence and job-completion decisions
 * (src/lib/version-refresh.js).
 *
 * WHY THESE EXIST AT ALL. The Phase 2B acceptance run found two stale-state bugs, and
 * BOTH were wrong answers to "when should this refresh?":
 *
 *   1. the dashboard's Harness card polled only while a boot was in flight, so a switch
 *      made anywhere else left it showing the old version and an "Open Harness" button
 *      pointing at a URL the previous harness had served - the loading error the user
 *      hit;
 *   2. the version manager's progress poll began only from a job it had already seen or
 *      started, so a MENU-initiated switch never reached it and the Installed list kept
 *      its "Running" badge on the previous version.
 *
 * Neither was a rendering bug or an interval bug. They were decisions, made inside
 * components where the only way to exercise them was to run the app and look. Pulling
 * them into a plain-JS module makes the regression - "the cadence is infinite when
 * nothing is happening" - a failing assertion instead of a manual re-test.
 *
 * Plain JS, injected values, no browser and no Svelte: the same shape as
 * `sidecar-connection.test.js`.
 *
 * Run from the repo root:  node src/test/version-refresh.test.js
 */

import { createReport } from "../../sidecar/test/lib/check.js";
import {
  DOWNLOAD_PHASES,
  HARNESS_ACTIVE_POLL_MS,
  HARNESS_IDLE_POLL_MS,
  VERSIONS_ACTIVE_POLL_MS,
  VERSIONS_IDLE_POLL_MS,
  harnessPollMs,
  jobCompletion,
  versionsPollMs,
} from "../lib/version-refresh.js";

const report = createReport("DSH-Dock frontend: version refresh cadences");

// ---------------------------------------------------------------------------
// Bug 1: the dashboard must keep polling when nothing is happening
// ---------------------------------------------------------------------------

await report.section("1. the harness poll NEVER stops (bug 1)", () => {
  // THE REGRESSION. `harnessPollMs` used to be, in effect, "500 while starting, stop
  // otherwise" - the caller called a `stopTimers()`. A stopped poll cannot observe a
  // change made anywhere else, and the user's symptom followed directly.
  for (const status of ["stopped", "running", "error", undefined, null, "unavailable"]) {
    const interval = harnessPollMs(status);
    report.check(
      `${JSON.stringify(status)} polls at the idle cadence, not never`,
      interval === HARNESS_IDLE_POLL_MS,
      `${interval}`,
    );
    report.check(
      `${JSON.stringify(status)} produces a finite, positive interval`,
      Number.isFinite(interval) && interval > 0,
      `${interval}`,
    );
  }

  report.check(
    "`starting` is the only status that earns the fast cadence",
    harnessPollMs("starting") === HARNESS_ACTIVE_POLL_MS,
    `${harnessPollMs("starting")}`,
  );
  report.check(
    "the fast cadence is faster than the idle one",
    HARNESS_ACTIVE_POLL_MS < HARNESS_IDLE_POLL_MS,
    `${HARNESS_ACTIVE_POLL_MS} vs ${HARNESS_IDLE_POLL_MS}`,
  );
  report.check(
    "an UNKNOWN status still polls rather than stopping",
    harnessPollMs("something-new") === HARNESS_IDLE_POLL_MS,
    `${harnessPollMs("something-new")}`,
  );
});

// ---------------------------------------------------------------------------
// Bug 3: the version manager must discover a job it did not start
// ---------------------------------------------------------------------------

await report.section("2. the versions poll speeds up for a job it did not start (bug 3)", () => {
  report.check(
    "busy drives the fast cadence",
    versionsPollMs(true) === VERSIONS_ACTIVE_POLL_MS,
    `${versionsPollMs(true)}`,
  );
  // The idle figure is what lets a MENU-initiated job be discovered at all. The bug was
  // that the component's poll only ever started on `busy === true`, so this value was
  // never used to LOOK for one.
  report.check(
    "not-busy still polls - this is what discovers a menu-initiated switch",
    versionsPollMs(false) === VERSIONS_IDLE_POLL_MS,
    `${versionsPollMs(false)}`,
  );
  report.check(
    "a missing `busy` (undefined) is treated as not busy, and still polls",
    versionsPollMs(undefined) === VERSIONS_IDLE_POLL_MS,
    `${versionsPollMs(undefined)}`,
  );
  report.check(
    "the idle cadence is finite and longer than the active one",
    Number.isFinite(VERSIONS_IDLE_POLL_MS) && VERSIONS_IDLE_POLL_MS > VERSIONS_ACTIVE_POLL_MS,
    `${VERSIONS_IDLE_POLL_MS} vs ${VERSIONS_ACTIVE_POLL_MS}`,
  );
  report.check(
    "both surfaces idle at the same cadence, so the screen does not tick twice",
    VERSIONS_IDLE_POLL_MS === HARNESS_IDLE_POLL_MS,
    `${VERSIONS_IDLE_POLL_MS} vs ${HARNESS_IDLE_POLL_MS}`,
  );
});

// ---------------------------------------------------------------------------
// A retained job must not look like a fresh one
// ---------------------------------------------------------------------------

await report.section("3. a RETAINED job is not mistaken for a fresh completion", () => {
  const done = {
    busy: false,
    kind: "switch",
    version: "0.2.0-rc.1",
    job: { ok: true, reason: "switched", error: null, finishedAt: "2026-10-08T10:00:00.000Z" },
  };

  // First observation: nothing acted on yet.
  const first = jobCompletion(done, null);
  report.check("a first completion is reported as one", first.completed === true, JSON.stringify(first));
  report.check("and it carries the stamp to remember", first.finishedAt === done.job.finishedAt, String(first.finishedAt));

  // THE CASE THAT MATTERS. The sidecar RETAINS the last job, so the next poll returns
  // the SAME job. Acting on it again would re-read the library forever and notify the
  // dashboard on every tick.
  const second = jobCompletion(done, first.finishedAt);
  report.check(
    "the SAME job seen again is NOT a new completion",
    second.completed === false,
    JSON.stringify(second),
  );

  // A genuinely new job has a different stamp.
  const newer = {
    ...done,
    version: "0.2.0-rc.2",
    job: { ...done.job, finishedAt: "2026-10-08T10:05:00.000Z" },
  };
  report.check(
    "a NEWER job is a completion even though the shape is identical",
    jobCompletion(newer, first.finishedAt).completed === true,
  );

  // A job that has not finished must never be reported as one.
  const running = { busy: true, kind: "switch", version: "0.2.0-rc.1", job: { ok: null, reason: null, error: null, finishedAt: null } };
  report.check("an unfinished job is not a completion", jobCompletion(running, null).completed === false);
  report.check(
    "and the remembered stamp is preserved, not cleared",
    jobCompletion(running, "2026-10-08T10:00:00.000Z").finishedAt === "2026-10-08T10:00:00.000Z",
  );

  // Degenerate inputs must not throw: this runs inside a poll.
  for (const input of [null, undefined, {}, { job: null }, { job: { ok: null } }]) {
    const result = jobCompletion(input, null);
    report.check(
      `degenerate input ${JSON.stringify(input)} yields no completion rather than throwing`,
      result.completed === false,
      JSON.stringify(result),
    );
  }

  // A FAILED job is still a completion: the error card depends on it, and the library
  // must be re-read (a failed switch may still have installed the target).
  const failed = {
    busy: false,
    kind: "switch",
    version: "0.2.0-rc.1",
    job: { ok: false, reason: "start-failed", error: "did not come up", finishedAt: "2026-10-08T11:00:00.000Z" },
  };
  report.check("a FAILED job is a completion too", jobCompletion(failed, null).completed === true);
  const stale = { ...failed, job: { ...failed.job } };
  report.check("a failed job retains its stamp", jobCompletion(stale, failed.job.finishedAt).completed === false);
});

// ---------------------------------------------------------------------------
// The phase vocabulary matches the sidecar's
// ---------------------------------------------------------------------------

await report.section("4. the download phase vocabulary is the sidecar's", async () => {
  // The UI shows these four in order. If a name drifted, the indicator would sit on a
  // phase that never arrives - the same cross-module pin the sidecar suites apply.
  const jobs = await import("../../sidecar/lib/version-jobs.js");
  report.check(
    "the frontend's four phases are the sidecar's four phases",
    JSON.stringify([...DOWNLOAD_PHASES].sort()) ===
      JSON.stringify(Object.values(jobs.PHASE).sort()),
    `${DOWNLOAD_PHASES.join(",")} vs ${Object.values(jobs.PHASE).join(",")}`,
  );
  report.check(
    "and they are the four the phase specification names, in order",
    DOWNLOAD_PHASES.join(",") === "resolving,downloading,linking,validating",
    DOWNLOAD_PHASES.join(","),
  );
  report.check("the list is frozen, so a component cannot reorder it in place", Object.isFrozen(DOWNLOAD_PHASES));
});

process.exit(report.finish());
