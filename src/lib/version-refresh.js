/**
 * Refresh cadences for the two polled surfaces.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT CONSTANTS INSIDE THE COMPONENTS.
 *
 * Phase 2B's acceptance run found two stale-state bugs, and both were in the DECISION
 * of when to poll rather than in the polling itself:
 *
 *   1. the dashboard's Harness card polled ONLY while a boot was in flight, so a
 *      switch made anywhere else (the version manager, or the menu) left it showing
 *      the OLD version and an "Open Harness" button pointing at a URL the previous
 *      harness had served - a dead URL, hence the loading error the user saw;
 *   2. the version manager's progress poll started only from a job it had itself seen
 *      or started, so a MENU-initiated switch never reached it and the Installed list
 *      kept its "Running" badge on the previous version.
 *
 * Both are pure decisions about the current state. Keeping them here - plain JS, no
 * Svelte, no DOM - means they can be tested under `node`, in the same tier and with the
 * same style as `sidecar-connection.js`. A decision that two bugs lived in should not
 * be trapped inside a component where the only way to exercise it is to run the app.
 */

/** How often the dashboard re-reads the harness status while a boot is in flight. */
export const HARNESS_ACTIVE_POLL_MS = 500;

/**
 * How often the dashboard re-reads the harness status when nothing is in flight.
 *
 * NOT ZERO, and that is the fix. The dashboard's job is to report the harness's state,
 * including state it did not cause: a menu switch (which goes straight to the sidecar,
 * Q74), a menu stop, or a harness reaped by the next launch's adopt/reap. Polling only
 * during a transition means never noticing any of them.
 */
export const HARNESS_IDLE_POLL_MS = 5000;

/** How often the version manager re-reads the job and library while nothing runs. */
export const VERSIONS_IDLE_POLL_MS = 5000;

/** How often the version manager re-reads the job while one is running. */
export const VERSIONS_ACTIVE_POLL_MS = 500;

/**
 * The cadence the dashboard should use for a given harness status.
 *
 * `starting` is the only status where the user is waiting on something that changes
 * second by second - the readiness wait can run for minutes and the elapsed counter
 * must tick - so it is the only one that earns the fast cadence. Every other status
 * still polls, just slowly.
 *
 * @param {string|null|undefined} status a `HarnessStatus.status` value
 * @returns {number} milliseconds
 */
export function harnessPollMs(status) {
  return status === "starting" ? HARNESS_ACTIVE_POLL_MS : HARNESS_IDLE_POLL_MS;
}

/**
 * The cadence the version manager should use for its progress poll.
 *
 * @param {boolean} busy the sidecar's `progress.busy`, which is the authority
 * @returns {number} milliseconds
 */
export function versionsPollMs(busy) {
  return busy === true ? VERSIONS_ACTIVE_POLL_MS : VERSIONS_IDLE_POLL_MS;
}

/**
 * Whether a job observation is a COMPLETION worth re-reading the library for.
 *
 * The sidecar retains the last finished job across polls, so without the `finishedAt`
 * comparison every poll after a completion would look like a fresh one and re-read the
 * library forever. `finishedAt` is the sidecar's own stamp for that job, which is what
 * makes it the right identity: two different jobs cannot share it.
 *
 * @param {{job?: {ok: boolean|null, finishedAt: string|null}|null}|null} progress
 * @param {string|null|undefined} lastSeenFinishedAt the stamp already acted on
 * @returns {{completed: boolean, finishedAt: string|null}}
 */
export function jobCompletion(progress, lastSeenFinishedAt) {
  const job = progress?.job;
  // `ok === null` means "not finished yet"; the sidecar sets it only on an outcome.
  if (!job || job.ok === null || job.ok === undefined) {
    return { completed: false, finishedAt: lastSeenFinishedAt ?? null };
  }

  const finishedAt = job.finishedAt ?? null;
  if (finishedAt !== null && finishedAt === lastSeenFinishedAt) {
    return { completed: false, finishedAt };
  }
  return { completed: true, finishedAt };
}

/**
 * The four download phases, in the order the sidecar reports them.
 *
 * Re-exported rather than restated: `sidecar/lib/harness-install.js` owns the
 * vocabulary and `version-jobs.js` serves it, and a UI that spelled a phase
 * differently would poll for one that never arrives.
 */
export const DOWNLOAD_PHASES = Object.freeze([
  "resolving",
  "downloading",
  "linking",
  "validating",
]);
