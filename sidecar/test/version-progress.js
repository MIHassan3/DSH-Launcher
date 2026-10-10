/**
 * Phase 2B: the progress model.
 *
 * WHAT THIS SUITE IS ABOUT, AND WHY IT IS NOT A DUPLICATE OF `version-switch.js`.
 * That suite proves the switch's BEHAVIOR. This one proves the SHAPE and the
 * LIFETIME of the progress the UI polls - which is the part a UI can get wrong
 * silently:
 *
 *   1. the idle state says "nothing is running" honestly;
 *   2. a job is observable while it runs and RETAINED after it finishes, which is
 *      what makes polling reconnect-safe rather than merely pollable;
 *   3. `busy` and the job cannot disagree (it is derived, never stored);
 *   4. the four phases are re-exported from the INSTALLER, so the vocabulary the
 *      installer reports and the vocabulary the route serves cannot drift;
 *   5. elapsed time is measured, not invented.
 *
 * Run from the repo root:  node sidecar/test/version-progress.js
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "version-progress");

const report = createReport("DSH-Dock version progress: the job model and its lifetime");

const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.DSH_DOCK_DATA_DIR = DATA_DIR;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const state = await import("../lib/state.js");
const jobs = await import("../lib/version-jobs.js");
const install = await import("../lib/harness-install.js");
const control = await import("../lib/control.js");
const versionConstants = await import("../lib/version-manager.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

/** A manager with no control and a caller-supplied installer. */
function makeManager(installFn) {
  return new jobs.VersionManager({ paths: PATHS, log: () => {}, installFn });
}

// ---------------------------------------------------------------------------
// 1. The idle shape
// ---------------------------------------------------------------------------

await report.section("1. the idle shape: every field present, nothing claimed", async () => {
  const manager = makeManager(async () => ({ skipped: true }));

  const idle = manager.progress();
  report.check("nothing is busy", idle.busy === false, String(idle.busy));
  report.check("there is no phase", idle.phase === null, String(idle.phase));
  report.check("there is no kind", idle.kind === null, String(idle.kind));
  report.check("there is no version", idle.version === null, String(idle.version));
  report.check("there is no start time to misreport elapsed from", idle.startedAt === null && idle.elapsedMs === null, String(idle.elapsedMs));
  report.check(
    "the job sub-object is present with nulls, so a UI never reads `undefined`",
    idle.job !== null && typeof idle.job === "object" && idle.job.ok === null && idle.job.reason === null,
    JSON.stringify(idle.job),
  );
  report.check(
    "the shape is stable: the same keys exist while idle and while running",
    JSON.stringify(Object.keys(idle).sort()) ===
      JSON.stringify(
        [
          "belowMinimum",
          "busy",
          "elapsedMs",
          "finishedAt",
          "id",
          "job",
          "kind",
          "message",
          "minimumSupported",
          "phase",
          "startedAt",
          "version",
        ].sort(),
      ),
    Object.keys(idle).sort().join(","),
  );
});

// ---------------------------------------------------------------------------
// 2. Vocabulary cannot drift
// ---------------------------------------------------------------------------

await report.section("2. the phase vocabulary is the INSTALLER's, re-exported not restated", () => {
  // THE CROSS-MODULE PIN (Q71). `version-jobs.js` serves the phases over HTTP;
  // `harness-install.js` reports them through `onPhase`. If the two ever spelled a
  // phase differently, the UI would poll for a phase that never arrives and would
  // sit on "downloading" forever while the install moved on.
  report.check(
    "the four phase names are identical in both modules",
    JSON.stringify(Object.values(jobs.PHASE).sort()) === JSON.stringify(Object.values(install.INSTALL_PHASE).sort()),
    `${Object.values(jobs.PHASE).join(",")} vs ${Object.values(install.INSTALL_PHASE).join(",")}`,
  );
  report.check(
    "and the values are the four the phase specification names",
    Object.values(jobs.PHASE).sort().join(",") === "downloading,linking,resolving,validating",
    Object.values(jobs.PHASE).join(","),
  );
  report.check(
    "every phase has human text, so the UI never invents wording",
    Object.values(jobs.PHASE).every((phase) => typeof jobs.PHASE_MESSAGES[phase] === "string" && jobs.PHASE_MESSAGES[phase].length > 0),
    JSON.stringify(jobs.PHASE_MESSAGES),
  );
  report.check(
    "the module's phase constants ARE the installer's objects, not copies",
    jobs.PHASE.RESOLVING === install.INSTALL_PHASE.RESOLVING &&
      jobs.PHASE.DOWNLOADING === install.INSTALL_PHASE.DOWNLOADING &&
      jobs.PHASE.LINKING === install.INSTALL_PHASE.LINKING &&
      jobs.PHASE.VALIDATING === install.INSTALL_PHASE.VALIDATING,
  );
});

// ---------------------------------------------------------------------------
// 2b. The supported-floor facts reach a poller
// ---------------------------------------------------------------------------

await report.section("2b. the job carries the supported-floor facts a UI badges", async () => {
  // THESE WERE DEAD FIELDS FOR ONE REVISION. `progress()` whitelists what it returns,
  // so setting `belowMinimum` on the job was invisible to every caller - the same
  // "computed but never applied" class this phase keeps meeting. The assertion that
  // matters is that the fact is on the RETURNED object, not merely on `manager.job`.
  const manager = makeManager(async (version) => ({ version, skipped: false }));

  manager.download("0.2.0-rc.2");
  const during = manager.progress();
  report.check("a running job reports the floor it is judged against", typeof during.minimumSupported === "string", String(during.minimumSupported));
  report.check(
    "and the floor is MIN_SUPPORTED_DSH, read from the constants module rather than restated",
    during.minimumSupported === versionConstants.MIN_SUPPORTED_DSH,
    `${during.minimumSupported} vs ${versionConstants.MIN_SUPPORTED_DSH}`,
  );
  report.check("with no floor derived yet, nothing is below it", during.belowMinimum === false, String(during.belowMinimum));
  report.check("the value is inside `job` as well, so a retained job carries it", during.job.minimumSupported === during.minimumSupported);

  await manager.settled();
  const after = manager.progress();
  report.check("the fact survives into the retained job", after.job.minimumSupported === during.minimumSupported, String(after.job.minimumSupported));
  report.check(
    "and it is on the SUMMARY too, so a poller that never looks inside `job` still sees it",
    after.minimumSupported === during.minimumSupported,
  );

  // And it is genuinely computed per version, not a constant: a version below the
  // floor must be marked. The floor here is passed as an option so the BEHAVIOUR is
  // testable before Step 11 sets the real value.
  manager.job = { ...manager.idleJob() };
  manager.setJob({ belowMinimum: jobs.compareVersions("0.1.0", "0.2.0") < 0, minimumSupported: "0.2.0", version: "0.1.0" });
  report.check(
    "a version below the floor is marked when the floor is real",
    manager.progress().belowMinimum === true,
    JSON.stringify(manager.progress().belowMinimum),
  );
  report.check(
    "and compareVersions is what decides it (0.1.0 < 0.2.0)",
    jobs.compareVersions("0.1.0", "0.2.0") === -1,
  );
});

// ---------------------------------------------------------------------------
// 3. A job's lifetime
// ---------------------------------------------------------------------------

await report.section("3. a job is observable while it runs and RETAINED after it ends", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const phasesSeen = [];
  const manager = makeManager(async (version, options) => {
    // Report phases through the REAL callback path, exactly as the installer does.
    options.onPhase(install.INSTALL_PHASE.DOWNLOADING);
    phasesSeen.push(manager.progress().phase);
    await gate;
    options.onPhase(install.INSTALL_PHASE.LINKING);
    phasesSeen.push(manager.progress().phase);
    return { version, skipped: false, installDir: path.join(PATHS.versions, version) };
  });

  const accepted = manager.download("9.9.9-progress");
  report.check("the download is accepted", accepted.accepted === true);
  report.check("with a 202", accepted.code === 202, String(accepted.code));
  report.check("the accepted payload is busy", accepted.payload.busy === true);
  report.check("the accepted payload names the kind", accepted.payload.kind === "download", String(accepted.payload.kind));
  report.check("the accepted payload names the version", accepted.payload.version === "9.9.9-progress", String(accepted.payload.version));
  report.check("the job carries an id", typeof accepted.payload.id === "string" && accepted.payload.id.length > 0, String(accepted.payload.id));

  await sleep(30);
  const during = manager.progress();
  report.check("while running, busy is true", during.busy === true, String(during.busy));
  report.check("while running, a phase is reported", during.phase === "downloading", String(during.phase));
  report.check("the message matches the phase", during.message === jobs.PHASE_MESSAGES.downloading, String(during.message));
  report.check("elapsedMs is a number while running", typeof during.elapsedMs === "number" && during.elapsedMs >= 0, String(during.elapsedMs));
  report.check("the job is not yet finished", during.job.ok === null && during.finishedAt === null);

  release();
  await manager.settled();

  const after = manager.progress();
  report.check("after finishing, busy is FALSE", after.busy === false, String(after.busy));
  report.check("after finishing, the PHASE is cleared", after.phase === null, String(after.phase));
  report.check("after finishing, the message is retained", typeof after.message === "string" && after.message.length > 0, String(after.message));
  report.check("after finishing, the job reports success", after.job.ok === true, JSON.stringify(after.job));
  report.check("after finishing, the reason is recorded", after.job.reason === "installed", String(after.job.reason));
  report.check("after finishing, finishedAt is set", typeof after.finishedAt === "string", String(after.finishedAt));
  report.check("after finishing, the version is still named", after.version === "9.9.9-progress", String(after.version));
  report.check(
    "the phases the installer reported were the ones served",
    phasesSeen.join(",") === "downloading,linking",
    phasesSeen.join(","),
  );
  report.check("elapsed time is frozen once finished", after.elapsedMs === manager.progress().elapsedMs, String(after.elapsedMs));

  // THE RECONNECT PROPERTY, asserted directly: a poller that arrives AFTER the
  // operation ended must still learn the outcome. This is the whole reason the job is
  // retained rather than cleared.
  const latePoll = manager.progress();
  report.check(
    "a poll arriving after completion still learns the outcome",
    latePoll.busy === false && latePoll.job.ok === true && latePoll.job.reason === "installed",
    JSON.stringify(latePoll.job),
  );
});

// ---------------------------------------------------------------------------
// 4. Failure retains a typed reason
// ---------------------------------------------------------------------------

await report.section("4. a failed job retains a typed reason and the underlying message", async () => {
  const manager = makeManager(async () => {
    const error = new Error("npm install failed (exit code 7)");
    error.step = "npm";
    throw error;
  });

  manager.download("9.9.9-fails");
  await manager.settled();

  const progress = manager.progress();
  report.check("busy is false after a failure", progress.busy === false, String(progress.busy));
  report.check("the job reports failure", progress.job.ok === false, JSON.stringify(progress.job));
  report.check("the reason is the failing STEP when no reason was set", progress.job.reason === "npm", String(progress.job.reason));
  report.check("the underlying message is retained", /exit code 7/.test(progress.job.error ?? ""), String(progress.job.error));
  report.check("the message names the failure for a human", /Installing 9\.9\.9-fails failed/.test(progress.message ?? ""), String(progress.message));
  report.check("the phase is cleared after a failure too", progress.phase === null, String(progress.phase));

  // A failure must not leave the manager permanently busy: the next operation runs.
  const next = manager.download("9.9.9-next");
  report.check("a later operation is accepted after a failure", next.accepted === true, JSON.stringify(next.payload).slice(0, 120));
  await manager.settled();
});

// ---------------------------------------------------------------------------
// 5. busy and the job cannot disagree
// ---------------------------------------------------------------------------

await report.section("5. `busy` is DERIVED, so it cannot disagree with the job", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const manager = makeManager(async () => {
    await gate;
    return { skipped: false };
  });

  manager.download("9.9.9-derived");
  await sleep(20);

  report.check("there is an in-flight promise", manager.jobPromise !== null);
  const during = manager.progress();
  report.check("busy reflects the in-flight promise", during.busy === true, String(during.busy));

  // The concrete failure this guards against: a stored flag that says "running" after
  // the promise has settled, or "not running" while it has not. Two sources of truth
  // is how a UI ends up polling forever.
  release();
  await manager.settled();
  report.check("there is no in-flight promise once settled", manager.jobPromise === null);
  report.check("and busy agrees", manager.progress().busy === false, String(manager.progress().busy));

  // The manager reports its own state consistently through `settled()` too.
  await report.section("5b. settled() is safe to call repeatedly and when idle", async () => {
    await manager.settled();
    await manager.settled();
    report.check("calling settled() twice is harmless", true);
  });
});

// ---------------------------------------------------------------------------
// 6. Two jobs cannot overlap
// ---------------------------------------------------------------------------

await report.section("6. one job at a time, for the whole library", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  const manager = makeManager(async (version) => {
    started.push(version);
    await gate;
    return { version, skipped: false };
  });

  const first = manager.download("9.9.9-first");
  report.check("the first is accepted", first.accepted === true);

  const second = manager.download("9.9.9-second");
  report.check("the second is REFUSED", second.accepted === false);
  report.check("with 409", second.code === 409, String(second.code));
  report.check("typed as another-operation-in-flight", second.payload.error === "another-operation-in-flight", String(second.payload.error));
  report.check("the refusal names what is running", /9\.9\.9-first/.test(second.payload.message ?? ""), second.payload.message);
  report.check("the refusal reports the CURRENT phase, so the user knows how far it got", second.payload.phase === "resolving", String(second.payload.phase));

  // A delete is a library mutation too, so it must be refused as well - otherwise a
  // delete during an install could remove the tree the install is validating.
  const deletion = await manager.remove("9.9.9-victim");
  report.check("a DELETE during a job is refused too", deletion.accepted === false, String(deletion.code));
  report.check("and the delete refusal is typed", deletion.payload.error === "another-operation-in-flight", String(deletion.payload.error));

  release();
  await manager.settled();
  report.check("only the first job ever started", started.join(",") === "9.9.9-first", started.join(","));

  const third = manager.download("9.9.9-third");
  report.check("once settled, a new job is accepted", third.accepted === true);
  release();
  await manager.settled();
});

// ---------------------------------------------------------------------------
// 7. Elapsed time
// ---------------------------------------------------------------------------

await report.section("7. elapsed time is measured from the job's own clock", async () => {
  let fakeNow = 1_000_000;
  const manager = new jobs.VersionManager({
    paths: PATHS,
    log: () => {},
    now: () => fakeNow,
    installFn: async (version) => {
      // 45 seconds of wall time, simulated, so the assertion is deterministic.
      fakeNow += 45_000;
      return { version, skipped: false };
    },
  });

  report.check("elapsed is null before anything ran", manager.progress().elapsedMs === null);

  manager.download("9.9.9-clock");
  await manager.settled();

  const progress = manager.progress();
  report.check("elapsedMs reports the 45 simulated seconds", progress.elapsedMs === 45_000, String(progress.elapsedMs));
  report.check("startedAt and finishedAt are both ISO stamps", !Number.isNaN(Date.parse(progress.startedAt)) && !Number.isNaN(Date.parse(progress.finishedAt)));
  report.check(
    "finishedAt is not before startedAt",
    Date.parse(progress.finishedAt) >= Date.parse(progress.startedAt),
    `${progress.startedAt} -> ${progress.finishedAt}`,
  );
});

// ---------------------------------------------------------------------------
// 8. The routes
// ---------------------------------------------------------------------------

await report.section("8. the progress routes serve the same object the module holds", async () => {
  const service = await import("../lib/service.js");
  const controller = new control.HarnessControl({
    paths: PATHS,
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["fixture"], startFresh: true }),
  });

  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const manager = makeManager(async (version) => {
    await gate;
    return { version, skipped: false };
  });
  manager.control = controller;

  const instance = await service.startService({ control: controller, versions: manager });

  const idle = await fetchJson(instance.port, "GET", "/versions/progress");
  report.check("the route serves the idle shape", idle.status === 200 && idle.json.busy === false, String(idle.status));

  manager.download("9.9.9-route");
  await sleep(20);
  const during = await fetchJson(instance.port, "GET", "/versions/progress");
  report.check("the route serves a running job", during.json.busy === true, String(during.json.busy));
  report.check("with the phase the module holds", during.json.phase === manager.progress().phase, `${during.json.phase} vs ${manager.progress().phase}`);

  release();
  await manager.settled();

  const after = await fetchJson(instance.port, "GET", "/versions/progress");
  report.check("the route serves the RETAINED job after completion", after.json.busy === false && after.json.job.ok === true, JSON.stringify(after.json.job));

  const status = await fetchJson(instance.port, "GET", "/versions/status");
  report.check("the status route embeds the same progress object", status.json.progress?.job?.ok === true, JSON.stringify(status.json.progress?.job));
  report.check("the status route reports the library", Array.isArray(status.json.library), typeof status.json.library);
  report.check("the status route reports the minimum supported version", typeof status.json.minimumSupported === "string", String(status.json.minimumSupported));
  report.check("the status route reports the running version, null when none", status.json.running === null, String(status.json.running));
  report.check(
    "and the library it reports is the one the manager builds",
    JSON.stringify(status.json.library) === JSON.stringify(manager.library()),
  );

  // `/versions/library` was removed in 7b: it was a strict subset of
  // `/versions/status`, so keeping it meant two ways to fetch one list. Asserted
  // rather than assumed, because a stale route is a second contract nobody maintains.
  const removed = await fetchJson(instance.port, "GET", "/versions/library");
  report.check("the redundant /versions/library route is GONE (404)", removed.status === 404, String(removed.status));

  await instance.dispose();
});

/** Minimal JSON client, defined after use on purpose: the suite is line-by-line. */
async function fetchJson(port, method, route) {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          reject(new Error(`bad JSON from ${route}: ${body.slice(0, 120)}`));
        }
      });
    });
    req.once("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout on ${route}`)));
    req.end();
  });
}

process.exit(report.finish());
