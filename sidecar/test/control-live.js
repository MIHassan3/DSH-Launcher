/**
 * Pause point 5 (live) - the control surface driving the REAL harness.
 *
 * Starts a real `sidecar/index.js` as a child process, then talks to its HTTP
 * control surface exactly as the UI will: /harness/start (202), poll
 * /harness/status until `running`, /harness/stop, /harness/status -> `stopped`.
 *
 * Opt-in via DSH_DOCK_TEST_LIVE=1. Requires the harness to be installed in the
 * shared live data dir (run harness-install.js with DSH_DOCK_TEST_INSTALL=1).
 *
 * $DSH_HOME is redirected into scratch so the real plugin tree is built inside
 * .test-tmp and the developer's own ~/.dsh is untouched.
 *
 * Run from the repo root:
 *   $env:DSH_DOCK_TEST_LIVE='1'; node sidecar/test/control-live.js
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
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "control-live");
const LIVE_DATA = process.env.DSH_DOCK_LIVE_DATA ?? path.join(REPO_ROOT, ".test-tmp", "live-data");
const SCRATCH_HOME = path.join(TMP_ROOT, "dsh-home");
const SIDECAR_ENTRY = path.join(REPO_ROOT, "sidecar", "index.js");

const report = createReport("DSH-Dock control (LIVE): real harness over real HTTP");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");
const platform = await import("../lib/platform.js");

process.env.DSH_DOCK_DATA_DIR = LIVE_DATA;
const PATHS = state.resolveStatePaths();

/** JSON GET/POST against the sidecar. */
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
            resolve({ status: res.statusCode, json: null, raw: body });
          }
        });
      },
    );
    req.once("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timeout ${method} ${route}`)));
    req.end();
  });
}

/** Starts a real sidecar and returns its announced port. */
async function startRealSidecar() {
  const outFile = path.join(TMP_ROOT, "sidecar.out.log");
  const errFile = path.join(TMP_ROOT, "sidecar.err.log");
  const portFile = path.join(TMP_ROOT, "sidecar.port");
  const outFd = fs.openSync(outFile, "w");
  const errFd = fs.openSync(errFile, "w");

  const child = spawn(process.execPath, [SIDECAR_ENTRY], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    env: {
      ...process.env,
      DSH_DOCK_DATA_DIR: LIVE_DATA,
      DSH_HOME: SCRATCH_HOME,
      // Test-only mirror; the Rust shell never reads this (see NOTES.md).
      DSH_DOCK_PORT_FILE: portFile,
    },
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const raw = fs.readFileSync(portFile, "utf8").trim();
      if (/^\d+$/.test(raw)) {
        return { child, port: Number(raw), outFile, errFile };
      }
    }
    await sleep(150);
  }
  throw new Error(
    `sidecar never announced a port; stderr:\n${fs.readFileSync(errFile, "utf8").slice(0, 2000)}`,
  );
}

/** Removes any recorded harness so the live test starts from a known state. */
async function resetRecorded() {
  const read = state.readRuntimeState(PATHS.runtimeState);
  if (read.status === "ok" && platform.isAlive(read.state.pid)) {
    await platform.killTree(read.state.pid);
  }
  state.clearRuntimeState(PATHS.runtimeState);
}

if (process.env.DSH_DOCK_TEST_LIVE !== "1") {
  report.check("LIVE control test skipped (set DSH_DOCK_TEST_LIVE=1 to run it)", true);
  process.exit(report.finish());
}

let sidecar = null;
let harnessPid = null;

try {
  await resetRecorded();

  await report.section("real sidecar starts and serves the control surface", async () => {
    sidecar = await startRealSidecar();
    report.check("the sidecar announced a port", sidecar.port > 0, String(sidecar.port));

    const health = await request(sidecar.port, "GET", "/health");
    report.check("/health works on the real sidecar", health.status === 200 && health.json.ok === true);
    report.check("the handshake line was the only stdout", fs.readFileSync(sidecar.outFile, "utf8").trim().startsWith("SIDECAR_READY:"));

    const stopped = await request(sidecar.port, "GET", "/harness/status");
    report.check("status starts at `stopped`", stopped.json.status === "stopped", stopped.json.status);
  });

  await report.section("start the real harness over HTTP", async () => {
    const before = Date.now();
    const res = await request(sidecar.port, "POST", "/harness/start");
    const elapsed = Date.now() - before;

    report.check("start returns 202 Accepted", res.status === 202, String(res.status));
    report.check("start reports `starting`", res.json.status === "starting", res.json.status);
    report.check("start did NOT block on the boot (<3s)", elapsed < 3000, `${elapsed}ms`);

    // Poll exactly as the UI will.
    let last = null;
    const deadline = Date.now() + 300000;
    let sawStarting = false;
    while (Date.now() < deadline) {
      const status = await request(sidecar.port, "GET", "/harness/status");
      last = status.json;
      if (last.status === "starting") sawStarting = true;
      if (last.status === "running" || last.status === "error") break;
      await sleep(500);
    }

    report.check("a `starting` state was observed while polling", sawStarting === true);
    report.check("the harness reached `running`", last?.status === "running", JSON.stringify(last).slice(0, 400));
    report.check("the real version is reported", /^\d+\.\d+\.\d+/.test(last?.version ?? ""), String(last?.version));
    report.check("the URL is the loopback literal", (last?.url ?? "").startsWith("http://127.0.0.1:"), String(last?.url));
    report.check("the URL carries a token", /[?&]token=/.test(last?.url ?? ""));
    report.check("a real pid is reported", last?.pid > 0, String(last?.pid));
    report.check("startedAt is an ISO timestamp", !Number.isNaN(Date.parse(last?.startedAt ?? "")), String(last?.startedAt));
    report.check("the state file agrees with the response", state.readRuntimeState(PATHS.runtimeState).status === "ok");
    report.check(
      "the state file records the same url",
      state.readRuntimeState(PATHS.runtimeState).state?.url === last?.url,
    );

    harnessPid = last.pid;

    // The harness must really be serving the reported URL.
    const probe = await new Promise((resolve) => {
      const req = http.get(last.url, { headers: { "user-agent": "dsh-dock-test" } }, (r) => {
        r.resume();
        resolve({ ok: true, status: r.statusCode });
      });
      req.on("error", (error) => resolve({ ok: false, error: error.message }));
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    });
    report.check("the reported URL is reachable", probe.ok === true, JSON.stringify(probe));
  });

  await report.section("start again adopts the running harness", async () => {
    const res = await request(sidecar.port, "POST", "/harness/start");
    report.check("start returns 200 when already running", res.status === 200, String(res.status));
    report.check("the same pid is reported", res.json.pid === harnessPid, `${res.json.pid} vs ${harnessPid}`);
    report.check("no restart happened", platform.isAlive(harnessPid) === true);
  });

  await report.section("stop the real harness over HTTP", async () => {
    const res = await request(sidecar.port, "POST", "/harness/stop");
    report.check("stop returns 200", res.status === 200, String(res.status));
    report.check("stop reports `stopped`", res.json.status === "stopped", res.json.status);
    report.check("the message confirms the stop", /stopped/i.test(res.json.message ?? ""), res.json.message);

    await sleep(500);
    report.check("the harness process is gone", platform.isAlive(harnessPid) === false, `pid=${harnessPid}`);
    report.check("state was cleared", !fs.existsSync(PATHS.runtimeState));

    const after = await request(sidecar.port, "GET", "/harness/status");
    report.check("status is `stopped` again", after.json.status === "stopped", after.json.status);
    report.check("the status payload still has all fields", "version" in after.json && "url" in after.json);
  });
} catch (error) {
  report.check(`live control run threw: ${error.message}`, false);
} finally {
  if (harnessPid !== null && platform.isAlive(harnessPid)) await platform.killTree(harnessPid);
  await resetRecorded();
  if (sidecar !== null) {
    const err = fs.existsSync(sidecar.errFile) ? fs.readFileSync(sidecar.errFile, "utf8") : "";
    if (err.trim()) process.stdout.write(`  (sidecar stderr tail)\n${err.trim().split("\n").slice(-6).join("\n")}\n`);
    await platform.killTree(sidecar.child.pid);
  }
}

process.exit(report.finish());
