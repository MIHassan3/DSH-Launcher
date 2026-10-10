/**
 * Phase 2B: the version SWITCH, its guard order, and its failure states.
 *
 * WHAT THIS SUITE IS FOR. A switch is the one operation in the launcher that can
 * take away something the user already had: it stops their running harness. Every
 * guard here exists because doing it one step later costs them their session, so
 * the assertions are about ORDER as much as about outcomes - which call happened,
 * in which sequence, and what the filesystem and the job looked like at the moment
 * it happened.
 *
 * The harness is faked with a loopback HTTP server plus a detached child process, so
 * every branch is deterministic and fast. Run from the repo root:
 *
 *   node sidecar/test/version-switch.js
 *
 * The suite never installs anything real: `installFn` is injected everywhere except
 * where the point IS the real installer's behavior, and those cases use fake npm.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createReport } from "./lib/check.js";

/**
 * Windows `CREATE_NO_WINDOW` (0x08000000), matching `harness-start.js` and the
 * other suites. The only child this suite spawns is the lock holder below.
 */
const CREATE_NO_WINDOW = 0x0800_0000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "version-switch");
const NOOP_CHILD = path.join(HERE, "lib", "noop-child.js");
const FAKE_NPM = path.join(HERE, "lib", "fake-npm.js");

const report = createReport("DSH-Dock version switch: guard order and failure states");

const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.DSH_DOCK_DATA_DIR = DATA_DIR;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const state = await import("../lib/state.js");
const platform = await import("../lib/platform.js");
const harness = await import("../lib/harness.js");
const control = await import("../lib/control.js");
const service = await import("../lib/service.js");
const library = await import("../lib/library.js");
const validation = await import("../lib/validation.js");
const jobs = await import("../lib/version-jobs.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

const spawnedPids = [];
const cleanups = [];

/** Minimal JSON client. Returns `{ status, json }`. */
function request(port, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch {
            reject(new Error(`Invalid JSON from ${route}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.once("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timeout on ${method} ${route}`)));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete install tree, so `entryState` reports `installed`. */
function makeCompleteTree(version, spec = {}) {
  const installDir = path.join(PATHS.versions, version);
  const scope = path.join(installDir, "node_modules", "@deepseek-ai");
  fs.mkdirSync(scope, { recursive: true });

  if (spec.withDsh !== false) {
    const dshDir = path.join(scope, "dsh");
    fs.mkdirSync(path.join(dshDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dshDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2),
    );
    if (spec.withBin !== false) {
      fs.writeFileSync(path.join(dshDir, "lib", "bin.js"), "// fixture entry point\n");
    }
  }

  if (spec.withWebApp !== false) {
    const webAppDir = path.join(scope, "dsh-web-app");
    fs.mkdirSync(webAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(webAppDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }, null, 2),
    );
  }

  if (spec.incomplete === true) {
    fs.writeFileSync(path.join(installDir, validation.INCOMPLETE_MARKER), "{}\n");
  }

  return installDir;
}

function removeTree(version) {
  fs.rmSync(path.join(PATHS.versions, version), { recursive: true, force: true });
}

/**
 * A fake harness: a serving socket plus a detached child whose command line names
 * the install directory, so the identity check can recognise it.
 */
async function makeFakeHarness(version) {
  const installDir = makeCompleteTree(version);
  const binDir = path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib");
  const entry = path.join(binDir, "fixture-entry.js");
  fs.copyFileSync(NOOP_CHILD, entry);

  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>fake</html>");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

  return {
    version,
    installDir,
    entry,
    server,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/?token=fake-token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function launchFakeProcess(fake) {
  const child = spawn(process.execPath, [fake.entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  spawnedPids.push(child.pid);
  return child.pid;
}

/** A startFn that launches the fixture inside the install dir it is handed. */
function fakeStartFn(fakesByVersion) {
  return async ({ instanceId, harnessVersion, installDir }) => {
    const fake = fakesByVersion[harnessVersion] ?? Object.values(fakesByVersion)[0];
    const logFile = state.harnessLogFile(instanceId);
    fs.writeFileSync(logFile, "fake boot\n", "utf8");
    const pid = launchFakeProcess(fake);
    await sleep(250);
    return {
      instanceId,
      pid,
      url: fake.url,
      port: fake.port,
      logFile,
      installDir: installDir ?? fake.installDir,
      harnessVersion,
      elapsedMs: 1,
    };
  };
}

/** Records a live fixture process as the running harness. */
function recordFake(fake, pid) {
  harness.recordRunningHarness(
    {
      instanceId: `fake-${pid}`,
      pid,
      port: fake.port,
      url: fake.url,
      harnessVersion: fake.version,
      installDir: fake.installDir,
      logFile: state.harnessLogFile(`fake-${pid}`),
      startedAt: new Date().toISOString(),
    },
    { paths: PATHS },
  );
}

/** Builds a control + version manager pair sharing one paths object. */
function buildPair({ controlOptions = {}, versionOptions = {} } = {}) {
  const controller = new control.HarnessControl({ paths: PATHS, ...controlOptions });
  const versions = new jobs.VersionManager({
    paths: PATHS,
    control: controller,
    log: () => {},
    ...versionOptions,
  });
  return { controller, versions };
}

async function startSidecar(pair) {
  const instance = await service.startService({ control: pair.controller, versions: pair.versions });
  cleanups.push({ dispose: () => instance.dispose() });
  return instance;
}

const FRESH_ADOPT = async () => ({
  decision: "fresh",
  stateStatus: "absent",
  reasons: ["fixture"],
  startFresh: true,
});

// ---------------------------------------------------------------------------
// 1. The happy path: switch between two ALREADY INSTALLED versions
// ---------------------------------------------------------------------------

await report.section("1. switching between two installed versions is stop + start, nothing more", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "1.0.0-old";
  const NEW = "1.0.0-new";
  const oldFake = await makeFakeHarness(OLD);
  const newFake = await makeFakeHarness(NEW);
  cleanups.push({ dispose: oldFake.close }, { dispose: newFake.close });

  const calls = [];
  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      startFn: fakeStartFn({ [OLD]: oldFake, [NEW]: newFake }),
      registryFn: async () => {
        calls.push("registry");
        throw new Error("a switch must not consult the registry");
      },
    },
    versionOptions: {
      installFn: async (version) => {
        calls.push(`install:${version}`);
        return { version, installDir: path.join(PATHS.versions, version), skipped: false };
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });

  // Start the OLD version first, so there is something to switch away from.
  await controller.startSpecificVersion(OLD);
  await controller.settled();
  calls.length = 0;

  const before = await request(sidecar.port, "GET", "/harness/status");
  report.check("the old version is running before the switch", before.json.version === OLD, String(before.json.version));
  const oldPid = before.json.pid;
  const oldInstance = before.json.instanceId;

  const res = await request(sidecar.port, "POST", `/versions/switch?version=${NEW}`);
  report.check("the switch is accepted immediately", res.status === 202, String(res.status));
  report.check("the accepted payload reports busy", res.json.busy === true, String(res.json.busy));
  report.check("the accepted payload names the target", res.json.version === NEW, String(res.json.version));
  report.check("the accepted payload names the kind", res.json.kind === "switch", String(res.json.kind));

  await versions.settled();

  report.check("the registry was never consulted", calls.filter((c) => c === "registry").length === 0, calls.join(","));
  report.check("no install happened (the target was already installed)", calls.filter((c) => c.startsWith("install")).length === 0, calls.join(","));

  const after = await request(sidecar.port, "GET", "/harness/status");
  report.check("the new version is running", after.json.version === NEW, String(after.json.version));
  report.check("the status is running", after.json.status === "running", after.json.status);
  report.check("the old process was actually killed", platform.isAlive(oldPid) === false, `pid=${oldPid}`);
  report.check("the new pid is a different process", after.json.pid !== oldPid, `${after.json.pid} vs ${oldPid}`);
  report.check("a NEW instance id was minted", after.json.instanceId !== oldInstance, `${after.json.instanceId} vs ${oldInstance}`);
  report.check("the new URL is the new harness's", after.json.url === newFake.url, String(after.json.url));

  const recorded = state.readRuntimeState(PATHS.runtimeState);
  report.check("runtime-state.json records the new version", recorded.state?.harnessVersion === NEW, String(recorded.state?.harnessVersion));
  report.check("runtime-state.json records the new install dir", recorded.state?.installDir === newFake.installDir, String(recorded.state?.installDir));

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  report.check("the job is no longer busy", progress.json.busy === false, String(progress.json.busy));
  report.check("the retained job reports success", progress.json.job?.ok === true, JSON.stringify(progress.json.job));
  report.check("the retained job names the reason", progress.json.job?.reason === "switched", String(progress.json.job?.reason));
  report.check("the finished job still names its version", progress.json.version === NEW, String(progress.json.version));

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(NEW);
});

// ---------------------------------------------------------------------------
// 2. The rewire's ordering: a PARTIAL target is stopped before it is installed
// ---------------------------------------------------------------------------

await report.section("2. a partial target is STOPPED BEFORE it is installed (the item-8 ordering)", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "2.0.0-old";
  const BROKEN = "2.0.0-broken";
  const oldFake = await makeFakeHarness(OLD);
  // The target's tree is partial: a stale bin.js plus the marker, exactly what a
  // killed in-place install leaves behind, and exactly what the OLD check adopted.
  makeCompleteTree(BROKEN, { incomplete: true });
  cleanups.push({ dispose: oldFake.close });

  let stateAtInstall = null;
  let installCalls = 0;
  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      startFn: fakeStartFn({ [OLD]: oldFake, [BROKEN]: oldFake }),
    },
    versionOptions: {
      installFn: async (version, options) => {
        installCalls += 1;
        // THE ASSERTION THAT MATTERS: what did runtime-state.json say at the moment
        // the install was invoked? If the stop had not happened yet, the running
        // version would still be recorded - and `installVersion`'s running-version
        // guard would refuse the repair that the rewire just decided to make.
        stateAtInstall = state.readRuntimeState(PATHS.runtimeState);
        // Simulate a successful repair of the marked tree.
        fs.rmSync(path.join(PATHS.versions, version, validation.INCOMPLETE_MARKER), { force: true });
        return {
          version,
          installDir: path.join(PATHS.versions, version),
          binPath: path.join(PATHS.versions, version, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
          skipped: false,
          exitCode: 0,
        };
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });

  await controller.startSpecificVersion(OLD);
  await controller.settled();

  report.check(
    "the target really is partial before the switch",
    library.readLibraryEntry(BROKEN, { paths: PATHS }).state === library.LIBRARY_STATE.PARTIAL,
    library.readLibraryEntry(BROKEN, { paths: PATHS }).state,
  );

  const res = await request(sidecar.port, "POST", `/versions/switch?version=${BROKEN}`);
  report.check("the switch is accepted", res.status === 202, String(res.status));

  await versions.settled();

  report.check("the partial target was installed", installCalls === 1, `installCalls=${installCalls}`);
  report.check(
    "STATE WAS ALREADY CLEARED when the install ran - so the running-version guard cannot fire",
    stateAtInstall !== null && stateAtInstall.status === "absent",
    stateAtInstall === null ? "the install never ran" : JSON.stringify(stateAtInstall.status),
  );

  const after = await request(sidecar.port, "GET", "/harness/status");
  report.check("the repaired version is running", after.json.version === BROKEN, String(after.json.version));
  report.check(
    "and it is no longer partial",
    library.readLibraryEntry(BROKEN, { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
    library.readLibraryEntry(BROKEN, { paths: PATHS }).state,
  );

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(BROKEN);
});

// ---------------------------------------------------------------------------
// 3. Failure states
// ---------------------------------------------------------------------------

await report.section("3a. stop succeeds, INSTALL fails: harness stopped, named error, no state file", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "3.0.0-old";
  const TARGET = "3.0.0-nofiles";
  const oldFake = await makeFakeHarness(OLD);
  cleanups.push({ dispose: oldFake.close });

  const { controller, versions } = buildPair({
    controlOptions: { adoptFn: FRESH_ADOPT, startFn: fakeStartFn({ [OLD]: oldFake, [TARGET]: oldFake }) },
    versionOptions: {
      installFn: async () => {
        const error = new Error("npm install failed (exit code 7)");
        error.step = "npm";
        throw error;
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });
  await controller.startSpecificVersion(OLD);
  await controller.settled();
  const oldPid = (await request(sidecar.port, "GET", "/harness/status")).json.pid;

  const res = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
  report.check("the switch is accepted", res.status === 202, String(res.status));
  await versions.settled();

  const status = await request(sidecar.port, "GET", "/harness/status");
  report.check("the harness is STOPPED, not left claiming to run", status.json.status === "stopped", status.json.status);
  report.check("the old process really was stopped", platform.isAlive(oldPid) === false, `pid=${oldPid}`);
  report.check(
    "no runtime-state.json survives",
    fs.existsSync(PATHS.runtimeState) === false,
    "a failed switch must not leave a state file describing anything",
  );

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  report.check("the job reports failure", progress.json.job?.ok === false, JSON.stringify(progress.json.job));
  report.check("the job names the reason", progress.json.job?.reason === "install-failed", String(progress.json.job?.reason));
  report.check(
    "the error says NO harness is running",
    /no harness is running now/i.test(progress.json.job?.error ?? ""),
    (progress.json.job?.error ?? "").slice(0, 300),
  );
  report.check(
    "the error carries npm's own message",
    /exit code 7/.test(progress.json.job?.error ?? ""),
    (progress.json.job?.error ?? "").slice(0, 300),
  );
  report.check(
    "the error names the previous version, so the way back is discoverable",
    progress.json.job?.error?.includes(OLD),
    (progress.json.job?.error ?? "").slice(0, 300),
  );

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(TARGET);
});

await report.section("3b. stop succeeds, START fails: harness stopped, error carries the boot log tail", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "3.1.0-old";
  const TARGET = "3.1.0-wontboot";
  const oldFake = await makeFakeHarness(OLD);
  makeCompleteTree(TARGET);
  cleanups.push({ dispose: oldFake.close });

  const install = await import("../lib/harness-install.js");

  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      startFn: async ({ harnessVersion, instanceId }) => {
        if (harnessVersion === TARGET) {
          // A boot that never announces a URL: this is the real shape of the most
          // common start failure, and `control.js` is expected to turn it into an
          // error naming the step with the log tail attached.
          const logFile = state.harnessLogFile(instanceId);
          fs.writeFileSync(logFile, "boom: the harness died during boot\n", "utf8");
          throw new Error(`Harness did not become ready: no URL line. Log: ${logFile}`);
        }
        return fakeStartFn({ [OLD]: oldFake })({ harnessVersion, instanceId });
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });
  await controller.startSpecificVersion(OLD);
  await controller.settled();

  const res = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
  report.check("the switch is accepted", res.status === 202, String(res.status));
  await versions.settled();

  const status = await request(sidecar.port, "GET", "/harness/status");
  // `error`, not `stopped` - and that is `control.js`'s existing contract, not a 2B
  // choice. A failed start sets `lastError`, and `status()` reports `error` whenever
  // `lastError` is set and nothing is recorded (its "no harness is running" branch).
  // The important properties are that NO state file survives and the error is the
  // boot failure itself.
  report.check("the status is `error`, not a phantom `running`", status.json.status === "error", status.json.status);
  report.check("nothing is recorded as running", status.json.pid === null && status.json.url === null);
  report.check("no state file was written", fs.existsSync(PATHS.runtimeState) === false);
  report.check(
    "the harness's last error names the boot failure",
    /no URL line|did not become ready/i.test(status.json.lastError ?? ""),
    (status.json.lastError ?? "").slice(0, 300),
  );
  report.check("the target IS installed (the install succeeded)", install.isInstalledAndValid(TARGET, { paths: PATHS }) === true);

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  report.check("the job reports failure", progress.json.job?.ok === false, JSON.stringify(progress.json.job));
  report.check("the reason names the start", progress.json.job?.reason === "start-failed", String(progress.json.job?.reason));
  report.check(
    "the error says the harness did not come up",
    /did not come up/i.test(progress.json.job?.error ?? ""),
    (progress.json.job?.error ?? "").slice(0, 300),
  );
  report.check(
    "the error carries the SPAWN step's own text (the log tail path)",
    /no URL line|spawn/i.test(progress.json.job?.error ?? ""),
    (progress.json.job?.error ?? "").slice(0, 400),
  );

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(TARGET);
});

await report.section("3c. an identity mismatch aborts the switch without starting anything", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const TARGET = "3.2.0-target";
  makeCompleteTree(TARGET);

  let startCalls = 0;
  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      stopFn: async () => ({
        stopped: false,
        stateStatus: "ok",
        reasons: ["refused to stop pid 4242: the command line does not name our install directory"],
      }),
      startFn: async () => {
        startCalls += 1;
        throw new Error("must not be reached");
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });
  const res = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
  report.check("the switch is accepted then fails", res.status === 202, String(res.status));
  await versions.settled();

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  report.check("the job reports failure", progress.json.job?.ok === false);
  report.check("the reason is the identity mismatch", progress.json.job?.reason === "identity-mismatch", String(progress.json.job?.reason));
  report.check(
    "the error explains that nothing was started and why",
    /could collide/i.test(progress.json.job?.error ?? ""),
    (progress.json.job?.error ?? "").slice(0, 300),
  );
  report.check("NO start was attempted", startCalls === 0, `startCalls=${startCalls}`);

  await sidecar.dispose();
  removeTree(TARGET);
});

// ---------------------------------------------------------------------------
// 4. The pre-stop guards
// ---------------------------------------------------------------------------

await report.section("4a. a lock held by ANOTHER PROCESS refuses the switch BEFORE anything is stopped", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "4.0.0-old";
  const TARGET = "4.0.0-target";
  const oldFake = await makeFakeHarness(OLD);
  makeCompleteTree(TARGET);
  cleanups.push({ dispose: oldFake.close });

  let stopCalls = 0;
  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      startFn: fakeStartFn({ [OLD]: oldFake, [TARGET]: oldFake }),
      stopFn: async (options) => {
        stopCalls += 1;
        return harness.stopRecordedHarness(options);
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });
  await controller.startSpecificVersion(OLD);
  await controller.settled();
  stopCalls = 0;

  // THE LOCK IS HELD BY A REAL SECOND PROCESS, not by this one.
  //
  // An in-process holder cannot prove this: the switch's own probe would read a file
  // that this process wrote, and the point of the probe is that it sees a claim made
  // by SOMEBODY ELSE. The pattern is `install-flow.js`'s cross-process lock test -
  // a handshake file written atomically (temp + rename), never stdout sniffing,
  // because a `data` event is a chunk and not a record. The child exits when its
  // stdin closes, so it is never killed by image name.
  const handshake = path.join(TMP_ROOT, "switch-lock-handshake.json");
  fs.rmSync(handshake, { force: true });
  const childScript = path.join(TMP_ROOT, "switch-lock-holder.mjs");
  // `pathToFileURL` is REQUIRED: a bare Windows drive-letter specifier is rejected
  // by the ESM loader with ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'c:'").
  const lockModuleUrl = pathToFileURL(path.join(REPO_ROOT, "sidecar", "lib", "library-lock.js")).href;
  fs.writeFileSync(
    childScript,
    `
import fs from "node:fs";
import { acquireLock } from ${JSON.stringify(lockModuleUrl)};

const handshake = ${JSON.stringify(handshake)};
const acquired = acquireLock({ reason: "an install running in another launcher" });
const temp = handshake + ".tmp";
fs.writeFileSync(temp, JSON.stringify({ acquired: acquired.acquired, pid: process.pid, holder: acquired.holder, error: acquired.error }), "utf8");
fs.renameSync(temp, handshake);

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
`,
    "utf8",
  );

  const holder = spawn(process.execPath, [childScript], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
    env: { ...process.env, DSH_DOCK_DATA_DIR: DATA_DIR },
  });
  spawnedPids.push(holder.pid);

  const waitFor = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(50);
    }
    return false;
  };

  let childState = {};
  try {
    const arrived = await waitFor(() => fs.existsSync(handshake));
    report.check("the lock holder process reported back", arrived, arrived ? "ok" : "timed out");
    childState = arrived ? JSON.parse(fs.readFileSync(handshake, "utf8")) : {};
    report.check("the OTHER PROCESS acquired the lock", childState.acquired === true, JSON.stringify(childState));
    report.check("and it is a different process from this one", childState.pid !== process.pid, `${childState.pid} vs ${process.pid}`);

    const lockFile = path.join(PATHS.versions, library.LOCK_FILE_NAME);
    report.check("the lock file records the child's pid", JSON.parse(fs.readFileSync(lockFile, "utf8")).pid === childState.pid);
    report.check("the lock file names the reason, so the refusal can explain itself", /another launcher/.test(fs.readFileSync(lockFile, "utf8")));

    // ---- THE TEST THE ORDERING EXISTS FOR ---------------------------------
    const res = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
    report.check("the switch is REFUSED, not accepted", res.status === 409, String(res.status));
    report.check("the refusal is typed", res.json.error === "library-locked", String(res.json.error));
    report.check(
      "THE HARNESS WAS NEVER STOPPED - the whole point of probing before stopping",
      stopCalls === 0,
      `stopCalls=${stopCalls}`,
    );
    report.check(
      "the running harness is still running, still on the old version",
      (await request(sidecar.port, "GET", "/harness/status")).json.version === OLD,
    );
    report.check(
      "the refusal names the OTHER PROCESS's pid",
      new RegExp(`pid ${childState.pid}\\b`).test(res.json.message ?? ""),
      res.json.message,
    );
    report.check(
      "and says WHY that holder blocks (a live process, so not stale)",
      /live process/.test(res.json.message ?? ""),
      res.json.message,
    );
    report.check("no job was started by the refusal", (await request(sidecar.port, "GET", "/versions/progress")).json.busy === false);
    report.check("no staging directory was created by the refusal", library.scanLibraryRoot({ paths: PATHS }).staging.length === 0);
  } finally {
    // Close the child's stdin so it exits on its own. A kill is the fallback and is
    // targeted at the pid recorded from `spawn` - never an image name.
    try {
      holder.stdin.end();
    } catch {
      /* already gone */
    }
    const exited = await Promise.race([
      new Promise((resolve) => holder.once("exit", () => resolve(true))),
      sleep(8000).then(() => false),
    ]);
    if (!exited) {
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
    }
    report.check("the lock holder process exited", true, exited ? "cleanly" : "after a targeted kill");
  }

  // The child's lock file is now abandoned. A later acquire must take it over, which
  // is also what the switch's probe must conclude - the two must agree (Q84).
  report.check("the abandoned lock is READABLE", JSON.parse(fs.readFileSync(path.join(PATHS.versions, library.LOCK_FILE_NAME), "utf8")).pid === childState.pid);

  const retry = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
  report.check(
    "with the holder gone the switch is accepted (an abandoned lock does not block forever)",
    retry.status === 202,
    `${retry.status} ${JSON.stringify(retry.json).slice(0, 160)}`,
  );
  await versions.settled();
  report.check("and it stopped the harness only then", stopCalls >= 1, `stopCalls=${stopCalls}`);
  report.check(
    "the switch completed",
    (await request(sidecar.port, "GET", "/harness/status")).json.version === TARGET,
  );

  fs.rmSync(childScript, { force: true });
  fs.rmSync(handshake, { force: true });

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(TARGET);
});

await report.section("4a-ii. an UNREADABLE lock does not block a switch (it matches the installer's verdict)", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "4.2.0-old";
  const TARGET = "4.2.0-target";
  const oldFake = await makeFakeHarness(OLD);
  makeCompleteTree(TARGET);
  cleanups.push({ dispose: oldFake.close });

  const { controller, versions } = buildPair({
    controlOptions: { adoptFn: FRESH_ADOPT, startFn: fakeStartFn({ [OLD]: oldFake, [TARGET]: oldFake }) },
  });

  const sidecar = await startSidecar({ controller, versions });
  await controller.startSpecificVersion(OLD);
  await controller.settled();

  // A garbage lock file. `library-lock.js` treats this as STALE ("the lock file is
  // unreadable, so it cannot be a live holder") and `withLock` takes it over, so the
  // switch must NOT be refused - refusing would be stricter than the operation it is
  // guarding, and the user would be told to fix a file that is about to be replaced
  // anyway. The probe borrows the installer's own verdict rather than inventing one.
  const lockFile = path.join(PATHS.versions, library.LOCK_FILE_NAME);
  fs.writeFileSync(lockFile, "not json at all", "utf8");

  const res = await request(sidecar.port, "POST", `/versions/switch?version=${TARGET}`);
  report.check("the switch is accepted despite the garbage lock", res.status === 202, `${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
  await versions.settled();

  const after = await request(sidecar.port, "GET", "/harness/status");
  report.check("and the switch completed", after.json.version === TARGET, String(after.json.version));
  report.check("the garbage lock file is no longer there", fs.existsSync(lockFile) === false);

  await sidecar.dispose();
  removeTree(OLD);
  removeTree(TARGET);
});

await report.section("4b. a second operation is refused while one is in flight", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const FIRST = "4.1.0-first";
  const SECOND = "4.1.0-second";
  makeCompleteTree(FIRST);
  makeCompleteTree(SECOND);

  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const { controller, versions } = buildPair({
    controlOptions: { adoptFn: FRESH_ADOPT, startFn: async () => { throw new Error("no start in this test"); } },
    versionOptions: {
      installFn: async (version) => {
        await gate;
        return { version, installDir: path.join(PATHS.versions, version), skipped: false };
      },
    },
  });

  const sidecar = await startSidecar({ controller, versions });

  const first = await request(sidecar.port, "POST", `/registry/download/${FIRST}`);
  report.check("the first download is accepted", first.status === 202, String(first.status));
  report.check("the first download is busy", first.json.busy === true);

  const second = await request(sidecar.port, "POST", `/registry/download/${SECOND}`);
  report.check("the SECOND is refused with 409", second.status === 409, String(second.status));
  report.check("the refusal is typed", second.json.error === "another-operation-in-flight", String(second.json.error));
  report.check("the refusal names what is running", /download/i.test(second.json.message ?? ""), second.json.message);

  const switchDuring = await request(sidecar.port, "POST", `/versions/switch?version=${SECOND}`);
  report.check("a SWITCH during a download is also refused with 409", switchDuring.status === 409, String(switchDuring.status));

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  report.check("progress still reports the first operation", progress.json.version === FIRST, String(progress.json.version));
  report.check("progress reports the download kind", progress.json.kind === "download", String(progress.json.kind));

  release();
  await versions.settled();

  const after = await request(sidecar.port, "GET", "/versions/progress");
  report.check("after release the job is no longer busy", after.json.busy === false, String(after.json.busy));
  report.check("and the job succeeded", after.json.job?.ok === true, JSON.stringify(after.json.job));

  await sidecar.dispose();
  removeTree(FIRST);
  removeTree(SECOND);
});

// ---------------------------------------------------------------------------
// 5. $DSH_HOME through a switch
// ---------------------------------------------------------------------------

await report.section("5. the harness environment passes through the switch untouched", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const OLD = "5.0.0-old";
  const NEW = "5.0.0-new";
  const oldFake = await makeFakeHarness(OLD);
  const newFake = await makeFakeHarness(NEW);
  cleanups.push({ dispose: oldFake.close }, { dispose: newFake.close });

  // A distinctive value, so the assertion cannot pass by accident.
  const HOME_MARKER = path.join(TMP_ROOT, "fake-dsh-home");
  fs.mkdirSync(HOME_MARKER, { recursive: true });
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = HOME_MARKER;

  try {
    const seenEnvs = [];
    const { controller, versions } = buildPair({
      controlOptions: {
        adoptFn: FRESH_ADOPT,
        // Capture the environment the spawn site would actually use. `startFn`
        // never receives `env` (control.js does not pass one), so this asserts the
        // contract at the seam control.js controls: the process environment reaches
        // the spawn options unchanged.
        startFn: async (options) => {
          seenEnvs.push(options.env ?? process.env);
          return fakeStartFn({ [OLD]: oldFake, [NEW]: newFake })(options);
        },
      },
    });

    const sidecar = await startSidecar({ controller, versions });
    await controller.startSpecificVersion(OLD);
    await controller.settled();

    const res = await request(sidecar.port, "POST", `/versions/switch?version=${NEW}`);
    report.check("the switch is accepted", res.status === 202, String(res.status));
    await versions.settled();

    report.check("two spawns happened (old start + switch start)", seenEnvs.length === 2, `spawns=${seenEnvs.length}`);
    report.check(
      "DSH_HOME is present in the environment of the NEW harness",
      seenEnvs.every((env) => env.DSH_HOME === HOME_MARKER),
      JSON.stringify(seenEnvs.map((env) => env.DSH_HOME)),
    );
    report.check(
      "and its VALUE is unchanged by the switch, byte for byte",
      seenEnvs[1].DSH_HOME === seenEnvs[0].DSH_HOME,
      `${seenEnvs[0].DSH_HOME} -> ${seenEnvs[1].DSH_HOME}`,
    );

    // The harness's spawn options pass the environment through wholesale, which is
    // the actual mechanism by which DSH_HOME reaches the child.
    const harnessStart = await import("../lib/harness-start.js");
    const spawnOptions = harnessStart.buildHarnessSpawnOptions({
      logFd: 1,
      platform: "win32",
      env: { DSH_HOME: HOME_MARKER, PATH: "x" },
    });
    report.check(
      "the spawn site forwards the environment object it is given, unchanged",
      spawnOptions.env.DSH_HOME === HOME_MARKER && Object.keys(spawnOptions.env).length === 2,
      JSON.stringify(spawnOptions.env),
    );
    report.check(
      "the marker directory was not touched by the switch",
      fs.readdirSync(HOME_MARKER).length === 0,
      fs.readdirSync(HOME_MARKER).join(","),
    );

    const after = await request(sidecar.port, "GET", "/harness/status");
    report.check("the switch completed", after.json.version === NEW, String(after.json.version));

    await sidecar.dispose();
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
  }

  removeTree(OLD);
  removeTree(NEW);
});

// ---------------------------------------------------------------------------
// 6. Route validation and the real installer through the switch path
// ---------------------------------------------------------------------------

await report.section("6a. the version gate refuses what could not name a directory", async () => {
  const { controller, versions } = buildPair({ controlOptions: { adoptFn: FRESH_ADOPT } });
  const sidecar = await startSidecar({ controller, versions });

  const cases = [
    { route: "/versions/switch", method: "POST", label: "a switch with no version" },
    { route: "/versions/switch?version=", method: "POST", label: "a switch with an empty version" },
    { route: "/versions/switch?version=next", method: "POST", label: "a switch to a dist-tag" },
    { route: "/versions/switch?version=1.x", method: "POST", label: "a switch to a range" },
    { route: "/registry/download/..%2F..%2Fevil", method: "POST", label: "a download of a traversal" },
    { route: "/registry/download/next", method: "POST", label: "a download of a dist-tag" },
  ];

  for (const item of cases) {
    const res = await request(sidecar.port, item.method, item.route);
    report.check(`${item.label} is refused with 400`, res.status === 400, `${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
    report.check(`${item.label} is typed`, /missing-version|invalid-version/.test(res.json.error ?? ""), String(res.json.error));
  }

  const del = await request(sidecar.port, "POST", "/library/delete");
  report.check("a delete with no version is refused with 400", del.status === 400, String(del.status));

  const delTraversal = await request(sidecar.port, "POST", "/library/delete?version=..%2F..%2Fevil");
  report.check("a delete of a traversal is REFUSED, not silently accepted", delTraversal.status === 409, String(delTraversal.status));
  report.check("the delete refusal is typed", delTraversal.json.reason === "unsafe-version", String(delTraversal.json.reason));

  const unknown = await request(sidecar.port, "GET", "/versions/nope");
  report.check("an unknown version route still 404s", unknown.status === 404, String(unknown.status));
  const harnessStillWorks = await request(sidecar.port, "GET", "/harness/status");
  report.check("and the harness routes still work alongside", harnessStillWorks.status === 200, String(harnessStillWorks.status));

  await sidecar.dispose();
});

await report.section("6b. the REAL installer runs through the switch path, with fake npm", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const TARGET = "6.1.0-realinstaller";
  removeTree(TARGET);

  const install = await import("../lib/harness-install.js");

  const { controller, versions } = buildPair({
    controlOptions: {
      adoptFn: FRESH_ADOPT,
      // The start will fail (there is no real harness here), and that is the honest
      // outcome this section asserts. What it is about is the INSTALL phase reaching
      // the real installer with the real options.
      startFn: async () => {
        throw new Error("no real harness in this test");
      },
    },
    versionOptions: {
      // NOT injected with a stub: the REAL `ensureVersionInstalled` runs, driven by
      // fake npm through the `npmCommand` seam. The wrapper adds ONLY the fake npm;
      // every other option the manager passes - including `onPhase` - flows through
      // untouched, which is what lets this section prove the phase reporting is real.
      installFn: (version, options) =>
        install.ensureVersionInstalled(version, {
          ...options,
          npmCommand: [process.execPath, FAKE_NPM],
          env: {
            FAKE_NPM_MODE: "ok",
            FAKE_NPM_MAKE_BIN: "1",
            FAKE_NPM_MAKE_MANIFEST: "1",
            FAKE_NPM_MAKE_WEB_APP: "1",
          },
        }),
    },
  });

  const sidecar = await startSidecar({ controller, versions });

  const res = await request(sidecar.port, "POST", `/registry/download/${TARGET}`);
  report.check("the download is accepted", res.status === 202, String(res.status));
  report.check("the first phase is `resolving`", res.json.phase === "resolving", String(res.json.phase));
  report.check("the accepted payload is busy", res.json.busy === true, String(res.json.busy));

  // Poll while it runs, the way the UI does, and record every phase seen. Fake npm
  // is fast, so the poll is tight - the point is that phases are OBSERVABLE while
  // the work is in flight, not that every one is guaranteed to be caught.
  const seen = new Set([res.json.phase]);
  const poller = setInterval(async () => {
    try {
      const progress = await request(sidecar.port, "GET", "/versions/progress");
      if (progress.json.phase) seen.add(progress.json.phase);
    } catch {
      /* the server may be closing */
    }
  }, 15);

  await versions.settled();
  clearInterval(poller);

  const phases = [...seen];
  report.check(
    "the tree was installed by the REAL installer",
    install.isInstalledAndValid(TARGET, { paths: PATHS }) === true,
    library.readLibraryEntry(TARGET, { paths: PATHS }).state,
  );
  report.check(
    "every reported phase is one of the four documented ones",
    phases.every((phase) => Object.values(jobs.PHASE).includes(phase)),
    phases.join(","),
  );
  report.check(
    "the `downloading` phase was actually observed during the run",
    phases.includes("downloading"),
    phases.join(","),
  );

  const progress = await request(sidecar.port, "GET", "/versions/progress");
  // A DOWNLOAD ends when the install ends. It does NOT start anything, so the
  // deliberately-broken startFn above is never reached by this route - and a job
  // that reported a start failure here would mean a download was switching.
  report.check(
    "the download job SUCCEEDED (it installed; it does not start)",
    progress.json.job?.ok === true && progress.json.job?.reason === "installed",
    JSON.stringify(progress.json.job),
  );
  report.check(
    "and no harness was started by it",
    fs.existsSync(PATHS.runtimeState) === false,
    "a download must never touch runtime-state.json",
  );
  report.check(
    "the phase is cleared once the job is no longer busy",
    progress.json.phase === null,
    String(progress.json.phase),
  );
  report.check(
    "the finished message names the version and the outcome",
    /Installed 6\.1\.0-realinstaller/.test(progress.json.message ?? ""),
    progress.json.message,
  );

  await sidecar.dispose();
  removeTree(TARGET);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

for (const item of cleanups) {
  try {
    await item.dispose();
  } catch {
    /* best effort */
  }
}

const leaked = [];
for (const pid of spawnedPids) {
  if (platform.isAlive(pid)) {
    leaked.push(pid);
    await platform.killTree(pid);
  }
}
const stillAlive = spawnedPids.filter((pid) => platform.isAlive(pid));
report.check(
  "no fixture processes were leaked",
  stillAlive.length === 0,
  `cleaned=${leaked.length} stillAlive=${JSON.stringify(stillAlive)}`,
);

process.exit(report.finish());
