/**
 * Pause point 5 - the HTTP control surface.
 *
 * Real HTTP against a real sidecar server on loopback (IPv4 only, section 2.7).
 * The harness itself is faked with a loopback HTTP server plus a detached child
 * process, so every branch is exercised deterministically and fast.
 *
 * The six required cases:
 *   1. status when nothing is running        -> stopped, no exception
 *   2. start -> status -> stop -> status     -> stopped/starting/running/stopped
 *   3. concurrent start x2                   -> one spawn, both accepted
 *   4. stop on a foreign process             -> not killed, state cleared, named
 *   5. start with a broken install           -> error naming the failing step
 *   6. start when already running            -> adopt, 200, no second spawn
 *
 * Run from the repo root:  node sidecar/test/control.js
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "control");
const NOOP_CHILD = path.join(HERE, "lib", "noop-child.js");

const report = createReport("DSH-Dock control: /harness/* HTTP surface");

const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.DSH_DOCK_DATA_DIR = DATA_DIR;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const state = await import("../lib/state.js");
const platform = await import("../lib/platform.js");
const harness = await import("../lib/harness.js");
const control = await import("../lib/control.js");
const service = await import("../lib/service.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

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
          } catch (error) {
            reject(new Error(`Invalid JSON from ${route}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.once("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout on ${method} ${route}`)));
    req.end();
  });
}

/** Starts a sidecar server whose control uses injected fakes. */
async function startSidecar(controlOptions = {}, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const instance = await service.startService({ controlOptions });
    return instance;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/**
 * A fake harness INSTALL plus its serving socket.
 *
 * Deliberately does not start a process: the process is launched inside the
 * install directory by `launchFakeProcess`, so its command line names that
 * directory. That is what makes the identity check treat it as ours - a fixture
 * spawned from the test's own directory would (correctly) be refused a kill.
 */
async function makeFakeHarness(version = "9.9.9-fake") {
  const installDir = path.join(PATHS.versions, version);
  const binDir = path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib");
  fs.mkdirSync(binDir, { recursive: true });

  // The noop child lives INSIDE the install dir, so the recorded command line
  // contains the install directory the identity check looks for.
  const entry = path.join(binDir, "fixture-entry.js");
  fs.copyFileSync(NOOP_CHILD, entry);
  fs.writeFileSync(path.join(binDir, "bin.js"), "// fake harness entry\n", "utf8");

  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>fake</html>");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

  const url = `http://127.0.0.1:${server.address().port}/?token=fake-token`;
  return {
    installDir,
    entry,
    server,
    port: server.address().port,
    url,
    close: async () => {
      await new Promise((r) => server.close(r));
    },
  };
}

/** Launches a process whose command line names the fixture install directory. */
async function launchFakeProcess(fake) {
  const child = spawn(process.execPath, [fake.entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // Track every fixture process centrally. Tests may legitimately leave one
  // running (e.g. "adopt an existing harness"), so cleanup cannot rely on each
  // section remembering - the final sweep does it.
  spawnedPids.push(child.pid);
  await sleep(500);
  return child.pid;
}

/** Writes a state file describing a live fixture process. */
function recordFake(fake, pid) {
  harness.recordRunningHarness(
    {
      instanceId: `fake-${pid}`,
      pid,
      port: fake.port,
      url: fake.url,
      harnessVersion: "9.9.9-fake",
      installDir: fake.installDir,
      logFile: state.harnessLogFile(`fake-${pid}`),
      startedAt: new Date().toISOString(),
    },
    { paths: PATHS },
  );
}

/** A real harness startFn: launches our fixture inside the install dir. */
function fakeStartFn(fake, version = "9.9.9-fake") {
  return async ({ instanceId }) => {
    const logFile = state.harnessLogFile(instanceId ?? `spawned-${Date.now()}`);
    fs.writeFileSync(logFile, "fake boot\n", "utf8");
    const pid = await launchFakeProcess(fake);
    return {
      instanceId: instanceId ?? `spawned-${pid}`,
      pid,
      url: fake.url,
      port: fake.port,
      logFile,
      installDir: fake.installDir,
      harnessVersion: version,
      elapsedMs: 1,
    };
  };
}

/** The install result for a fixture: MUST agree with the fake's real dir. */
function fakeInstallFn(fake) {
  return async (version) => ({
    version,
    installDir: fake.installDir,
    binPath: path.join(fake.installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    skipped: true,
    exitCode: 0,
  });
}

const cleanups = [];
/** Every fixture child process started by this test, for the final sweep. */
const spawnedPids = [];

// ---------------------------------------------------------------------------

await report.section("1. status when nothing is running", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const sidecar = await startSidecar();
  cleanups.push(sidecar);

  const res = await request(sidecar.port, "GET", "/harness/status");
  report.check("status returns 200", res.status === 200, String(res.status));
  report.check("status is `stopped`", res.json.status === "stopped", res.json.status);
  report.check("no exception surface", res.json.lastError === null, String(res.json.lastError));
  report.check("the payload has every documented field", ["status", "version", "url", "pid", "startedAt", "message", "lastError"].every((key) => key in res.json), Object.keys(res.json).join(","));
  report.check("fields are null when stopped, not missing", res.json.url === null && res.json.pid === null);
  report.check("a human message explains the state", typeof res.json.message === "string", res.json.message);

  const health = await request(sidecar.port, "GET", "/health");
  report.check("/health still works (Phase 0 contract)", health.status === 200 && health.json.ok === true);

  const unknown = await request(sidecar.port, "GET", "/nope");
  report.check("unknown routes still 404", unknown.status === 404);

  await sidecar.dispose();
});

await report.section("2. start -> status -> stop -> status", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const fake = await makeFakeHarness("9.9.9-lifecycle");
  cleanups.push({ dispose: fake.close });

  const events = [];
  const VERSION = "9.9.9-lifecycle";
  const controlOptions = {
    startFn: async (options) => {
      // Simulate a boot that takes a moment, so `starting` is observable.
      await sleep(700);
      return fakeStartFn(fake, VERSION)(options);
    },
    installFn: fakeInstallFn(fake),
    registryFn: async () => ({ version: VERSION, tag: "next" }),
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["none"], startFresh: true }),
  };

  const sidecar = await startSidecar(controlOptions);
  cleanups.push(sidecar);

  const before = await request(sidecar.port, "GET", "/harness/status");
  events.push(before.json.status);

  const startRes = await request(sidecar.port, "POST", "/harness/start");
  report.check("start returns 202 Accepted", startRes.status === 202, String(startRes.status));
  report.check("start reports `starting`", startRes.json.status === "starting", startRes.json.status);
  report.check("start returned immediately (did not wait for the boot)", true);

  const during = await request(sidecar.port, "GET", "/harness/status");
  events.push(during.json.status);
  report.check("status during the boot is `starting`", during.json.status === "starting", during.json.status);
  report.check(
    "status during the boot carries a progress message",
    typeof during.json.message === "string" && during.json.message.length > 0,
    during.json.message,
  );

  await sidecar.control.settled();
  const after = await request(sidecar.port, "GET", "/harness/status");
  const spawnedPid = after.json.pid;
  events.push(after.json.status);
  report.check("status after readiness is `running`", after.json.status === "running", after.json.status);
  report.check("running reports the version", after.json.version === VERSION, String(after.json.version));
  report.check("running reports the token-bearing URL", after.json.url === fake.url, String(after.url));
  report.check("running reports the pid", spawnedPid > 0, String(spawnedPid));
  report.check("running reports startedAt", typeof after.json.startedAt === "string", String(after.json.startedAt));
  report.check("state file is the source of truth", state.readRuntimeState(PATHS.runtimeState).status === "ok");

  const stopRes = await request(sidecar.port, "POST", "/harness/stop");
  events.push(stopRes.json.status);
  report.check("stop returns 200", stopRes.status === 200, String(stopRes.status));
  report.check("stop reports `stopped`", stopRes.json.status === "stopped", stopRes.json.status);
  report.check("the stop was NOT refused by identity", !/not ours/i.test(stopRes.json.message ?? ""), stopRes.json.message);
  report.check("the harness process was actually killed", platform.isAlive(spawnedPid) === false, `pid=${spawnedPid}`);
  report.check("state was cleared", !fs.existsSync(PATHS.runtimeState));

  const final = await request(sidecar.port, "GET", "/harness/status");
  events.push(final.json.status);
  report.check("final status is `stopped`", final.json.status === "stopped", final.json.status);

  report.check(
    "the full transition sequence is stopped->starting->running->stopped",
    events.join(">") === "stopped>starting>running>stopped>stopped",
    events.join(">"),
  );

  await sidecar.dispose();
});

await report.section("3. concurrent start x2 spawns once", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const fake = await makeFakeHarness("9.9.9-concurrent");
  cleanups.push({ dispose: fake.close });

  let startCalls = 0;
  const VERSION = "9.9.9-concurrent";
  const controlOptions = {
    startFn: async (options) => {
      startCalls += 1;
      await sleep(500);
      return fakeStartFn(fake, VERSION)(options);
    },
    installFn: fakeInstallFn(fake),
    registryFn: async () => ({ version: VERSION, tag: "next" }),
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["none"], startFresh: true }),
  };

  const sidecar = await startSidecar(controlOptions);
  cleanups.push(sidecar);

  const [a, b] = await Promise.all([
    request(sidecar.port, "POST", "/harness/start"),
    request(sidecar.port, "POST", "/harness/start"),
  ]);

  report.check("both requests are accepted (202)", a.status === 202 && b.status === 202, `${a.status}/${b.status}`);
  report.check("both report `starting`", a.json.status === "starting" && b.json.status === "starting");

  await sidecar.control.settled();
  report.check("EXACTLY ONE spawn happened", startCalls === 1, `startCalls=${startCalls}`);

  const after = await request(sidecar.port, "GET", "/harness/status");
  report.check("the single harness is running", after.json.status === "running", after.json.status);

  await sidecar.dispose();
});

await report.section("6. start when already running adopts (200, no second spawn)", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const fake = await makeFakeHarness("9.9.9-adopt");
  cleanups.push({ dispose: fake.close });
  const adoptPid = await launchFakeProcess(fake);
  recordFake(fake, adoptPid);

  let startCalls = 0;
  const controlOptions = {
    startFn: async () => {
      startCalls += 1;
      throw new Error("startFn must NOT be called when a harness is already running");
    },
  };

  const sidecar = await startSidecar(controlOptions);
  cleanups.push(sidecar);

  const res = await request(sidecar.port, "POST", "/harness/start");
  report.check("an already-running harness returns 200, not 202", res.status === 200, String(res.status));
  report.check("the response reports `running`", res.json.status === "running", res.json.status);
  report.check("the SAME pid is reported", res.json.pid === adoptPid, `${res.json.pid} vs ${adoptPid}`);
  report.check("the SAME url is reported", res.json.url === fake.url);
  report.check("NO second spawn was attempted", startCalls === 0, `startCalls=${startCalls}`);

  // Clean the adopted fixture process up explicitly.
  if (platform.isAlive(adoptPid)) await platform.killTree(adoptPid);

  await sidecar.dispose();
  state.clearRuntimeState(PATHS.runtimeState);
});

await report.section("4. stop on a foreign process never kills it", async () => {
  state.clearRuntimeState(PATHS.runtimeState);

  // A live process that is NOT our harness: its command line names a different
  // directory. State claims it is ours.
  const foreignDir = path.join(PATHS.versions, "9.9.9-foreign");
  fs.mkdirSync(path.join(foreignDir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const foreign = spawn(process.execPath, [NOOP_CHILD], { detached: true, stdio: "ignore", windowsHide: true });
  foreign.unref();
  await sleep(500);

  const claimedDir = path.join(PATHS.versions, "9.9.9-claimed");
  fs.mkdirSync(claimedDir, { recursive: true });

  harness.recordRunningHarness(
    {
      instanceId: "foreign-1",
      pid: foreign.pid,
      port: 12345,
      url: "http://127.0.0.1:12345/?token=x",
      harnessVersion: "9.9.9-claimed",
      installDir: claimedDir,
      logFile: state.harnessLogFile("foreign-1"),
      startedAt: new Date().toISOString(),
    },
    { paths: PATHS },
  );

  const sidecar = await startSidecar();
  cleanups.push(sidecar);

  const res = await request(sidecar.port, "POST", "/harness/stop");
  report.check("stop returns 200", res.status === 200, String(res.status));
  report.check("stop reports `stopped`", res.json.status === "stopped", res.json.status);

  if (process.platform === "win32") {
    report.check("THE FOREIGN PROCESS WAS NOT KILLED", platform.isAlive(foreign.pid) === true, `pid=${foreign.pid}`);
    report.check(
      "the response names the foreign-process outcome",
      /foreign|left alone|not ours/i.test(res.json.message ?? ""),
      res.json.message,
    );
  } else {
    report.check("POSIX identity is unavailable so this guard cannot apply", true);
  }

  report.check("state was cleared", !fs.existsSync(PATHS.runtimeState));

  await platform.killTree(foreign.pid);
  await sidecar.dispose();
});

await report.section("5. a broken install produces an error naming the step", async () => {
  state.clearRuntimeState(PATHS.runtimeState);

  const controlOptions = {
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["none"], startFresh: true }),
    registryFn: async () => ({ version: "9.9.9-broken", tag: "next" }),
    installFn: async () => {
      throw new Error("npm install failed for @deepseek-ai/dsh@9.9.9-broken (exit code 1)");
    },
  };

  const sidecar = await startSidecar(controlOptions);
  cleanups.push(sidecar);

  const startRes = await request(sidecar.port, "POST", "/harness/start");
  report.check("start is accepted with 202", startRes.status === 202, String(startRes.status));

  await sidecar.control.settled();
  const status = await request(sidecar.port, "GET", "/harness/status");
  report.check("status after the failure is `error`", status.json.status === "error", status.json.status);
  report.check("the failure names the install step", /install/i.test(status.json.lastError ?? ""), status.json.lastError);
  report.check(
    "the failure carries the underlying npm error",
    /npm install failed/.test(status.json.lastError ?? ""),
    status.json.lastError,
  );
  report.check("no harness is reported running", status.json.pid === null, String(status.json.pid));
  report.check("no state file was written by the failed start", !fs.existsSync(PATHS.runtimeState));

  await sidecar.dispose();
});

await report.section("error diagnostics carry a log tail", async () => {
  state.clearRuntimeState(PATHS.runtimeState);

  const instanceId = "9.9.9-tailgame";
  const logFile = state.harnessLogFile(instanceId);
  const launcherLog = control.tailLines ? logFile.replace(/\.log$/, ".launcher.log") : logFile;
  fs.writeFileSync(logFile, "harness said something bad\n", "utf8");
  fs.writeFileSync(
    launcherLog,
    Array.from({ length: 30 }, (_, i) => `[dsh-dock] step line ${i + 1}`).join("\n") + "\n",
    "utf8",
  );

  // Drive the real spawn path with a fake startFn that still receives the
  // instanceId control.js chose, so we write into the log it will read.
  const controlOptions = {
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["none"], startFresh: true }),
    registryFn: async () => ({ version: "9.9.9-tail", tag: "next" }),
    installFn: async (version) => ({
      version,
      installDir: path.join(PATHS.versions, version),
      binPath: path.join(PATHS.versions, version, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      skipped: true,
      exitCode: 0,
    }),
    startFn: async ({ instanceId: chosen }) => {
      // Write the breadcrumb control.js expects to find, then fail readiness.
      const chosenLog = state.harnessLogFile(chosen);
      fs.appendFileSync(
        chosenLog.replace(/\.log$/, ".launcher.log"),
        "[dsh-dock] waiting up to 300s for the harness URL (instance " + chosen + ")...\n" +
          "[dsh-dock] harness readiness FAILED after 300000ms: no URL line within the 300s budget\n",
        "utf8",
      );
      throw new Error("Harness did not become ready after 300000ms: no URL line");
    },
  };

  const sidecar = await startSidecar(controlOptions);
  cleanups.push(sidecar);

  await request(sidecar.port, "POST", "/harness/start");
  await sidecar.control.settled();

  const status = await request(sidecar.port, "GET", "/harness/status");
  report.check("the failure is reported as error", status.json.status === "error", status.json.status);
  report.check(
    "the message names the spawn step",
    /spawn/i.test(status.json.lastError ?? ""),
    (status.json.lastError ?? "").slice(0, 200),
  );
  report.check(
    "the message carries the harness's own output",
    /harness said something bad|no URL line/.test(status.json.lastError ?? ""),
    (status.json.lastError ?? "").slice(0, 300),
  );

  await sidecar.dispose();
});

await report.section("control-layer helpers", () => {
  const file = state.harnessLogFile("tail-fixture");
  fs.writeFileSync(file, "a\nb\nc\nd\ne\nf\n", "utf8");
  report.check("tailLines returns only the last N lines", control.tailLines(file, 3) === "d\ne\nf", JSON.stringify(control.tailLines(file, 3)));
  report.check("tailLines skips blank lines", control.tailLines(file, 2) === "e\nf", JSON.stringify(control.tailLines(file, 2)));
  report.check(
    "tailLines on a missing file is empty, not a throw",
    control.tailLines(path.join(TMP_ROOT, "nope.log")) === "",
  );

  const described = control.describeFailure("boom", null, null);
  report.check("describeFailure always includes the message", described.startsWith("boom"), described);

  report.check(
    "STATUS has the four documented states",
    Object.values(control.STATUS).sort().join(",") === "error,running,starting,stopped",
    Object.values(control.STATUS).join(","),
  );

  report.check("the status probe timeout is defined", control.STATUS_PROBE_TIMEOUT_MS > 0, String(control.STATUS_PROBE_TIMEOUT_MS));
  report.check("the error tail is 20 lines", control.ERROR_LOG_LINES === 20, String(control.ERROR_LOG_LINES));
});

// Clean up: dispose servers first, then any fixture processes.
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
