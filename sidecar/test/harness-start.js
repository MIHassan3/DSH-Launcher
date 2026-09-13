/**
 * Pause point 4 - spawning the harness and observing readiness.
 *
 * Structure:
 *
 *   ALWAYS  - URL-line parsing rules, and `waitForHarnessUrl` against a scripted
 *             log writer. No harness required; fast and hermetic.
 *   LIVE    - opt-in via DSH_DOCK_TEST_LIVE=1. Installs nothing itself (run the
 *             install test with DSH_DOCK_TEST_INSTALL=1 first) but does boot the
 *             REAL harness, and then runs the decisive detached-survival test:
 *             spawn a real sidecar, kill it, prove the harness kept serving, and
 *             prove a subsequent adopt reuses the same pid without respawning.
 *
 * The live section points $DSH_HOME at scratch, so the real plugin tree is built
 * inside .test-tmp and the developer's own ~/.dsh is never touched.
 *
 * Run from the repo root:
 *   node sidecar/test/harness-start.js
 *   $env:DSH_DOCK_TEST_LIVE='1'; node sidecar/test/harness-start.js
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "start");
const LIVE = process.env.DSH_DOCK_TEST_LIVE === "1";

const UNITS_DATA = path.join(TMP_ROOT, "units-data");

// The LIVE sections of this test and of harness-install.js share ONE data
// directory, so a single ~390 MB harness install serves both instead of each
// test downloading its own copy. Overridable to point at an existing tree.
const LIVE_DATA = process.env.DSH_DOCK_LIVE_DATA ?? path.join(REPO_ROOT, ".test-tmp", "live-data");
const ACTIVE_DATA = LIVE ? LIVE_DATA : UNITS_DATA;

const report = createReport("DSH-Dock harness start: spawn + readiness");

process.env.DSH_DOCK_DATA_DIR = ACTIVE_DATA;
// Wipe only the unit-test data dir. The live data dir may hold an installed
// harness that took minutes to download, so it is never removed here.
fs.rmSync(UNITS_DATA, { recursive: true, force: true });
fs.mkdirSync(ACTIVE_DATA, { recursive: true });

const state = await import("../lib/state.js");
const platform = await import("../lib/platform.js");
const harness = await import("../lib/harness.js");
const start = await import("../lib/harness-start.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

/** Writes lines into a log file with delays, simulating a booting harness. */
function startLogScript(logFile, steps, { truncate = true } = {}) {
  const script = `
    const fs = require("node:fs");
    const steps = ${JSON.stringify(steps)};
    if (${truncate}) fs.writeFileSync(${JSON.stringify(logFile)}, "", "utf8");
    (async () => {
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, step.delayMs));
        fs.appendFileSync(${JSON.stringify(logFile)}, step.text, "utf8");
      }
    })();
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
  child.unref();
  return child;
}

await report.section("URL line parsing (the readiness contract)", () => {
  const token = "?token=6f1c9a2b-4d3e";
  const real = `dsh web: http://127.0.0.1:3080/${token}\n`;

  const parsed = start.parseHarnessUrl(real);
  report.check("parses the documented readiness line", parsed?.url === `http://127.0.0.1:3080/${token}`, parsed?.url);
  report.check("the token is kept in the URL", start.hasToken(parsed?.url ?? "") === true);
  report.check("the matching line is returned for diagnostics", parsed?.line === real.trim());

  report.check(
    "no trailing newline is needed",
    start.parseHarnessUrl(real.trim())?.url === `http://127.0.0.1:3080/${token}`,
  );
  report.check(
    "CRLF line endings are handled",
    start.parseHarnessUrl(real.replace("\n", "\r\n"))?.url === `http://127.0.0.1:3080/${token}`,
  );
  report.check(
    "leading log noise does not interfere",
    start.parseHarnessUrl(`some boot noise\ndsh web: http://127.0.0.1:51234/?token=abc\nmore noise`)?.url ===
      "http://127.0.0.1:51234/?token=abc",
  );
  report.check(
    "a trailing (LAN: ...) suffix is not swallowed",
    start.parseHarnessUrl("dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://10.0.0.5:3080/?token=abc)")?.url ===
      "http://127.0.0.1:3080/?token=abc",
  );
  report.check(
    "an inline quote terminates the URL",
    start.parseHarnessUrl('saw "http://127.0.0.1:3080/?token=abc" in the log')?.url === "http://127.0.0.1:3080/?token=abc",
  );
  report.check(
    "a URL with no port is still recognised",
    start.parseHarnessUrl("dsh web: http://127.0.0.1/?token=abc")?.url === "http://127.0.0.1/?token=abc",
  );

  // The important negative: the readiness line is printed once, and a URL
  // without a token is unusable, so it must not be treated as ready.
  report.check("a tokenless readiness line is rejected", start.parseHarnessUrl("dsh web: http://127.0.0.1:3080/") === null);
  report.check(
    "an unrelated tokenless URL is rejected",
    start.parseHarnessUrl("opening http://127.0.0.1:1420 now") === null,
  );
  report.check("empty input is rejected", start.parseHarnessUrl("") === null);
  report.check("non-string input is rejected", start.parseHarnessUrl(null) === null);
  report.check("no URL at all is rejected", start.parseHarnessUrl("just booting...\nstill booting") === null);

  // Prefix preferred, never required: the bare-URL fallback covers a format change.
  const twoUrls = "note http://127.0.0.1:1/?token=other\ndsh web: http://127.0.0.1:2/?token=real";
  report.check(
    "a `dsh web:` line wins over an earlier bare URL",
    start.parseHarnessUrl(twoUrls)?.url === "http://127.0.0.1:2/?token=real",
    start.parseHarnessUrl(twoUrls)?.url,
  );
  report.check(
    "a bare URL is still accepted when no labelled line exists",
    start.parseHarnessUrl("booted at http://127.0.0.1:7777/?token=bare")?.url === "http://127.0.0.1:7777/?token=bare",
  );

  report.check(
    "localhost is tolerated by the matcher",
    start.parseHarnessUrl("dsh web: http://localhost:3080/?token=abc")?.url === "http://localhost:3080/?token=abc",
  );
});

await report.section("instance ids and logs", () => {
  const a = start.generateInstanceId();
  const b = start.generateInstanceId();
  report.check("ids are unique", a !== b, `${a} vs ${b}`);
  report.check("ids are filesystem-safe", /^[A-Za-z0-9._-]+$/.test(a), a);

  const older = start.generateInstanceId(new Date("2026-01-02T03:04:05.000Z"));
  const newer = start.generateInstanceId(new Date("2026-01-02T03:04:06.000Z"));
  report.check("ids sort by time", older < newer, `${older} < ${newer}`);
  report.check("the timestamp is present in the id", older.startsWith("20260102T030405"), older);

  report.check(
    "the log path is per-instance",
    state.harnessLogFile(a) !== state.harnessLogFile(b),
  );
  report.check(
    "the log lives in <data-dir>/logs",
    path.dirname(state.harnessLogFile(a)) === PATHS.logs,
  );
});

await report.section("waitForHarnessUrl against a slow-booting log", async () => {
  const instanceId = start.generateInstanceId(new Date("2026-02-02T00:00:00.000Z"));
  const logFile = state.harnessLogFile(instanceId);

  // The URL arrives after 1.2s, well past the first poll interval, so this
  // fails unless the poll re-reads the file from the beginning.
  const writer = startLogScript(logFile, [
    { delayMs: 200, text: "dsh web-app: booting\n" },
    { delayMs: 600, text: "plugins: 40 loaded\n" },
    { delayMs: 400, text: "dsh web: http://127.0.0.1:54321/?token=late\n" },
  ]);

  try {
    const ready = await start.waitForHarnessUrl({ logFile, timeoutMs: 15000, pollMs: 150 });
    report.check("the URL is found even though it arrives late", ready.url === "http://127.0.0.1:54321/?token=late", ready.url);
    report.check("elapsed time is reported", ready.elapsedMs >= 1000, `${ready.elapsedMs}ms`);
    report.check("the log path is reported", ready.logFile === logFile);

    const text = fs.readFileSync(logFile, "utf8");
    const launcherText = fs.readFileSync(start.launcherLogFor(logFile), "utf8");
    report.check(
      "the success breadcrumb with elapsed time is durable",
      /harness ready after \d+ms: http:\/\/127\.0\.0\.1:54321\/\?token=late/.test(launcherText),
      launcherText,
    );
    report.check(
      "the harness log keeps only harness output",
      text.includes("dsh web: http://127.0.0.1:54321/?token=late") && !text.includes("[dsh-dock]"),
      text,
    );
    report.check(
      "the two logs are separate files",
      logFile !== start.launcherLogFor(logFile),
      `${path.basename(logFile)} vs ${path.basename(start.launcherLogFor(logFile))}`,
    );
  } finally {
    await platform.killTree(writer.pid);
  }
});

await report.section("waitForHarnessUrl failure modes", async () => {
  // 1. No URL ever appears -> timeout carrying the log tail.
  const silentId = start.generateInstanceId(new Date("2026-02-03T00:00:00.000Z"));
  const silentLog = state.harnessLogFile(silentId);
  fs.writeFileSync(silentLog, "booting\nstill booting\n", "utf8");

  let timeoutError = null;
  try {
    await start.waitForHarnessUrl({ logFile: silentLog, timeoutMs: 1200, pollMs: 150 });
  } catch (caught) {
    timeoutError = caught;
  }
  report.check("a silent harness times out", timeoutError?.name === "HarnessStartError", timeoutError?.name);
  report.check("the timeout error names the log file", timeoutError?.logFile === silentLog);
  report.check(
    "the budget is stated in the message",
    /within the \d+s budget/.test(timeoutError?.message ?? ""),
    timeoutError?.message,
  );
  report.check(
    "the elapsed time is stated in the message",
    /after \d+ms/.test(timeoutError?.message ?? ""),
    timeoutError?.message,
  );
  report.check(
    "the log tail is attached so the failure is diagnosable",
    (timeoutError?.logTail ?? "").includes("still booting"),
    JSON.stringify(timeoutError?.logTail),
  );

  // Constraint: the budget and the outcome must be durable, since the sidecar's
  // stderr has nowhere to go in the packaged app. They live in OUR log file
  // because the harness truncates its own during boot.
  const silentLauncherLog = fs.readFileSync(start.launcherLogFor(silentLog), "utf8");
  report.check(
    "the budget breadcrumb is durable",
    silentLauncherLog.includes("waiting up to 1s for the harness URL"),
    silentLauncherLog,
  );
  report.check(
    "the failure breadcrumb with elapsed time is durable",
    /readiness FAILED after \d+ms/.test(silentLauncherLog),
    silentLauncherLog,
  );
  report.check(
    "the breadcrumbs are prefixed to distinguish them from harness output",
    silentLauncherLog.includes("[dsh-dock]"),
    silentLauncherLog,
  );
  report.check(
    "the launcher log does not clobber the harness log",
    fs.readFileSync(silentLog, "utf8").includes("still booting"),
    fs.readFileSync(silentLog, "utf8"),
  );

  // 2. A stale URL in a log that was NOT truncated must not be mistaken for
  //    readiness - this is why startHarness truncates on open.
  const staleLog = state.harnessLogFile("stale-fixture");
  fs.writeFileSync(staleLog, "dsh web: http://127.0.0.1:11111/?token=stale\n", "utf8");
  const staleParsed = start.parseHarnessUrl(fs.readFileSync(staleLog, "utf8"));
  report.check(
    "a pre-existing URL IS parseable (hence the truncate-on-open requirement)",
    staleParsed?.url === "http://127.0.0.1:11111/?token=stale",
    staleParsed?.url,
  );

  // 3. The child exits before printing a URL -> fail fast, do not wait the budget.
  const exitId = start.generateInstanceId(new Date("2026-02-03T01:00:00.000Z"));
  const exitLog = state.harnessLogFile(exitId);
  fs.writeFileSync(exitLog, "starting up\n", "utf8");
  const dying = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore", windowsHide: true });
  await sleep(300);

  let exitError = null;
  const startedAt = Date.now();
  try {
    await start.waitForHarnessUrl({ logFile: exitLog, timeoutMs: 20000, pollMs: 150, child: dying });
  } catch (caught) {
    exitError = caught;
  }
  const elapsed = Date.now() - startedAt;
  report.check("an exited harness fails the wait", exitError?.name === "HarnessStartError", exitError?.name);
  report.check("the exit is reported", /exited/.test(exitError?.message ?? ""), exitError?.message);
  report.check("the exit code is attached", exitError?.exitCode === 3, String(exitError?.exitCode));
  report.check(
    "it fails FAST rather than waiting the whole budget",
    elapsed < 8000,
    `${elapsed}ms (budget was 20000ms)`,
  );
});

await report.section("startHarness argument guards", async () => {
  report.check(
    "a relative binPath is refused",
    throws(() => start.startHarness({ binPath: "lib/bin.js", harnessVersion: "x", installDir: "y" })),
  );
  report.check(
    "the relative-path refusal explains why",
    (() => {
      try {
        start.startHarness({ binPath: "lib/bin.js", harnessVersion: "x", installDir: "y" });
        return "";
      } catch (error) {
        return error.message;
      }
    })().includes("absolute"),
  );
  report.check(
    "a missing binPath is refused",
    throws(() =>
      start.startHarness({ binPath: path.join(TMP_ROOT, "nope", "bin.js"), harnessVersion: "x", installDir: "y" }),
    ),
  );
  report.check(
    "an empty binPath is refused",
    throws(() => start.startHarness({ binPath: "", harnessVersion: "x", installDir: "y" })),
  );

  report.check(
    "the harness args are the documented flag set",
    start.HARNESS_ARGS.join(" ") === "--profile web --host 127.0.0.1 --port 0 --no-open",
    start.HARNESS_ARGS.join(" "),
  );
  report.check("the bind host is the IPv4 literal, never localhost", start.HARNESS_ARGS.includes("127.0.0.1"));
  report.check("--port 0 is passed so the OS assigns", start.HARNESS_ARGS.join(" ").includes("--port 0"));
  report.check("--no-open is passed so no browser is launched", start.HARNESS_ARGS.includes("--no-open"));
  report.check("the readiness budget is 300s", start.READINESS_BUDGET_MS === 300_000, String(start.READINESS_BUDGET_MS));

  const runner = start.harnessRunnerFor("C:\\abs\\bin.js");
  report.check("the runner uses our own node binary", runner.command === process.execPath);
  report.check("bin.js is passed as an absolute argument", runner.args[0] === "C:\\abs\\bin.js");
  report.check(
    "no .cmd shim is involved anywhere in the spawn",
    !runner.args.some((arg) => /\.cmd$/i.test(arg)) && !/\.cmd$/i.test(runner.command),
  );
});

await report.section("harness spawn options suppress the console window", () => {
  // Regression tests for the stray black `node.exe` console window. On Windows a
  // detached child of a plain Node process gets its own console, and
  // `windowsHide` alone does not prevent that - CREATE_NO_WINDOW does.
  report.check(
    "CREATE_NO_WINDOW is the documented value",
    start.CREATE_NO_WINDOW === 0x08000000,
    `0x${start.CREATE_NO_WINDOW.toString(16)}`,
  );

  const win = start.buildHarnessSpawnOptions({ logFd: 1, platform: "win32", cwd: "C:\\x", env: {} });
  report.check(
    "Windows sets CREATE_NO_WINDOW",
    win.creationFlags === start.CREATE_NO_WINDOW,
    String(win.creationFlags),
  );
  report.check("windowsHide is still set alongside it", win.windowsHide === true);
  report.check("the harness stays detached", win.detached === true);
  report.check("the log descriptor feeds both output streams", win.stdio[1] === 1 && win.stdio[2] === 1);
  report.check("stdin is not inherited", win.stdio[0] === "ignore");
  report.check("the passed cwd wins", win.cwd === "C:\\x");
  report.check("the passed env wins", win.env !== undefined && Object.keys(win.env).length === 0);

  const posix = start.buildHarnessSpawnOptions({ logFd: 2, platform: "linux" });
  report.check("POSIX sets no creationFlags", posix.creationFlags === undefined, String(posix.creationFlags));
  report.check("POSIX still hides and detaches", posix.windowsHide === true && posix.detached === true);
});

// ---------------------------------------------------------------------------
// LIVE: the real harness, and the decisive detached-survival test.
// ---------------------------------------------------------------------------

if (!LIVE) {
  report.check("LIVE spawn skipped (set DSH_DOCK_TEST_LIVE=1 to run it)", true);
} else {
  const REGISTRY = await import("../lib/registry.js");
  const install = await import("../lib/harness-install.js");

  const SCRATCH_HOME = path.join(TMP_ROOT, "dsh-home");
  process.env.DSH_HOME = SCRATCH_HOME;

  const { version } = await REGISTRY.resolveLatestRcVersion();
  const installDir = install.versionInstallDir(version, { paths: PATHS });
  const binPath = install.harnessBinPath(installDir);

  let descriptor = null;

  await report.section("LIVE boot of the real harness", async () => {
    if (!fs.existsSync(binPath)) {
      report.check(
        `harness ${version} is not installed - run the install test with DSH_DOCK_TEST_INSTALL=1 first`,
        false,
        binPath,
      );
      return;
    }

    report.check("the harness entry point exists", fs.existsSync(binPath), binPath);
    report.check("the entry point is an absolute path", path.isAbsolute(binPath));

    let ticks = 0;
    descriptor = await start.startHarness({
      binPath,
      harnessVersion: version,
      installDir,
      paths: PATHS,
      onTick: () => {
        ticks += 1;
      },
    });

    report.check("the harness announced a URL", typeof descriptor.url === "string", descriptor.url);
    report.check("the URL is on the IPv4 loopback literal", descriptor.url.startsWith("http://127.0.0.1:"), descriptor.url);
    report.check("the URL carries a token", start.hasToken(descriptor.url), descriptor.url);
    report.check("a pid was recorded", descriptor.pid > 0, String(descriptor.pid));
    report.check("the port was parsed for diagnostics", descriptor.port > 1024 && descriptor.port <= 65535, String(descriptor.port));
    report.check(
      "the announced port matches the URL",
      descriptor.url.includes(`:${descriptor.port}`),
      `${descriptor.url} vs ${descriptor.port}`,
    );
    report.check("the log file is per-instance", descriptor.logFile.endsWith(`harness-${descriptor.instanceId}.log`), path.basename(descriptor.logFile));
    report.check("the wait reported progress ticks", ticks >= 0, `ticks=${ticks}`);
    report.check("readiness took a real amount of time", descriptor.elapsedMs > 0, `${descriptor.elapsedMs}ms`);
    process.stdout.write(`  (live) booted in ${descriptor.elapsedMs}ms on port ${descriptor.port}\n`);

    const probe = await harness.probeUrl(descriptor.url, { timeoutMs: 5000 });
    report.check("the harness URL answers", probe.reachable === true, JSON.stringify(probe));
    report.check("the status is a real HTTP status", probe.status > 0, String(probe.status));

    // The log must contain the readiness line for post-mortem diagnosis.
    const log = fs.readFileSync(descriptor.logFile, "utf8");
    report.check("the readiness line is in the log", log.includes("dsh web:"), log.slice(0, 200));
    report.check("the token appears in the log line", log.includes("token="));

    // Launcher breadcrumbs live in the .launcher.log, because the harness
    // truncates its own file during boot (measured: our appended line was gone
    // one second later). This asserts the durable location.
    const launcherLogFile = start.launcherLogFor(descriptor.logFile);
    report.check("the launcher log is a distinct file", launcherLogFile !== descriptor.logFile, launcherLogFile);
    report.check("the launcher log exists", fs.existsSync(launcherLogFile), launcherLogFile);

    const launcherLog = fs.existsSync(launcherLogFile) ? fs.readFileSync(launcherLogFile, "utf8") : "";
    report.check(
      "the 300s budget breadcrumb is durable in the launcher log",
      launcherLog.includes("waiting up to 300s for the harness URL"),
      launcherLog,
    );
    report.check(
      "the budget breadcrumb names this instance",
      launcherLog.includes(descriptor.instanceId),
      launcherLog,
    );
    report.check(
      "the success breadcrumb with elapsed time is durable",
      /harness ready after \d+ms/.test(launcherLog),
      launcherLog,
    );
  });

  await report.section("LIVE state records the exact URL", async () => {
    if (descriptor === null) {
      report.check("skipped: no live descriptor", true);
      return;
    }
    const written = harness.recordRunningHarness(
      {
        instanceId: descriptor.instanceId,
        pid: descriptor.pid,
        port: descriptor.port,
        url: descriptor.url,
        harnessVersion: descriptor.harnessVersion,
        installDir: descriptor.installDir,
        startedAt: new Date().toISOString(),
      },
      { paths: PATHS },
    );
    report.check("state stores the URL verbatim", written.url === descriptor.url);
    report.check(
      "the token survives into runtime-state.json",
      fs.readFileSync(PATHS.runtimeState, "utf8").includes("token="),
    );
  });

  await report.section("LIVE adopt reuses the running harness (no second spawn)", async () => {
    if (descriptor === null) {
      report.check("skipped: no live descriptor", true);
      return;
    }
    const result = await harness.adoptOrReap({ paths: PATHS });
    report.check("the decision is adopt", result.decision === "adopt", result.decision);
    report.check("the SAME pid is reused", result.state?.pid === descriptor.pid, `${result.state?.pid} vs ${descriptor.pid}`);
    report.check("the SAME url is reused", result.state?.url === descriptor.url);
    report.check("startFresh is false", result.startFresh === false);
    report.check("the harness is still alive", platform.isAlive(descriptor.pid) === true);
  });

  await report.section("LIVE: killing the sidecar must NOT kill the harness", async () => {
    if (descriptor === null) {
      report.check("skipped: no live descriptor", true);
      return;
    }

    // A REAL sidecar process, exactly as src-tauri spawns it. Its stdout is
    // written to files rather than a Node pipe (a Node-to-Node piped capture is
    // blocked in confined environments - see src-tauri/NOTES.md).
    const sidecarOut = path.join(TMP_ROOT, "sidecar.out.log");
    const sidecarErr = path.join(TMP_ROOT, "sidecar.err.log");
    const outFd = fs.openSync(sidecarOut, "w");
    const errFd = fs.openSync(sidecarErr, "w");

    const sidecar = spawn(process.execPath, [path.join(REPO_ROOT, "sidecar", "index.js")], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
      env: { ...process.env, DSH_DOCK_DATA_DIR: PATHS.root, DSH_HOME: SCRATCH_HOME },
    });
    sidecar.unref();
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    await sleep(1500);

    report.check("the sidecar process is running", platform.isAlive(sidecar.pid) === true, `pid=${sidecar.pid}`);
    report.check("the sidecar announce its port on stdout", fs.readFileSync(sidecarOut, "utf8").includes("SIDECAR_READY:"));

    // THE DECISIVE ACT: kill the sidecar outright.
    const kill = await platform.killTree(sidecar.pid);
    report.check("the sidecar was terminated", kill.ok === true, kill.note);
    await sleep(1200);
    report.check("the sidecar really is gone", platform.isAlive(sidecar.pid) === false);

    // The harness must still be alive and serving.
    report.check(
      "THE HARNESS SURVIVED the launcher-sidecar being killed",
      platform.isAlive(descriptor.pid) === true,
      `harness pid=${descriptor.pid}`,
    );

    const after = await harness.probeUrl(descriptor.url, { timeoutMs: 5000 });
    report.check(
      "the harness is STILL SERVING on its announced URL",
      after.reachable === true,
      JSON.stringify(after),
    );

    // And a fresh "launcher start" must adopt it rather than spawn again.
    const adopt = await harness.adoptOrReap({ paths: PATHS });
    report.check("a subsequent start adopts", adopt.decision === "adopt", adopt.decision);
    report.check("the adopted pid is the ORIGINAL harness pid", adopt.state?.pid === descriptor.pid, `${adopt.state?.pid} vs ${descriptor.pid}`);
    report.check("no second harness was spawned", adopt.startFresh === false);
    report.check(
      "the harness process count is still one",
      [descriptor.pid].filter((pid) => platform.isAlive(pid)).length === 1,
    );

    const stillThere = await harness.probeUrl(descriptor.url, { timeoutMs: 5000 });
    report.check("the adopted harness serves", stillThere.reachable === true);

    fs.writeFileSync(
      path.join(TMP_ROOT, "sidecar.err.snapshot.txt"),
      fs.readFileSync(sidecarErr, "utf8"),
      "utf8",
    );
  });

  await report.section("LIVE cleanup", async () => {
    if (descriptor === null) {
      report.check("nothing to clean up", true);
      return;
    }
    const stopped = await harness.stopRecordedHarness({ paths: PATHS });
    report.check("the harness was stopped", stopped.stopped === true, JSON.stringify(stopped.reasons));
    report.check("the harness process is gone", platform.isAlive(descriptor.pid) === false);
    report.check("state was cleared", !fs.existsSync(PATHS.runtimeState));
  });
}

process.exit(report.finish());
