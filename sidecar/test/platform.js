/**
 * Pause point 1 - the process seam (adopt/reap primitives).
 *
 * Proves, without any harness installed:
 *   - isAlive agrees with reality for live, exited and nonsensical pids
 *   - commandLineMatchesInstallDir matches path segments, not substrings
 *   - identifyHarness returns match / mismatch / unknown for the right reasons
 *   - commandLineFor really reads a Windows command line via CIM
 *   - killTree kills a process tree and verifies it is gone
 *
 * The last two sections launch throwaway Node children of this test. They do
 * NOT capture a Node-to-Node pipe (blocked in confined environments, see
 * src-tauri/NOTES.md): their stdio is `ignore`, and the only piped subprocesses
 * here are first-party OS binaries (powershell.exe, taskkill.exe).
 *
 * Run from the repo root:  node sidecar/test/platform.js
 * Exits 0 on success, 1 on failure.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const platform = await import("../lib/platform.js");
const report = createReport("DSH-Dock platform: liveness, identity, kill");

await report.section("isAlive", async () => {
  report.check("this process is alive", platform.isAlive(process.pid) === true, `pid=${process.pid}`);
  report.check("pid 0 is never queried", platform.isAlive(0) === false);
  report.check("a negative pid is never queried", platform.isAlive(-1) === false);
  report.check("a non-integer pid is rejected", platform.isAlive(1.5) === false);
  report.check("null is rejected", platform.isAlive(null) === false);
  report.check("undefined is rejected", platform.isAlive(undefined) === false);
  report.check("NaN is rejected", platform.isAlive(Number.NaN) === false);

  // A pid that has certainly exited: spawn `node --version`, wait for it.
  const child = spawn(process.execPath, ["--version"], { stdio: "ignore", windowsHide: true });
  const exitedPid = child.pid;
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  await sleep(200);
  report.check("the probe child ran to completion", exitCode === 0, `exit=${exitCode}`);
  report.check(
    "an exited pid reports not alive",
    platform.isAlive(exitedPid) === false,
    `pid=${exitedPid}`,
  );
});

await report.section("commandLineMatchesInstallDir (pure)", () => {
  const dir = "C:\\Users\\t\\AppData\\Local\\DSH-Dock\\versions\\0.1.5-rc.2";
  const matches = platform.commandLineMatchesInstallDir;

  const real =
    `"node.exe" "C:\\Users\\t\\AppData\\Local\\DSH-Dock\\versions\\0.1.5-rc.2\\node_modules\\` +
    `@deepseek-ai\\dsh\\lib\\bin.js" --profile web --port 0`;
  report.check("matches a real Windows command line", matches(real, dir, "win32") === true);

  report.check(
    "matches when the path is the last token",
    matches(`node.exe ${dir}`, dir, "win32") === true,
  );

  report.check(
    "tolerates forward slashes in the command line",
    matches(real.split("\\").join("/"), dir, "win32") === true,
  );

  report.check(
    "is case-insensitive on Windows",
    matches(real.toLowerCase(), dir, "win32") === true,
  );

  report.check(
    "matches a quoted path",
    matches(`node.exe "${dir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"`, dir, "win32") === true,
  );

  // The path-segment guard: a sibling version whose name merely starts the same
  // way must NOT be treated as ours.
  const sibling = dir.replace("0.1.5-rc.2", "0.1.5-rc.20");
  report.check(
    "does not match a longer sibling version (0.1.5-rc.20)",
    matches(`node.exe "${sibling}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"`, dir, "win32") === false,
  );
  report.check(
    "does not match a bare prefix (0.1.5-rc)",
    matches("node.exe C:\\Users\\t\\AppData\\Local\\DSH-Dock\\versions\\0.1.5-rc", dir, "win32") === false,
  );

  report.check("rejects an unrelated process", matches("C:\\Windows\\explorer.exe", dir, "win32") === false);
  report.check("rejects an empty command line", matches("", dir, "win32") === false);
  report.check("rejects a non-string command line", matches(null, dir, "win32") === false);
  report.check("rejects an empty install dir", matches(real, "", "win32") === false);

  // POSIX comparison is case-SENSITIVE, unlike Windows.
  const posixDir = "/home/t/DSH-Dock/versions/0.1.5-rc.2";
  report.check(
    "matches a POSIX command line",
    matches(`node ${posixDir}/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web`, posixDir, "linux") === true,
  );
  report.check(
    "POSIX comparison is case-sensitive",
    matches(`node ${posixDir.toUpperCase()}/node_modules/x.js`, posixDir, "linux") === false,
  );

  // A trailing separator on the recorded install dir must not change the answer.
  report.check(
    "ignores a trailing separator on the install dir",
    matches(real, `${dir}\\`, "win32") === true,
  );
});

await report.section("identifyHarness verdicts", async () => {
  // Identity is asserted against a REAL second process whose entry is an
  // ABSOLUTE path, because that is the shape production uses
  // (`node <data-dir>/versions/<v>/node_modules/@deepseek-ai/dsh/lib/bin.js`).
  //
  // This matters: Windows SHORTENS the stored command line to the relative
  // entry path when node is invoked with a relative argument. Asserting an
  // absolute install directory against a relatively-invoked node therefore
  // fails, which is a property of the observation, not of the matcher.
  const noopChild = path.join(HERE, "lib", "noop-child.js");
  const subject = spawn(process.execPath, [noopChild], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  subject.unref();
  const subjectPid = subject.pid;
  await sleep(500);

  try {
    report.check("the identity subject is running", platform.isAlive(subjectPid) === true, `pid=${subjectPid}`);

    const verdict = await platform.identifyHarness(subjectPid, HERE, { platform: process.platform });
    if (process.platform === "win32") {
      report.check(
        "a live process whose command line names the dir is a `match`",
        verdict.status === "match",
        `${verdict.status}: ${verdict.reason} | cmd=${verdict.commandLine}`,
      );
    } else {
      report.check(
        "POSIX identity is honestly `unknown` in Phase 1",
        verdict.status === "unknown",
        verdict.status,
      );
    }

    const mismatch = await platform.identifyHarness(subjectPid, path.join(HERE, "not-our-dir"), {
      platform: process.platform,
    });
    if (process.platform === "win32") {
      report.check(
        "a live process from another directory is a `mismatch`",
        mismatch.status === "mismatch",
        mismatch.status,
      );
    } else {
      report.check("POSIX has no identity verdict", mismatch.status === "unknown", mismatch.status);
    }

    // Windows stores a SHORTENED command line when node is invoked with a
    // relative entry path (`node sidecar/test/x.js`). Production always passes
    // an absolute bin.js, so this is recorded as an observation rather than an
    // assertion about our matching rules.
    const shortened = await platform.commandLineFor(subjectPid);
    report.check(
      "the absolute entry path is present in the real command line",
      typeof shortened === "string" && shortened.includes("noop-child.js"),
      (shortened ?? "").slice(0, 140),
    );
  } finally {
    await platform.killTree(subjectPid);
  }

  const dead = await platform.identifyHarness(0, HERE, { platform: process.platform });
  report.check("pid 0 is `unknown`, never a match", dead.status === "unknown", dead.reason);

  const goneChild = spawn(process.execPath, ["--version"], { stdio: "ignore", windowsHide: true });
  const gonePid = goneChild.pid;
  await new Promise((resolve) => goneChild.once("exit", resolve));
  await sleep(150);
  const gone = await platform.identifyHarness(gonePid, HERE, { platform: process.platform });
  report.check("an exited pid is `unknown` (not a match)", gone.status === "unknown", gone.reason);

  if (process.platform !== "win32") {
    const posixVerdict = await platform.identifyHarness(process.pid, HERE, { platform: "linux" });
    report.check(
      "the POSIX branch reports the Phase 1 limitation instead of guessing",
      posixVerdict.status === "unknown" && /not implemented/.test(posixVerdict.reason),
      posixVerdict.reason,
    );
  }
});

if (process.platform === "win32") {
  await report.section("commandLineFor against real Windows processes", async () => {
    const self = await platform.commandLineFor(process.pid);
    report.check("reads this process's command line", typeof self === "string" && self.length > 0);
    report.check("the command line mentions node", /node/i.test(self ?? ""), (self ?? "").slice(0, 120));
    report.check("it mentions this test file", (self ?? "").includes("platform.js"));

    const missing = await platform.commandLineFor(999999);
    report.check("a non-existent pid returns null", missing === null);

    const refused = await platform.commandLineFor(0);
    report.check("pid 0 returns null without probing", refused === null);

    const otherPlatform = await platform.commandLineFor(process.pid, { platform: "linux" });
    report.check("the POSIX branch returns null on this host", otherPlatform === null);
  });
}

await report.section("killTree", async () => {
  const invalid = await platform.killTree(0);
  report.check("an invalid pid is a no-op success", invalid.ok === true && invalid.method === "noop", invalid.note);

  const absent = await platform.killTree(999999);
  report.check("an absent pid is a no-op success", absent.ok === true && absent.method === "noop", absent.note);

  // A long-lived, detached child that mimics the harness's process shape:
  // detached so it leads its own group, stdio ignored so no Node pipe is made.
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  victim.unref();
  const victimPid = victim.pid;
  await sleep(400);
  report.check("the victim is running before the kill", platform.isAlive(victimPid) === true, `pid=${victimPid}`);

  const result = await platform.killTree(victimPid);
  report.check("killTree reports ok", result.ok === true, `${result.method}: ${result.note}`);
  report.check("the victim is gone afterwards", platform.isAlive(victimPid) === false, `pid=${victimPid}`);
  report.check("killTree names the mechanism used", typeof result.method === "string" && result.method.length > 0, result.method);
  report.check("killTree reports elapsed time", Number.isFinite(result.waitedMs) && result.waitedMs >= 0, `${result.waitedMs}ms`);
});

process.exit(report.finish());
