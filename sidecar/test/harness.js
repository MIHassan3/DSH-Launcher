/**
 * Pause point 3 - adopt/reap decisions, in isolation.
 *
 * No real harness is installed or started anywhere in this test. The "harness"
 * is a throwaway HTTP server on loopback, and the "process" is a detached Node
 * child whose command line contains the fixture install directory (so the real
 * Windows CIM identity check can match it).
 *
 * Every branch of the section 2.3 table is asserted, plus the two Phase 1
 * requirements:
 *
 *   - the adopt path uses the EXACT token-bearing URL from state, never a
 *     reconstructed base URL or a bare port
 *   - a live pid with an unusable URL is REAPED, not adopted
 *
 * Run from the repo root:  node sidecar/test/harness.js
 * Exits 0 on success, 1 on failure.
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
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "harness");
const NOOP_CHILD = path.join(HERE, "lib", "noop-child.js");

const report = createReport("DSH-Dock harness: adopt or reap (section 2.3)");

// State paths are resolved from this env var; production never sets it.
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.DSH_DOCK_DATA_DIR = DATA_DIR;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const state = await import("../lib/state.js");
const platform = await import("../lib/platform.js");
const harness = await import("../lib/harness.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

/** A fixture install directory, shaped like a real `versions/<v>` tree. */
function makeInstallDir(version) {
  const dir = path.join(PATHS.versions, version);
  const binDir = path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "bin.js"), "// fixture\n", "utf8");
  return dir;
}

/** Writes a state file directly, bypassing validation unless `raw` is a string. */
function writeState(value, { raw = false } = {}) {
  fs.writeFileSync(
    PATHS.runtimeState,
    raw ? value : JSON.stringify(value, null, 2),
    "utf8",
  );
}

/**
 * Builds a valid state object for a live fixture process.
 * `url` must carry a token, matching what the harness really prints.
 */
function stateFor({ pid, port, installDir, version = "9.9.9-fake", url }) {
  return state.buildRuntimeState({
    instanceId: `fixture-${port}`,
    pid,
    port,
    url: url ?? `http://127.0.0.1:${port}/?token=fixture-token`,
    harnessVersion: version,
    installDir,
    startedAt: "2026-09-10T12:00:00.000Z",
  });
}

/** Starts a fake harness HTTP server on loopback, recording every request. */
function startFakeHarness(options = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, host: req.headers.host });
    if (typeof options.delayMs === "number") {
      setTimeout(() => {
        res.writeHead(options.status ?? 200);
        res.end("ok");
      }, options.delayMs);
      return;
    }
    res.writeHead(options.status ?? 200, { "content-type": "text/html" });
    res.end("<html>fake harness</html>");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        url: `http://127.0.0.1:${port}/?token=fixture-token`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Spawns a detached fixture process whose command line names `installDir`. */
async function startFixtureProcess(installDir) {
  // Absolute entry path: Windows shortens stored command lines for relatively
  // invoked node, and the identity check matches on the install directory.
  const entry = path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  fs.writeFileSync(entry, `setInterval(() => {}, 1000);\n`, "utf8");

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  await sleep(600);
  return child.pid;
}

/** Reaps any fixture process that is still alive, so tests do not leak. */
async function reap(pid) {
  if (Number.isInteger(pid) && pid > 0 && platform.isAlive(pid)) {
    await platform.killTree(pid);
  }
}

const spawnedPids = [];
async function fixture({ withServer = true, serverStatus = 200, urlOverride = null, dirName } = {}) {
  const version = dirName ?? `9.9.9-${spawnedPids.length}`;
  const installDir = makeInstallDir(version);
  const pid = await startFixtureProcess(installDir);
  spawnedPids.push(pid);

  const server = withServer ? await startFakeHarness({ status: serverStatus }) : null;

  const value = stateFor({
    pid,
    port: server?.port ?? 65500,
    installDir,
    version,
    url: urlOverride ?? server?.url,
  });
  writeState(value);

  return { pid, installDir, server, state: value, version };
}

// ---------------------------------------------------------------------------

await report.section("probeUrl (no state involved)", async () => {
  const live = await startFakeHarness();
  try {
    const ok = await harness.probeUrl(live.url);
    report.check("a listening server is reachable", ok.reachable === true, JSON.stringify(ok));
    report.check("the HTTP status is reported", ok.status === 200, String(ok.status));

    const notFound = await harness.probeUrl(`http://127.0.0.1:${live.port}/nope`, {});
    report.check(
      "an unusual path still proves the server is up",
      notFound.reachable === true && notFound.status === 200,
      JSON.stringify(notFound),
    );

    const refused = await harness.probeUrl("http://127.0.0.1:1/?token=x");
    report.check("a closed port is unreachable", refused.reachable === false, refused.reason);
    report.check("the reason is `unreachable`, not `error`", refused.reason === "unreachable", refused.reason);

    report.check(
      "an invalid URL is a probe error, not a crash",
      (await harness.probeUrl("not a url")).reason === "error",
    );
    report.check(
      "an https URL is refused (state only admits http)",
      (await harness.probeUrl("https://127.0.0.1:1/")).reason === "error",
    );
  } finally {
    await live.close();
  }

  const auth = await startFakeHarness({ status: 401 });
  try {
    const challenge = await harness.probeUrl(auth.url);
    report.check(
      "a 401 counts as reachable (an auth challenge is still a live server)",
      challenge.reachable === true && challenge.status === 401,
      JSON.stringify(challenge),
    );
  } finally {
    await auth.close();
  }

  const slow = await startFakeHarness({ delayMs: 900 });
  try {
    const timedOut = await harness.probeUrl(slow.url, { timeoutMs: 250 });
    report.check("a stalled server times out and is unreachable", timedOut.reachable === false, timedOut.reason);
  } finally {
    await slow.close();
  }
});

await report.section("no usable state -> start fresh", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  const result = await harness.adoptOrReap({ paths: PATHS });
  report.check("absent state starts fresh", result.decision === "fresh" && result.startFresh === true);
  report.check("the reason names the missing file", result.reasons.join(" ").includes("runtime-state.json"));
  report.check("no state file is created by the decision", !fs.existsSync(PATHS.runtimeState));

  // Corrupt JSON must behave like absent, not crash.
  writeState("{ not json at all", { raw: true });
  const corrupt = await harness.adoptOrReap({ paths: PATHS });
  report.check("corrupt JSON does not throw", corrupt.decision === "fresh", corrupt.decision);
  report.check("corrupt JSON is reported as invalid", corrupt.stateStatus === "invalid", corrupt.stateStatus);
  report.check("corrupt JSON is cleaned up", !fs.existsSync(PATHS.runtimeState));
  report.check(
    "corrupt JSON explains itself",
    corrupt.reasons.join(" ").includes("invalid"),
    corrupt.reasons.join(" | "),
  );

  // A structurally wrong but parseable state must also be treated as invalid.
  writeState(JSON.stringify({ version: 1, pid: "not-a-number", port: 1 }), { raw: true });
  const wrongShape = await harness.adoptOrReap({ paths: PATHS });
  report.check("a structurally wrong state starts fresh", wrongShape.decision === "fresh");
  report.check("it is reported as invalid", wrongShape.stateStatus === "invalid");

  // A tokenless URL is incomplete state. It must be rejected by validation and
  // never adopted. Written with a DEAD pid so the path under test is purely
  // "is this state usable?", with no kill involved.
  const deadForTokenless = spawn(process.execPath, ["--version"], { stdio: "ignore", windowsHide: true });
  const tokenlessPid = deadForTokenless.pid;
  await new Promise((resolve) => deadForTokenless.once("exit", resolve));
  await sleep(200);

  writeState(
    JSON.stringify({
      version: 1,
      recordedAt: "2026-09-10T12:00:00.000Z",
      instanceId: "x",
      pid: tokenlessPid,
      port: 5000,
      url: "http://127.0.0.1:5000/",
      harnessVersion: "9.9.9-fake",
      installDir: makeInstallDir("9.9.9-tokenless"),
      startedAt: "2026-09-10T12:00:00.000Z",
    }),
    { raw: true },
  );
  const tokenless = await harness.adoptOrReap({ paths: PATHS });
  report.check("a tokenless URL is invalid state", tokenless.stateStatus === "invalid", tokenless.stateStatus);
  report.check("a tokenless URL is never adopted", tokenless.decision !== "adopt", tokenless.decision);
  report.check("a tokenless URL starts fresh", tokenless.startFresh === true, String(tokenless.startFresh));
  report.check(
    "the token problem is named",
    tokenless.reasons.join(" ").includes("token"),
    tokenless.reasons.join(" | "),
  );
  report.check("the invalid state file is cleared", !fs.existsSync(PATHS.runtimeState));
});

await report.section("tokenless URL naming OUR LIVE process -> reaped, never adopted", async () => {
  // The dangerous combination: a live process that really IS ours, but whose
  // recorded URL is unusable. Adopting it would hand the UI a URL that cannot
  // work, so Phase 1 reaps and starts fresh (the user's chosen policy).
  const installDir = makeInstallDir("9.9.9-nourl");
  const pid = await startFixtureProcess(installDir);
  spawnedPids.push(pid);

  writeState(
    JSON.stringify({
      version: 1,
      recordedAt: "2026-09-10T12:00:00.000Z",
      instanceId: "nourl-1",
      pid,
      port: 5100,
      url: "http://127.0.0.1:5100/",
      harnessVersion: "9.9.9-nourl",
      installDir,
      startedAt: "2026-09-10T12:00:00.000Z",
    }),
    { raw: true },
  );

  try {
    const result = await harness.adoptOrReap({ paths: PATHS });
    report.check("the state is invalid, so nothing is adopted", result.decision !== "adopt", result.decision);
    report.check("our live process is reaped", result.reapedPid === pid, String(result.reapedPid));
    report.check("the process is gone", platform.isAlive(pid) === false);
    report.check("startFresh is true", result.startFresh === true);
    report.check("the unusable state is cleared", !fs.existsSync(PATHS.runtimeState));
  } finally {
    await reap(pid);
  }
});

await report.section("garbled state must never kill an unrelated process", async () => {
  // Invalid state whose pid happens to be a LIVE process that is NOT ours -
  // here, this test runner itself. The identity guard must refuse the kill.
  writeState(
    JSON.stringify({
      version: 1,
      recordedAt: "2026-09-10T12:00:00.000Z",
      instanceId: "garbled",
      pid: process.pid,
      port: 99999,
      url: "http://127.0.0.1:99999/?token=x",
      harnessVersion: "9.9.9-nope",
      installDir: "Z:\\somewhere\\not\\this\\process",
      startedAt: "2026-09-10T12:00:00.000Z",
    }),
    { raw: true },
  );

  const result = await harness.adoptOrReap({ paths: PATHS });
  report.check("the test runner is still alive", platform.isAlive(process.pid) === true);
  report.check("nothing was adopted", result.decision !== "adopt", result.decision);
  report.check("startFresh is false while the kill is refused", result.startFresh === false, String(result.startFresh));
  report.check(
    "the refusal names the identity reason",
    /refused to kill/.test(result.kill?.note ?? ""),
    result.kill?.note,
  );
  state.clearRuntimeState(PATHS.runtimeState);
});

await report.section("pid dead -> start fresh", async () => {
  const gone = spawn(process.execPath, ["--version"], { stdio: "ignore", windowsHide: true });
  const deadPid = gone.pid;
  await new Promise((resolve) => gone.once("exit", resolve));
  await sleep(200);

  const installDir = makeInstallDir("9.9.9-dead");
  writeState(stateFor({ pid: deadPid, port: 65500, installDir, version: "9.9.9-dead" }));

  const result = await harness.adoptOrReap({ paths: PATHS });
  report.check("a dead pid starts fresh", result.decision === "fresh" && result.startFresh === true);
  report.check("the dead pid is named", result.reasons.join(" ").includes(String(deadPid)));
  report.check("the stale state file is removed", !fs.existsSync(PATHS.runtimeState));
  report.check("the stale state is returned for diagnostics", result.staleState?.pid === deadPid);
});

await report.section("pid alive + url responsive -> ADOPT on the exact URL", async () => {
  const f = await fixture();
  try {
    const result = await harness.adoptOrReap({ paths: PATHS });

    report.check("the decision is adopt", result.decision === "adopt", result.decision);
    report.check("startFresh is false", result.startFresh === false);
    report.check("the recorded state is returned", result.state?.pid === f.pid);
    report.check("the live pid was NOT killed", platform.isAlive(f.pid) === true);
    report.check("the state file was NOT cleared", fs.existsSync(PATHS.runtimeState));

    // THE REQUIREMENT: the probe must hit the exact stored URL, token included.
    const hits = f.server.requests;
    report.check("the fake harness was actually probed", hits.length >= 1, `requests=${hits.length}`);
    report.check(
      "the probe used the token-bearing URL, not the bare base URL",
      hits.some((hit) => hit.url === "/?token=fixture-token"),
      JSON.stringify(hits),
    );
    report.check(
      "the probe did NOT fall back to a bare path",
      !hits.some((hit) => hit.url === "/" || hit.url === ""),
      JSON.stringify(hits),
    );
    report.check(
      "the probe carried the loopback host on the right port",
      hits.every((hit) => hit.host === `127.0.0.1:${f.server.port}`),
      JSON.stringify(hits.map((hit) => hit.host)),
    );
  } finally {
    await f.server?.close();
    await reap(f.pid);
  }
});

await report.section("adopt uses the URL verbatim even when it is unusual", async () => {
  // A distinctive token proves the stored string is used as-is rather than
  // reconstructed from host+port.
  const installDir = makeInstallDir("9.9.9-token");
  const pid = await startFixtureProcess(installDir);
  spawnedPids.push(pid);
  const server = await startFakeHarness();

  const exactUrl = `http://127.0.0.1:${server.port}/?token=AbC-123_xyz&extra=1`;
  writeState(stateFor({ pid, port: server.port, installDir, version: "9.9.9-token", url: exactUrl }));

  try {
    const result = await harness.adoptOrReap({ paths: PATHS });
    report.check("the unusual URL is adopted", result.decision === "adopt", result.decision);
    report.check(
      "the query string reached the server unchanged",
      server.requests.some((hit) => hit.url === "/?token=AbC-123_xyz&extra=1"),
      JSON.stringify(server.requests),
    );
    report.check(
      "the adopted state keeps the full URL",
      result.state?.url === exactUrl,
      result.state?.url,
    );
  } finally {
    await server.close();
    await reap(pid);
  }
});

await report.section("pid alive + url dead -> REAP, then fresh", async () => {
  const f = await fixture({ withServer: false });
  try {
    const result = await harness.adoptOrReap({ paths: PATHS });

    report.check("the decision is reap", result.decision === "reap", result.decision);
    report.check("the victim pid is reported", result.reapedPid === f.pid);
    report.check("the process was actually killed", platform.isAlive(f.pid) === false, `pid=${f.pid}`);
    report.check("startFresh is true after a successful reap", result.startFresh === true);
    report.check("the state file was cleared", !fs.existsSync(PATHS.runtimeState));
    report.check("the probe outcome is attached", result.probe?.reachable === false);
    report.check(
      "the reason says it was alive but unresponsive",
      result.reasons.join(" ").includes("did not answer"),
      result.reasons.join(" | "),
    );
    report.check("the kill mechanism is reported", typeof result.kill?.method === "string", result.kill?.method);
  } finally {
    await reap(f.pid);
  }
});

await report.section("live pid whose url returns 404 -> still reaped-or-adopted sanely", async () => {
  // A 404 on the exact URL means a server answered, so the harness counts as
  // responsive. Documented so nobody "fixes" this into a kill.
  const f = await fixture({ serverStatus: 404 });
  try {
    const result = await harness.adoptOrReap({ paths: PATHS });
    report.check("an answering server is adopted even with a 404", result.decision === "adopt", result.decision);
    report.check("the 404 status is reported", result.probe?.status === 404, String(result.probe?.status));
    report.check("the process was not killed", platform.isAlive(f.pid) === true);
  } finally {
    await f.server?.close();
    await reap(f.pid);
  }
});

await report.section("pid recycled onto a foreign process -> never adopt, never kill", async () => {
  // A live process whose command line does NOT name our install directory.
  const foreignDir = makeInstallDir("9.9.9-foreign");
  const foreignPid = await startFixtureProcess(foreignDir);
  spawnedPids.push(foreignPid);
  const server = await startFakeHarness();

  // State claims a DIFFERENT install dir, as if a PID had been recycled.
  const claimedDir = makeInstallDir("9.9.9-claimed");
  writeState(
    stateFor({
      pid: foreignPid,
      port: server.port,
      installDir: claimedDir,
      version: "9.9.9-claimed",
      url: server.url,
    }),
  );

  try {
    const result = await harness.adoptOrReap({ paths: PATHS });
    if (process.platform === "win32") {
      report.check("a recycled pid is not adopted", result.decision === "fresh", result.decision);
      report.check("the identity verdict is mismatch", result.identity?.status === "mismatch", result.identity?.status);
      report.check("the foreign process was NOT killed", platform.isAlive(foreignPid) === true);
      report.check("the state file was cleared anyway", !fs.existsSync(PATHS.runtimeState));
      report.check(
        "the reason explains the process was left alone",
        result.reasons.join(" ").includes("left alone"),
        result.reasons.join(" | "),
      );
    } else {
      report.check("POSIX identity is unknown, so the URL decides", result.decision === "adopt", result.decision);
    }
  } finally {
    await server.close();
    await reap(foreignPid);
  }
});

await report.section("invalid state naming a live process -> reap it", async () => {
  const installDir = makeInstallDir("9.9.9-invalid");
  const pid = await startFixtureProcess(installDir);
  spawnedPids.push(pid);

  // Parseable, names a real live pid and a matching install dir, but the port
  // is out of range -> invalid state.
  writeState(
    JSON.stringify({
      version: 1,
      recordedAt: "2026-09-10T12:00:00.000Z",
      instanceId: "invalid-1",
      pid,
      port: 99999,
      url: `http://127.0.0.1:99999/?token=x`,
      harnessVersion: "9.9.9-invalid",
      installDir,
      startedAt: "2026-09-10T12:00:00.000Z",
    }),
    { raw: true },
  );

  try {
    const result = await harness.adoptOrReap({ paths: PATHS });
    report.check("invalid state is never adopted", result.decision !== "adopt", result.decision);
    report.check("the recorded pid is reaped", result.reapedPid === pid, String(result.reapedPid));
    report.check("the process was killed", platform.isAlive(pid) === false);
    report.check("the bad state file was cleared", !fs.existsSync(PATHS.runtimeState));
  } finally {
    await reap(pid);
  }
});

await report.section("a reap that fails must not authorise a fresh start", async () => {
  // An unkillable process is simulated through the killTree injection seam:
  // starting a second harness on a port the old one may still hold would be the
  // worst possible outcome, so `startFresh` must be false.
  const f = await fixture({ withServer: false });
  try {
    const failedKill = async () => ({
      ok: false,
      method: "stub",
      waitedMs: 1,
      note: "simulated kill failure",
    });

    const result = await harness.adoptOrReap({ paths: PATHS, killTreeImpl: failedKill });

    report.check("the decision is still reap", result.decision === "reap", result.decision);
    report.check("startFresh is FALSE when the kill failed", result.startFresh === false, String(result.startFresh));
    report.check("the kill failure is reported", /simulated kill failure/.test(result.kill?.note ?? ""), result.kill?.note);
    report.check("the state file is kept (not cleared on a failed reap)", fs.existsSync(PATHS.runtimeState));
    report.check("the process is genuinely still alive", platform.isAlive(f.pid) === true);
    report.check(
      "the reason explains a fresh start is unsafe",
      result.reasons.join(" ").includes("could not be killed"),
      result.reasons.join(" | "),
    );
  } finally {
    await reap(f.pid);
    state.clearRuntimeState(PATHS.runtimeState);
  }
});

await report.section("stopRecordedHarness", async () => {
  const f = await fixture();
  try {
    const result = await harness.stopRecordedHarness({ paths: PATHS });
    report.check("stop reports success", result.stopped === true, JSON.stringify(result.reasons));
    report.check("the process is gone", platform.isAlive(f.pid) === false);
    report.check("the state file is cleared", !fs.existsSync(PATHS.runtimeState));

    const again = await harness.stopRecordedHarness({ paths: PATHS });
    report.check("stopping again is safe and reports nothing to stop", again.stopped === false);
  } finally {
    await f.server?.close();
    await reap(f.pid);
  }
});

await report.section("currentHarness", async () => {
  state.clearRuntimeState(PATHS.runtimeState);
  report.check("no state -> null", harness.currentHarness({ paths: PATHS }) === null);

  writeState("{ broken", { raw: true });
  report.check("corrupt state -> null, not a throw", harness.currentHarness({ paths: PATHS }) === null);

  const installDir = makeInstallDir("9.9.9-current");
  writeState(stateFor({ pid: process.pid, port: 1234, installDir, version: "9.9.9-current" }));
  report.check("valid state -> the object", harness.currentHarness({ paths: PATHS })?.port === 1234);
  state.clearRuntimeState(PATHS.runtimeState);
});

await report.section("recordRunningHarness stores the URL verbatim", () => {
  const installDir = makeInstallDir("9.9.9-record");
  const exact = "http://127.0.0.1:44444/?token=Exact-Token.Value";
  const written = harness.recordRunningHarness(
    {
      instanceId: "rec-1",
      pid: process.pid,
      port: 44444,
      url: exact,
      harnessVersion: "9.9.9-record",
      installDir,
      startedAt: "2026-09-10T12:00:00.000Z",
    },
    { paths: PATHS },
  );
  report.check("the URL is stored exactly as given", written.url === exact, written.url);

  const reread = state.readRuntimeState(PATHS.runtimeState);
  report.check("it round-trips through disk", reread.status === "ok" && reread.state.url === exact);
  report.check(
    "the token survives the round trip",
    reread.state.url.includes("token=Exact-Token.Value"),
    reread.state.url,
  );

  report.check(
    "recording a tokenless URL is refused",
    (() => {
      try {
        harness.recordRunningHarness(
          {
            instanceId: "rec-2",
            pid: process.pid,
            port: 44444,
            url: "http://127.0.0.1:44444/",
            harnessVersion: "9.9.9-record",
            installDir,
            startedAt: "2026-09-10T12:00:00.000Z",
          },
          { paths: PATHS },
        );
        return false;
      } catch {
        return true;
      }
    })(),
  );

  state.clearRuntimeState(PATHS.runtimeState);
});

// Clean up every fixture process this test started.
for (const pid of spawnedPids) {
  await reap(pid);
}

const alive = spawnedPids.filter((pid) => platform.isAlive(pid));
report.check("no fixture processes were leaked", alive.length === 0, `alive=${JSON.stringify(alive)}`);

process.exit(report.finish());
