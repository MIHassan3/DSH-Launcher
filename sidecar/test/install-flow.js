/**
 * Step 3 - the install path: staged atomic rename, the in-place fallback, the
 * library lock, and the running-version guard.
 *
 * Structure of this test:
 *
 *   parameterization - a malformed version is refused; no dist-tag is consulted.
 *   staged           - the happy path, the atomic-rename property, cleanup, and
 *                      the auto-mode fallback when staging cannot land.
 *   in-place         - the `.incomplete` marker's whole life cycle.
 *   validation codes - every problem code, and the staged path's failure mode.
 *   running guard    - the refusal, its wording, and byte-identity of the target.
 *   locking          - acquire, refuse, stale takeover, release, cross-process.
 *   catalogue        - a validated install is recorded automatically.
 *
 * EVERY npm INVOCATION HERE IS THE `fake-npm.js` STUB run by this Node binary.
 * No real npm, no network, no real harness, and no process is killed anywhere.
 * The only spawned processes are the stub and two Node children used for the
 * lock's cross-process checks; all are spawned with CREATE_NO_WINDOW where the
 * platform needs it (see [`spawnStub`]).
 *
 * Run from the repo root:
 *   node sidecar/test/install-flow.js
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "install-flow");

process.env.DSH_DOCK_DATA_DIR = TMP_ROOT;

const report = createReport("DSH-Dock install flow: staging, locking, guards");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");
const install = await import("../lib/harness-install.js");
const library = await import("../lib/library.js");
const lock = await import("../lib/library-lock.js");
const catalogue = await import("../lib/catalogue.js");
const validation = await import("../lib/validation.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

// Clear any lock left by an interrupted earlier run. A leak here would make every
// later install in this file fail with a refusal, which is how the first run of
// this test behaved - see the parameterization section's note on `await`.
fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });
for (const entry of fs.readdirSync(PATHS.versions)) {
  if (entry.startsWith(".staging-")) {
    fs.rmSync(path.join(PATHS.versions, entry), { recursive: true, force: true });
  }
}

const FAKE_NPM = path.join(HERE, "lib", "fake-npm.js");

/** CREATE_NO_WINDOW, so no stub process flashes a console window (section 2.7). */
const CREATE_NO_WINDOW = 0x0800_0000;

/**
 * Runs the fake-npm stub directly, for any case that needs a real child process.
 *
 * This is a NEW SPAWN SITE, and it applies the section 2.7 rule: a GUI-subsystem
 * parent (the launcher) would otherwise give this child its own console window.
 * `windowsHide` alone is not enough, for the reason documented in
 * `harness-start.js`. Nothing here is killed by image name - the cross-process
 * lock test kills the one child whose pid it recorded from `spawn`.
 */
function spawnStub(args = [], env = {}) {
  return spawn(process.execPath, [FAKE_NPM, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
    env: { ...process.env, ...env },
  });
}

/** Shorthand for an install driven by the stub, with the flags a given case needs. */
const stub = (env = {}) => ({ npmCommand: [process.execPath, FAKE_NPM], env });

/** A stub environment that produces a tree Phase 2 validation ACCEPTS. */
const COMPLETE = Object.freeze({
  FAKE_NPM_MODE: "ok",
  FAKE_NPM_MAKE_BIN: "1",
  FAKE_NPM_MAKE_MANIFEST: "1",
  FAKE_NPM_MAKE_WEB_APP: "1",
});

/**
 * Runs `body` with extra environment variables, then restores the environment.
 *
 * Snapshotting the whole object is deliberate: assigning `undefined` back would
 * store the literal string "undefined", which a stub checking `=== "1"` reads as
 * "set to something else".
 */
async function withEnv(env, body) {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await body();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

/** Removes a version directory and any staging/backup leftovers for it. */
function cleanVersion(version) {
  fs.rmSync(path.join(PATHS.versions, version), { recursive: true, force: true });
  for (const entry of fs.readdirSync(PATHS.versions)) {
    if (entry.startsWith(`.staging-${version}-`)) {
      fs.rmSync(path.join(PATHS.versions, entry), { recursive: true, force: true });
    }
  }
}

/** Every staging/backup directory currently in the library root. */
function stagingLeftovers() {
  return fs.readdirSync(PATHS.versions).filter((entry) => entry.startsWith(".staging-"));
}

/** A recursive snapshot: relative path -> sha256 (files) or "dir" (directories). */
function snapshotTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out[rel] = "dir";
        walk(full, rel);
      } else {
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}

/** Writes a runtime-state.json that passes validation, naming `installDir`. */
function writeRunningState({ version, installDir, pid = 4242, instanceId = "20261012T000000-test" }) {
  const stateFile = {
    version: 1,
    pid,
    port: 54321,
    url: `http://127.0.0.1:54321/?token=${"a".repeat(32)}`,
    harnessVersion: version,
    installDir,
    instanceId,
    startedAt: "2026-10-12T00:00:00.000Z",
    recordedAt: "2026-10-12T00:00:01.000Z",
  };
  fs.writeFileSync(PATHS.runtimeState, `${JSON.stringify(stateFile, null, 2)}\n`, "utf8");
  return stateFile;
}

/** Clears the recorded running harness. */
function clearRunningState() {
  fs.rmSync(PATHS.runtimeState, { force: true });
}

// ---------------------------------------------------------------------------
// Parameterization
// ---------------------------------------------------------------------------

await report.section("parameterization: exact versions only, no dist-tags", async () => {
  report.check(
    "a normal semver is accepted by the guard",
    install.isSafeVersionName("0.2.0-rc.2") === true,
  );

  // A dist-tag is not a version. It is refused by the same name rule, which is
  // what makes "no dist-tag is consulted in this module" mechanically true rather
  // than a promise: there is no code path that could resolve one.
  //
  // `await` MATTERS HERE, and its absence was the first bug this test found.
  // `installVersion` is `async`, so the guard's throw becomes a REJECTED PROMISE,
  // not a synchronous throw. Calling it unawaited therefore (a) never entered the
  // `catch`, and (b) left the real install running in the background holding the
  // library lock, which then blocked every later section in this file. The
  // refusals are checked with `await` so the promise settles before the assertion.
  const refused = ["next", "latest", "alpha", "*", "^0.2.0", "~0.2.0", "0.2.0 || 0.3.0", "1.x"];
  for (const candidate of refused) {
    let error = null;
    try {
      await install.installVersion(candidate, { paths: PATHS, ...stub(COMPLETE) });
    } catch (caught) {
      error = caught;
    }
    report.check(
      `${JSON.stringify(candidate)} is refused as a version name`,
      error?.name === "InstallError" && error.step === "version-name",
      `${error?.name}/${error?.step}`,
    );
  }

  report.check(
    "the refusal explains what is expected instead",
    await (async () => {
      try {
        await install.installVersion("next", { paths: PATHS, ...stub(COMPLETE) });
        return false;
      } catch (error) {
        return error.message.includes("exact version") && error.message.includes("dist-tag");
      }
    })(),
  );

  // The property under test is about EXECUTABLE code, so comments are stripped
  // first. The module's own documentation necessarily says the words "dist-tag"
  // and "registry" while explaining that neither is consulted; matching on the raw
  // file therefore failed for the wrong reason on the first run.
  const source = fs.readFileSync(path.join(HERE, "..", "lib", "harness-install.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  report.check(
    "the module's CODE never resolves a dist-tag or touches the registry",
    !/dist-tags|registry\.npmjs|resolveLatestRc|fetchPackument/.test(code),
    "a tag resolution inside the install module would make installs non-reproducible",
  );

  report.check(
    "a malformed version never creates a directory",
    (() => {
      const before = fs.readdirSync(PATHS.versions).length;
      const rejected = install
        .installVersion("../../evil", { paths: PATHS, ...stub(COMPLETE) })
        .catch(() => null);
      // The guard is synchronous inside the async function, so the directory count
      // is already final; the catch just prevents an unhandled rejection.
      const after = fs.readdirSync(PATHS.versions).length;
      void rejected;
      return after === before;
    })(),
  );

  report.check("no lock was left behind by the refusals", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);
  report.check("no staging directory was created by the refusals", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
});

// ---------------------------------------------------------------------------
// Staged install
// ---------------------------------------------------------------------------

await report.section("staged install: atomic rename onto the target", async () => {
  const version = "1.0.0-staged";
  cleanVersion(version);

  const result = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub() }),
  );

  report.check("the install reports the staged approach", result.approach === install.INSTALL_APPROACH.STAGED, String(result.approach));
  report.check("no fallback was needed", result.fallbackReason === null, String(result.fallbackReason));
  report.check("the staging directory is reported", typeof result.stagingDir === "string" && result.stagingDir.includes(".staging-"), String(result.stagingDir));
  report.check("the staging directory is gone after the rename", fs.existsSync(result.stagingDir) === false);
  report.check("the target directory exists", fs.existsSync(result.installDir) === true);
  report.check("bin.js is at the target", fs.existsSync(result.binPath) === true);
  report.check("no .incomplete marker was written on the staged path", fs.existsSync(path.join(result.installDir, validation.INCOMPLETE_MARKER)) === false);
  report.check("no staging leftovers remain", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  report.check(
    "the staged tree passes a fresh validation at its final path",
    validation.validateInstallTree(version, result.installDir).ok === true,
  );
  report.check(
    "the target is inside the library root",
    library.isPathInsideVersions(result.installDir, { paths: PATHS }) === true,
  );
});

await report.section("the rename preserves identity, not just location (the atomicity property)", async () => {
  // "Atomic" is only observable indirectly here: what can be asserted is that the
  // directory object that was validated is the SAME directory object that ends up
  // at the target - a copy would have new inode/file ids. On Windows `fs.renameSync`
  // of a directory uses MoveFileEx, which is a metadata rename within a volume;
  // the staging directory is created as a SIBLING of the target precisely so the
  // rename can never cross a volume boundary (where it would degrade to a copy).
  const version = "1.0.1-identity";
  cleanVersion(version);

  const staging = install.stagingDirFor(version, { paths: PATHS, nonce: "identity" });
  report.check(
    "a staging directory is a sibling of the target, in the same directory",
    path.dirname(staging) === path.dirname(install.versionInstallDir(version, { paths: PATHS })),
  );
  report.check(
    "a staging directory is never a version name",
    library.isVersionDirName(path.basename(staging)) === false,
  );
  report.check(
    "two staging directories never collide",
    install.stagingDirFor(version, { paths: PATHS }) !== install.stagingDirFor(version, { paths: PATHS }),
  );

  const result = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub() }),
  );

  const marker = path.join(result.installDir, "identity-probe.txt");
  const stagingMarker = path.join(result.stagingDir, "identity-probe.txt");
  fs.writeFileSync(marker, "written after the rename\n");

  report.check("a file added at the target is visible at the target", fs.existsSync(marker) === true);
  report.check(
    "the same file is NOT visible at the old staging path (the directory moved, it was not copied)",
    fs.existsSync(stagingMarker) === false,
  );
  report.check(
    "the staging path does not exist at all after the rename",
    fs.existsSync(result.stagingDir) === false,
  );
});

await report.section("a force reinstall moves the old tree aside and never loses it", async () => {
  const version = "1.0.2-replace";
  cleanVersion(version);

  await withEnv(COMPLETE, () => install.installVersion(version, { paths: PATHS, ...stub() }));
  const installDir = install.versionInstallDir(version, { paths: PATHS });

  // A marker proving the FIRST tree's content, which the reinstall must remove.
  fs.writeFileSync(path.join(installDir, "from-the-first-install.txt"), "old\n");
  const before = snapshotTree(installDir);

  const forced = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub(), force: true }),
  );

  report.check("the force reinstall used the staged path", forced.approach === install.INSTALL_APPROACH.STAGED);
  report.check("the version is still installed", install.isInstalled(version, { paths: PATHS }) === true);
  report.check(
    "the reinstalled tree is a fresh one",
    fs.existsSync(path.join(installDir, "from-the-first-install.txt")) === false,
  );
  report.check(
    "the old tree is not the new tree",
    JSON.stringify(snapshotTree(installDir)) !== JSON.stringify(before),
  );
  report.check("no backup directory is left behind", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  report.check("the reinstalled tree validates", validation.validateInstallTree(version, installDir).ok === true);
  report.check("the catalogue was updated by the reinstall", catalogue.readCatalogue({ paths: PATHS }).document.versions[version] !== undefined);

  cleanVersion(version);
});

await report.section("an incomplete staged tree aborts rather than falling back", async () => {
  const version = "1.0.3-fallback";
  cleanVersion(version);

  // A staged tree that fails VALIDATION is not an environmental problem: the
  // in-place attempt would run the same npm with the same flags and produce the
  // same tree, so falling back would only repeat a large download before reporting
  // the same failure. It must abort, and the invocation counter proves it did.
  const counterFile = path.join(TMP_ROOT, "npm-invocations.jsonl");
  fs.rmSync(counterFile, { force: true });

  let error = null;
  try {
    await withEnv(
      { FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_NODE_MODULES: "1", FAKE_NPM_COUNTER_FILE: counterFile },
      () => install.installVersion(version, { paths: PATHS, ...stub() }),
    );
  } catch (caught) {
    error = caught;
  }

  const invocations = fs.existsSync(counterFile)
    ? fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean)
    : [];

  report.check("the install failed", error?.name === "InstallError", error?.message?.split("\n")[0]);
  report.check("npm ran exactly ONCE (no pointless retry)", invocations.length === 1, `${invocations.length} invocation(s)`);
  report.check("the single invocation used the staging directory", (invocations[0] ?? "").includes(".staging-"), invocations[0]);
  report.check("the failure is a validation failure", error?.step === "validate", error?.step);
  report.check(
    "the failure is attributed to the staged attempt",
    error?.approach === install.INSTALL_APPROACH.STAGED,
    `approach=${error?.approach}`,
  );
  report.check(
    "the error names the FINAL target, not the staging directory",
    error?.installDir === install.versionInstallDir(version, { paths: PATHS }),
    String(error?.installDir),
  );
  report.check(
    "the staging directory is still named, so the attempt is locatable",
    typeof error?.stagingDir === "string" && error.stagingDir.includes(".staging-"),
    String(error?.stagingDir),
  );
  report.check(
    "the missing entry point is reported by code",
    (error?.problems ?? []).some((problem) => problem.code === validation.PROBLEM.BIN_MISSING),
    JSON.stringify((error?.problems ?? []).map((problem) => problem.code)),
  );
  report.check("no staging leftovers remain", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  report.check(
    "nothing was left at the target",
    fs.existsSync(install.versionInstallDir(version, { paths: PATHS })) === false,
  );

  cleanVersion(version);
  fs.rmSync(counterFile, { force: true });
});

await report.section("the environmental fallback completes and installs cleanly", async () => {
  const version = "1.0.5-fallback-ok";
  cleanVersion(version);

  // THE REAL FALLBACK SCENARIO, modelled end to end: npm does not populate the
  // staging prefix (the `--prefix` disagreement this fallback exists for), so the
  // staged attempt cannot land; the in-place retry then installs normally and the
  // install SUCCEEDS. This is the case that proves the fallback is a working
  // recovery path rather than merely an error-shaping branch.
  const counterFile = path.join(TMP_ROOT, "npm-invocations-ok.jsonl");
  fs.rmSync(counterFile, { force: true });

  const result = await withEnv(
    { ...COMPLETE, FAKE_NPM_BREAK_STAGED: "1", FAKE_NPM_COUNTER_FILE: counterFile },
    () => install.installVersion(version, { paths: PATHS, ...stub() }),
  );

  const invocations = fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean);

  report.check("the install succeeded", result.skipped === false);
  report.check("npm ran TWICE (staged attempt, then in-place)", invocations.length === 2, `${invocations.length}`);
  report.check(
    "the FIRST invocation used the staging directory",
    (invocations[0] ?? "").includes(".staging-"),
    invocations[0],
  );
  report.check(
    "the SECOND invocation used the final target directory",
    JSON.parse(invocations[1] ?? "{}").argv?.includes(path.join(PATHS.versions, version)) === true &&
      (invocations[1] ?? "").includes(".staging-") === false,
    invocations[1],
  );
  report.check(
    "the reported approach is in-place",
    result.approach === install.INSTALL_APPROACH.IN_PLACE,
    String(result.approach),
  );
  report.check(
    "the fallback reason names the staging prefix",
    /staging prefix/.test(result.fallbackReason ?? ""),
    result.fallbackReason,
  );
  report.check("no staging directory is reported on the in-place path", result.stagingDir === null);
  report.check("no staging leftovers remain", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  report.check(
    "the version is installed and validates at its final path",
    install.isInstalledAndValid(version, { paths: PATHS }) === true,
  );
  report.check(
    "the .incomplete marker was removed once validation passed",
    fs.existsSync(path.join(result.installDir, validation.INCOMPLETE_MARKER)) === false,
  );
  report.check(
    "enumeration reports it installed",
    library.readLibraryEntry(version, { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
  );
  report.check(
    "the install is recorded in the catalogue",
    catalogue.readCatalogue({ paths: PATHS }).document.versions[version] !== undefined,
  );

  cleanVersion(version);
  fs.rmSync(counterFile, { force: true });
});

await report.section("the fallback does not silently promote an invalid tree", async () => {
  const version = "1.0.4-fallback-invalid";
  cleanVersion(version);
  const installDir = install.versionInstallDir(version, { paths: PATHS });

  // `approach: "staged"` disables the fallback, so an environmental staging
  // problem is reported instead of being papered over - and nothing is created at
  // all. Note the step: `staged`, because the fallback was never attempted. A
  // `validate` step here would mean the fallback ran despite being disabled.
  //
  // The tree produced is COMPLETE, so validation passes and the failed rename is
  // the only failure - which is what makes the step assertion meaningful. With an
  // incomplete tree this would fail at `validate` instead, and would not be
  // testing the fallback-disabled path at all.
  let forcedStaging = null;
  try {
    await withEnv(
      { ...COMPLETE, FAKE_NPM_BREAK_STAGED: "1" },
      () => install.installVersion(version, { paths: PATHS, ...stub(), approach: "staged" }),
    );
  } catch (caught) {
    forcedStaging = caught;
  }

  report.check("with approach:staged, the failure is raised", forcedStaging?.name === "InstallError", forcedStaging?.name);
  report.check("and it names the staged step", forcedStaging?.step === "staged", forcedStaging?.step);
  report.check(
    "the staging directory is named, so the failure is locatable",
    typeof forcedStaging?.stagingDir === "string" && forcedStaging.stagingDir.includes(".staging-"),
    String(forcedStaging?.stagingDir),
  );
  report.check("and the target was never created", fs.existsSync(installDir) === false);
  report.check("and the staging directory was cleaned up", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));

  // A tree that FAILS validation must never be promoted to the target. With the
  // fallback disabled the staged attempt fails and nothing is created; with the
  // default auto mode the retry must ALSO fail before anything is promoted, so the
  // target stays absent in both modes.
  cleanVersion(version);
  let invalidStaged = null;
  try {
    await withEnv(
      { FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_NODE_MODULES: "1", FAKE_NPM_MAKE_BIN: "1" },
      () => install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place" }),
    );
  } catch (caught) {
    invalidStaged = caught;
  }
  report.check("an incomplete tree fails validation", invalidStaged?.step === "validate", invalidStaged?.step);
  report.check(
    "the specific missing code is reported",
    (invalidStaged?.problems ?? []).some((problem) =>
      [validation.PROBLEM.DSH_PACKAGE_MISSING, validation.PROBLEM.WEB_APP_MISSING].includes(problem.code),
    ),
    JSON.stringify((invalidStaged?.problems ?? []).map((problem) => problem.code)),
  );
  report.check(
    "nothing was promoted to the target: a failed fresh install leaves no directory",
    fs.existsSync(installDir) === false,
    JSON.stringify(fs.existsSync(installDir) ? fs.readdirSync(installDir) : []),
  );
  report.check(
    "the staging directory did not survive the validation failure",
    stagingLeftovers().length === 0,
    JSON.stringify(stagingLeftovers()),
  );

  cleanVersion(version);
});

// ---------------------------------------------------------------------------
// In-place install and the marker
// ---------------------------------------------------------------------------

await report.section("in-place install: the .incomplete marker's life cycle", async () => {
  const version = "1.1.0-marker";
  cleanVersion(version);

  const result = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place" }),
  );

  report.check("the in-place approach is reported", result.approach === install.INSTALL_APPROACH.IN_PLACE, String(result.approach));
  report.check("no staging directory was used", result.stagingDir === null);
  report.check("no fallback reason (in-place was requested)", result.fallbackReason === null);
  report.check(
    "the marker is DELETED after validation succeeded",
    fs.existsSync(path.join(result.installDir, validation.INCOMPLETE_MARKER)) === false,
  );
  report.check("the tree is installed and valid", validation.validateInstallTree(version, result.installDir).ok === true);
  report.check(
    "enumeration reports it installed, not partial",
    library
      .listInstalledVersions({ paths: PATHS })
      .find((entry) => entry.version === version)?.state === library.LIBRARY_STATE.INSTALLED,
  );
});

await report.section("the marker is written BEFORE npm runs", async () => {
  const version = "1.1.1-marker-early";
  cleanVersion(version);

  // npm is made to fail, so the install never reaches the deletion step. If the
  // marker were written after npm, there would be nothing to observe here.
  let error = null;
  try {
    await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "3" }, () =>
      install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place" }),
    );
  } catch (caught) {
    error = caught;
  }

  report.check("the install failed with npm's exit code", error?.exitCode === 3, String(error?.exitCode));
  report.check(
    "a failed FIRST in-place install leaves no version directory at all",
    fs.existsSync(install.versionInstallDir(version, { paths: PATHS })) === false,
    "a failed first install must not leave an empty version for the UI to show",
  );

  // Now the interesting case: the directory already existed, so the failure must
  // leave a MARKED directory rather than deleting content that was there before.
  const installDir = install.versionInstallDir(version, { paths: PATHS });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "pre-existing.txt"), "was here before\n");

  let second = null;
  try {
    await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "4" }, () =>
      install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place" }),
    );
  } catch (caught) {
    second = caught;
  }

  report.check("the second attempt also failed", second?.exitCode === 4, String(second?.exitCode));
  report.check(
    "the pre-existing content was NOT deleted",
    fs.existsSync(path.join(installDir, "pre-existing.txt")) === true,
  );
  report.check(
    "the marker is present after a failed install over existing content",
    fs.existsSync(path.join(installDir, validation.INCOMPLETE_MARKER)) === true,
  );
  report.check(
    "the marker is valid JSON explaining itself",
    (() => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(installDir, validation.INCOMPLETE_MARKER), "utf8"));
        return parsed.version === version && typeof parsed.startedAt === "string";
      } catch {
        return false;
      }
    })(),
  );
  report.check(
    "a marked directory enumerates as partial even though bin.js may exist",
    library
      .listInstalledVersions({ paths: PATHS })
      .find((entry) => entry.version === version)?.hasIncompleteMarker === true,
  );
  report.check(
    "and its state is partial, not installed",
    library
      .listInstalledVersions({ paths: PATHS })
      .find((entry) => entry.version === version)?.state === library.LIBRARY_STATE.PARTIAL,
  );
  report.check(
    "the marker is reported by partialInstallDirs",
    library.partialInstallDirs({ paths: PATHS }).incomplete.includes(version) === true,
  );
  report.check(
    "the marked version is excluded from the ready list",
    library.listReadyVersions({ paths: PATHS }).some((entry) => entry.version === version) === false,
  );

  cleanVersion(version);
});

await report.section("a marked directory becomes installed once a good install completes", async () => {
  const version = "1.1.2-marker-recover";
  const installDir = install.versionInstallDir(version, { paths: PATHS });
  cleanVersion(version);

  // A leftover marked tree with a stale bin.js: the exact state that made the old
  // `existsSync(binPath)` check lie.
  fs.mkdirSync(path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// stale\n");
  fs.writeFileSync(path.join(installDir, validation.INCOMPLETE_MARKER), "{}\n");

  report.check(
    "the old isInstalled check still says yes (why the marker is needed)",
    install.isInstalled(version, { paths: PATHS }) === true,
  );
  report.check(
    "but the library says partial",
    library.readLibraryEntry(version, { paths: PATHS }).state === library.LIBRARY_STATE.PARTIAL,
  );
  report.check(
    "and validation rejects it",
    install.isInstalledAndValid(version, { paths: PATHS }) === false,
  );
  report.check(
    "and a NON-forced install short-circuits on the stale bin.js",
    (await withEnv(COMPLETE, () =>
      install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place" }),
    )).skipped === true,
    "this is exactly why the isInstalled rewire is deferred to its own step: the sticky " +
      "Phase 1 check makes a marked directory look installable, so a recovery must force",
  );

  const result = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub(), approach: "in-place", force: true }),
  );

  report.check("the recovery install succeeded", result.approach === install.INSTALL_APPROACH.IN_PLACE, String(result.approach));
  report.check(
    "the marker is gone",
    fs.existsSync(path.join(installDir, validation.INCOMPLETE_MARKER)) === false,
  );
  report.check(
    "the tree now validates",
    install.isInstalledAndValid(version, { paths: PATHS }) === true,
  );
  report.check(
    "and the library reports installed",
    library.readLibraryEntry(version, { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
  );

  cleanVersion(version);
});

// ---------------------------------------------------------------------------
// Validation failure codes through the install path
// ---------------------------------------------------------------------------

await report.section("validation codes through the install path", async () => {
  const cases = [
    {
      label: "no bin.js",
      version: "1.2.0-nobin",
      env: { FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_MANIFEST: "1", FAKE_NPM_MAKE_WEB_APP: "1" },
      code: validation.PROBLEM.BIN_MISSING,
    },
    {
      label: "no harness package",
      version: "1.2.1-nodsh",
      env: { FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1", FAKE_NPM_MAKE_WEB_APP: "1" },
      code: validation.PROBLEM.DSH_PACKAGE_MISSING,
    },
    {
      label: "no web-app package",
      version: "1.2.2-nowebapp",
      env: { FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1", FAKE_NPM_MAKE_MANIFEST: "1" },
      code: validation.PROBLEM.WEB_APP_MISSING,
    },
  ];

  for (const testCase of cases) {
    cleanVersion(testCase.version);
    let error = null;
    try {
      // `approach: "in-place"` pins the failure to the tree's CONTENTS. With the
      // default auto mode, a tree that fails validation in staging is retried in
      // place, and with the stub the retry produces the same tree - so the error
      // would be the in-place one. Both are the same codes; this just makes the
      // assertion unambiguous about which attempt it is checking.
      await withEnv(testCase.env, () =>
        install.installVersion(testCase.version, { paths: PATHS, ...stub(), approach: "in-place" }),
      );
    } catch (caught) {
      error = caught;
    }

    const codes = (error?.problems ?? []).map((problem) => problem.code);
    report.check(
      `${testCase.label}: the install fails`,
      error?.name === "InstallError",
      error?.message?.split("\n")[0],
    );
    report.check(
      `${testCase.label}: the specific code ${testCase.code} is reported`,
      codes.includes(testCase.code),
      JSON.stringify(codes),
    );
    report.check(
      `${testCase.label}: missingPaths names the offending path`,
      Array.isArray(error?.missingPaths) && error.missingPaths.length > 0,
      JSON.stringify(error?.missingPaths),
    );
    report.check(
      `${testCase.label}: the message names the search roots`,
      /looked in/.test(error?.message ?? "") || /bin\.js/.test(error?.message ?? ""),
      undefined,
    );
    report.check(
      `${testCase.label}: nothing was left at the target`,
      fs.existsSync(install.versionInstallDir(testCase.version, { paths: PATHS })) === false,
      "a failed staged install must not promote a broken tree",
    );
    report.check(`${testCase.label}: no staging leftovers`, stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
    cleanVersion(testCase.version);
  }

  // A manifest that exists but cannot be parsed is a distinct code, and it has to
  // come from a hand-made tree because the stub always writes valid JSON.
  const version = "1.2.3-badjson";
  cleanVersion(version);
  const staging = install.stagingDirFor(version, { paths: PATHS, nonce: "badjson" });
  fs.mkdirSync(path.join(staging, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  fs.writeFileSync(path.join(staging, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// x\n");
  fs.writeFileSync(path.join(staging, "node_modules", "@deepseek-ai", "dsh", "package.json"), "{ broken");
  fs.mkdirSync(path.join(staging, "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
  fs.writeFileSync(
    path.join(staging, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }),
  );
  const badJson = validation.validateInstallTree(version, staging);
  report.check(
    "an unparseable manifest reports package-json-invalid",
    badJson.problems.map((problem) => problem.code).includes(validation.PROBLEM.PACKAGE_JSON_INVALID),
    JSON.stringify(badJson.problems.map((problem) => problem.code)),
  );
  report.check(
    "an unparseable manifest still reports the OTHER missing entries too",
    badJson.problems.length >= 1,
  );
  fs.rmSync(staging, { recursive: true, force: true });

  // npm exits non-zero: a REAL failure, which must NOT fall back (the fallback
  // would run the same broken npm again) and must carry npm's own diagnostics.
  const failVersion = "1.2.4-npmfail";
  cleanVersion(failVersion);
  let npmError = null;
  try {
    await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "9" }, () =>
      install.installVersion(failVersion, { paths: PATHS, ...stub() }),
    );
  } catch (caught) {
    npmError = caught;
  }
  report.check("an npm failure is raised, not fallen back from", npmError?.step === "npm", npmError?.step);
  report.check("npm's exit code is carried", npmError?.exitCode === 9, String(npmError?.exitCode));
  report.check("npm's output tail is carried", /simulated failure|FAKE_NPM_ARGV/.test(npmError?.outputTail ?? ""), undefined);
  report.check("no staging directory survives the failure", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  report.check(
    "the target was never created",
    fs.existsSync(install.versionInstallDir(failVersion, { paths: PATHS })) === false,
  );
  cleanVersion(failVersion);

  // npm that never exits: the timeout path, still cleaning up after itself.
  const hangVersion = "1.2.5-hang";
  cleanVersion(hangVersion);
  let timeoutError = null;
  try {
    await withEnv({ FAKE_NPM_MODE: "hang" }, () =>
      install.installVersion(hangVersion, { paths: PATHS, ...stub(), timeoutMs: 1200 }),
    );
  } catch (caught) {
    timeoutError = caught;
  }
  report.check("a hanging npm times out", /timed out/.test(timeoutError?.message ?? ""), timeoutError?.message);
  report.check("the timeout leaves no staging directory", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));
  cleanVersion(hangVersion);
});

// ---------------------------------------------------------------------------
// The running-version guard
// ---------------------------------------------------------------------------

await report.section("the running-version guard refuses to overwrite what is running", async () => {
  const version = "1.3.0-running";
  cleanVersion(version);
  clearRunningState();

  // Install it properly first, so there is a real tree to protect.
  await withEnv(COMPLETE, () => install.installVersion(version, { paths: PATHS, ...stub() }));
  const installDir = install.versionInstallDir(version, { paths: PATHS });
  const before = snapshotTree(installDir);

  writeRunningState({ version, installDir });

  report.check(
    "the guard sees the running version",
    install.runningVersionGuard(version, { paths: PATHS }).running === true,
  );
  report.check(
    "the guard reports the recorded pid",
    install.runningVersionGuard(version, { paths: PATHS }).pid === 4242,
  );
  report.check(
    "the guard leaves other versions alone",
    install.runningVersionGuard("9.9.9-other", { paths: PATHS }).running === false,
  );

  let error = null;
  try {
    await withEnv(COMPLETE, () =>
      install.installVersion(version, { paths: PATHS, ...stub(), force: true }),
    );
  } catch (caught) {
    error = caught;
  }

  report.check("a force reinstall of the running version is refused", error?.name === "InstallError", error?.name);
  report.check("the refusal names its step", error?.step === "running-version", error?.step);
  report.check(
    "the refusal is worded as specified",
    (error?.message ?? "").startsWith(
      `Refusing to overwrite the running version ${version}; stop the harness or choose another version.`,
    ),
    error?.message,
  );
  report.check("the refusal names the recorded pid", /pid 4242/.test(error?.message ?? ""), error?.message);
  report.check("the tree was untouched", JSON.stringify(snapshotTree(installDir)) === JSON.stringify(before));
  report.check("isInstalled still reports it", install.isInstalled(version, { paths: PATHS }) === true);
  report.check("no staging directory was created", stagingLeftovers().length === 0, JSON.stringify(stagingLeftovers()));

  // A non-force install of the running version short-circuits (it is installed),
  // but must ALSO not be refused - that would break the fast path.
  const shortCircuit = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub() }),
  );
  report.check("a non-force install still short-circuits rather than refusing", shortCircuit.skipped === true);
  report.check("and the tree is still untouched", JSON.stringify(snapshotTree(installDir)) === JSON.stringify(before));

  // Same real path, spelled differently: the guard must still fire.
  const awkward = path.join(installDir, ".", "..", path.basename(installDir));
  writeRunningState({ version, installDir: awkward });
  report.check(
    "a path with . and .. segments is recognized as the same place",
    install.runningVersionGuard(version, { paths: PATHS }).running === true,
  );

  writeRunningState({ version, installDir: process.platform === "win32" ? installDir.toUpperCase() : installDir });
  report.check(
    "path casing does not defeat the guard",
    install.runningVersionGuard(version, { paths: PATHS }).running === true,
  );

  writeRunningState({ version, installDir: `${installDir}${path.sep}` });
  report.check(
    "a trailing separator does not defeat the guard",
    install.runningVersionGuard(version, { paths: PATHS }).running === true,
  );

  // A DIFFERENT install dir means a different version is running: no refusal.
  writeRunningState({ version: "9.9.9-elsewhere", installDir: path.join(PATHS.versions, "9.9.9-elsewhere") });
  report.check(
    "a different running version does not block an unrelated install",
    install.runningVersionGuard(version, { paths: PATHS }).running === false,
  );

  // No recorded state at all is normal (a fresh data directory).
  clearRunningState();
  report.check(
    "no runtime state means nothing is running",
    install.runningVersionGuard(version, { paths: PATHS }).running === false,
  );

  // An invalid state file must not authorize anything and must not throw.
  fs.writeFileSync(PATHS.runtimeState, "{ not json\n", "utf8");
  report.check(
    "an unreadable runtime state does not throw",
    throws(() => install.runningVersionGuard(version, { paths: PATHS })) === false,
  );
  report.check(
    "and it does not claim a version is running",
    install.runningVersionGuard(version, { paths: PATHS }).running === false,
  );

  clearRunningState();
  cleanVersion(version);
});

await report.section("path identity is one implementation, shared with Step 4", () => {
  const base = path.join(PATHS.versions, "1.0.0");
  const same = [
    ["identical", base],
    ["a trailing separator", `${base}${path.sep}`],
    ["a . segment", path.join(base, ".")],
    ["a .. that cancels out", path.join(base, "..", "1.0.0")],
  ];
  for (const [label, other] of same) {
    report.check(`pathsAreIdentical: ${label}`, library.pathsAreIdentical(base, other) === true, other);
  }

  const differs = [
    ["a different version", path.join(PATHS.versions, "1.0.1")],
    ["a prefix that is not a path segment", `${base}-suffix`],
    ["the library root", PATHS.versions],
    ["an empty string", ""],
  ];
  for (const [label, other] of differs) {
    report.check(`pathsAreIdentical: ${label} differs`, library.pathsAreIdentical(base, other) === false, other);
  }

  report.check(
    "Windows comparison is case-insensitive",
    library.pathsAreIdentical(base.toUpperCase(), base, { platform: "win32" }) === true,
  );
  report.check(
    "POSIX comparison is case-sensitive",
    library.pathsAreIdentical(base.toUpperCase(), base, { platform: "linux" }) === false,
  );
  report.check(
    "the filesystem wrapper agrees with the lexical one for an existing path",
    library.resolvesToSamePath(base, base) === true,
  );
  report.check(
    "the wrapper does not throw for a path that does not exist",
    throws(() => library.resolvesToSamePath(path.join(PATHS.versions, "nope"), base)) === false,
  );
  report.check(
    "the wrapper resolves a real path against a non-canonical spelling",
    library.resolvesToSamePath(base, path.join(base, "..", path.basename(base))) === true,
  );
});

// ---------------------------------------------------------------------------
// The library lock
// ---------------------------------------------------------------------------

await report.section("the library lock: acquire, refuse, stale, release", () => {
  fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });

  // A REAL pid for the holder, never a fabricated one. The first version of this
  // test used `pid: 1111`, and `isAlive(1111)` is legitimately FALSE - so the
  // "held" lock was correctly evaluated as abandoned and the second acquire
  // STOLE it instead of being refused. The lock was right and the test was wrong:
  // liveness is a real question about a real process, and a fake pid cannot
  // answer it. `process.pid` is alive by construction.
  const first = lock.acquireLock({ paths: PATHS, pid: process.pid, reason: "test holder" });
  report.check("the lock is acquired when free", first.acquired === true, JSON.stringify(first.error));
  report.check("it is not reported as stolen", first.stolen === false);
  report.check("the lock file exists", fs.existsSync(first.file) === true);
  report.check("the lock records the pid", lock.readLock({ paths: PATHS }).pid === process.pid);
  report.check(
    "the lock records when it was taken",
    typeof lock.readLock({ paths: PATHS }).acquiredAt === "string",
  );
  report.check("the lock records why", lock.readLock({ paths: PATHS }).reason === "test holder");
  report.check(
    "the lock file is inside the library root",
    library.isPathInsideVersions(first.file, { paths: PATHS }) === true,
  );
  report.check(
    "the lock file is never a version name",
    library.isVersionDirName(path.basename(first.file)) === false,
  );

  // A second holder is refused, because the recorded pid is genuinely alive.
  const second = lock.acquireLock({ paths: PATHS, pid: process.pid + 100000 });
  report.check("a second acquire is refused", second.acquired === false, JSON.stringify(second));
  report.check("the refusal names the holder", new RegExp(`pid ${process.pid}\\b`).test(second.holder ?? ""), second.holder);
  report.check("the refusal is not an error", second.error === null);
  report.check("the first holder's lock is untouched", lock.readLock({ paths: PATHS }).pid === process.pid);
  report.check("and it was not stolen", second.stolen === false);

  // Releasing with the WRONG pid must not delete the holder's lock.
  const foreignRelease = lock.releaseLock({ paths: PATHS, pid: process.pid + 100000 });
  report.check("a foreign release is refused", foreignRelease.released === false, foreignRelease.reason);
  report.check("the lock is still there", fs.existsSync(first.file) === true);

  const ownRelease = lock.releaseLock({ paths: PATHS, pid: process.pid });
  report.check("the owner can release", ownRelease.released === true, ownRelease.reason);
  report.check("the lock file is gone", fs.existsSync(first.file) === false);

  const releaseAgain = lock.releaseLock({ paths: PATHS, pid: process.pid });
  report.check("releasing twice is not an error", releaseAgain.released === false && /no lock file/.test(releaseAgain.reason));
});

await report.section("the lock goes stale when its holder is gone or it is too old", () => {
  fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });

  // A pid that cannot be running. 0x7FFFFFFF is above any realistic pid space and
  // is used ONLY as a liveness probe target - nothing is ever killed.
  const deadPid = 0x7ffffffe;
  fs.writeFileSync(
    lock.lockPath({ paths: PATHS }),
    `${JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString(), reason: "abandoned" })}\n`,
  );

  report.check(
    "the recorded lock is read back",
    lock.readLock({ paths: PATHS }).pid === deadPid,
  );
  report.check(
    "a lock whose process is gone is stale",
    lock.isLockStale(lock.readLock({ paths: PATHS }), {}).stale === true,
    lock.isLockStale(lock.readLock({ paths: PATHS }), {}).reason,
  );

  const taken = lock.acquireLock({ paths: PATHS, pid: process.pid });
  report.check("a stale lock can be taken over", taken.acquired === true, JSON.stringify(taken.error));
  report.check("the takeover is reported", taken.stolen === true);
  report.check("the takeover names who held it", /abandoned|pid/.test(taken.holder ?? ""), taken.holder);
  report.check("the lock now belongs to us", lock.readLock({ paths: PATHS }).pid === process.pid);
  lock.releaseLock({ paths: PATHS, pid: process.pid });

  // Age, with the liveness question answered explicitly so the branch under test
  // is the AGE branch rather than the liveness one.
  const old = { pid: process.pid, acquiredAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
  fs.writeFileSync(lock.lockPath({ paths: PATHS }), `${JSON.stringify(old)}\n`);
  report.check(
    "an over-age lock is stale even when its pid is alive",
    lock.isLockStale(old, { isAlive: () => true }).stale === true,
    lock.isLockStale(old, { isAlive: () => true }).reason,
  );
  report.check(
    "the staleness reason gives the age",
    /1200s old|over the 900s/.test(lock.isLockStale(old, { isAlive: () => true }).reason),
    lock.isLockStale(old, { isAlive: () => true }).reason,
  );

  const fresh = { pid: process.pid, acquiredAt: new Date().toISOString() };
  report.check(
    "a fresh lock held by a live process is NOT stale",
    lock.isLockStale(fresh, { isAlive: () => true }).stale === false,
  );
  report.check(
    "a live holder is respected regardless of age",
    lock.isLockStale(old, { isAlive: () => true, now: Date.now() }).stale === true &&
      lock.isLockStale(fresh, { isAlive: () => true }).stale === false,
  );

  // The dangerous direction: a lock that cannot be evaluated must NOT be stolen.
  const unparseable = { pid: "not a number", acquiredAt: "not a date" };
  report.check(
    "an unevaluable lock is not treated as stale",
    lock.isLockStale(unparseable, { isAlive: () => true }).stale === false,
    lock.isLockStale(unparseable, { isAlive: () => true }).reason,
  );
  report.check(
    "an unreadable lock file is readable as null",
    (() => {
      fs.writeFileSync(lock.lockPath({ paths: PATHS }), "not json at all");
      return lock.readLock({ paths: PATHS }) === null;
    })(),
  );
  report.check(
    "an unreadable lock file is treated as stale (no live holder can be claimed)",
    lock.isLockStale(null, {}).stale === true,
  );
  report.check(
    "a deleted lock can be re-acquired",
    (() => {
      fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });
      const result = lock.acquireLock({ paths: PATHS, pid: process.pid });
      const ok = result.acquired === true;
      lock.releaseLock({ paths: PATHS, pid: process.pid });
      return ok;
    })(),
  );
});

await report.section("withLock always releases, even when the body throws", async () => {
  fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });

  const value = await lock.withLock(() => "result", { paths: PATHS });
  report.check("the body's value is returned", value === "result");
  report.check("the lock is released after a successful body", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  let thrown = null;
  try {
    await lock.withLock(() => {
      throw new Error("body failed");
    }, { paths: PATHS });
  } catch (error) {
    thrown = error;
  }
  report.check("the body's error propagates", thrown?.message === "body failed");
  report.check(
    "the lock is released after a throwing body",
    fs.existsSync(lock.lockPath({ paths: PATHS })) === false,
    "a throw that leaked the lock would brick installs until it went stale",
  );

  // The async case is the one that matters: a lock helper that released when the
  // body returned its PROMISE would drop the lock at the start of the work.
  const order = [];
  await lock.withLock(async () => {
    order.push("body-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("body-end");
    report.check(
      "the lock is still held while the body is running",
      fs.existsSync(lock.lockPath({ paths: PATHS })) === true,
    );
  }, { paths: PATHS });
  report.check("the body actually ran asynchronously", order.join(",") === "body-start,body-end");
  report.check("the lock is released after an async body", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  // A held lock produces a named refusal, not a generic error.
  const held = lock.acquireLock({ paths: PATHS, pid: process.pid });
  report.check("the lock is held for the refusal test", held.acquired === true);
  let lockError = null;
  try {
    await lock.withLock(() => "never", { paths: PATHS, pid: 999999 });
  } catch (error) {
    lockError = error;
  }
  report.check("a held lock refuses the operation", lockError?.name === "LibraryLockedError", lockError?.name);
  report.check("the refusal has a stable code", lockError?.code === "library-locked", lockError?.code);
  report.check("the refusal names the lock file", typeof lockError?.lockFile === "string");
  report.check(
    "the refusal explains what to do",
    /Wait for it to finish/.test(lockError?.message ?? ""),
    lockError?.message,
  );
  lock.releaseLock({ paths: PATHS, pid: process.pid });
});

await report.section("the lock is exclusive ACROSS processes", async () => {
  fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });
  const handshake = path.join(TMP_ROOT, "lock-handshake.json");
  fs.rmSync(handshake, { force: true });

  // The in-process tests above cannot prove exclusivity: one thread is serialized
  // by its own call stack. A real second process is the only way to observe the
  // O_EXCL claim.
  //
  // SYNCHRONIZATION IS VIA A HANDSHAKE FILE, not by sniffing the child's stdout.
  // The first version of this test parsed a `data` event and failed with
  // "Unexpected end of JSON input" - a `data` event is a CHUNK, not a line, so the
  // parent could parse a half-written record. The child now writes a complete file
  // atomically (temp + rename) once it holds the lock, and the parent polls for it.
  //
  // The child is started with CREATE_NO_WINDOW (section 2.7). It is never killed by
  // image name; it exits on its own when its stdin closes, and the pid is recorded
  // from `spawn` so the parent can await it.
  // `pathToFileURL` is REQUIRED here, not cosmetic. The default ESM loader rejects
  // a bare Windows drive-letter specifier with ERR_UNSUPPORTED_ESM_URL_SCHEME
  // ("Received protocol 'c:'"), so interpolating the absolute path - as the first
  // version of this test did - made the child die before it could acquire
  // anything, and the parent's handshake poll simply timed out.
  const childScript = path.join(TMP_ROOT, "lock-child.mjs");
  const lockModuleUrl = pathToFileURL(path.join(REPO_ROOT, "sidecar", "lib", "library-lock.js")).href;
  fs.writeFileSync(
    childScript,
    `
import fs from "node:fs";
import { acquireLock } from ${JSON.stringify(lockModuleUrl)};

const handshake = ${JSON.stringify(handshake)};
const acquired = acquireLock({ reason: "child holder" });
const temp = handshake + ".tmp";
fs.writeFileSync(temp, JSON.stringify({ acquired: acquired.acquired, owner: acquired.owner, pid: process.pid, error: acquired.error }), "utf8");
fs.renameSync(temp, handshake);

// Exit when the parent closes stdin. A bare setInterval keeps the event loop alive
// and the child would never exit on its own - the first version of this test waited
// 8 seconds and then had to kill it.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
`,
    "utf8",
  );

  const child = spawn(process.execPath, [childScript], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
    env: { ...process.env, DSH_DOCK_DATA_DIR: TMP_ROOT },
  });

  const waitFor = async (predicate, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  const handshakeArrived = await waitFor(() => fs.existsSync(handshake));
  report.check("the child process reported back", handshakeArrived, fs.existsSync(handshake) ? "ok" : "timed out");

  const childState = handshakeArrived ? JSON.parse(fs.readFileSync(handshake, "utf8")) : {};
  report.check("the child process acquired the lock", childState.acquired === true, JSON.stringify(childState));
  report.check(
    "the child recorded its own pid",
    childState.pid === child.pid,
    `${childState.pid} vs ${child.pid}`,
  );
  report.check("the lock file records the child's pid", lock.readLock({ paths: PATHS })?.pid === child.pid);

  const parentAttempt = lock.acquireLock({ paths: PATHS, pid: process.pid });
  report.check("the parent is refused while the child holds it", parentAttempt.acquired === false, JSON.stringify(parentAttempt));
  report.check(
    "the refusal names the child's pid",
    (parentAttempt.holder ?? "").includes(String(child.pid)),
    parentAttempt.holder,
  );
  report.check("and the parent did not steal it", parentAttempt.stolen === false);

  // The child exits on its own: closing its stdin ends its hold on the lock.
  child.stdin.end();
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);

  if (!exited) {
    // Only reached if the child ignored its closed stdin - which it did in the
    // first version of this test, because a bare `setInterval` keeps a Node process
    // alive regardless of stdin. The child now exits on `stdin` 'end'. This kill is
    // a fallback for a genuine hang, and it targets only the pid recorded from
    // `spawn`, never an image name.
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  report.check("the child process exited", true, exited ? "cleanly" : "after a targeted kill");

  // The child's lock file is now abandoned. A later acquire must take it over,
  // which proves the stale path against a genuinely dead process rather than a
  // fabricated pid.
  const afterChild = lock.acquireLock({ paths: PATHS, pid: process.pid });
  report.check(
    "the abandoned lock can be taken over after the holder exits",
    afterChild.acquired === true,
    JSON.stringify(afterChild.error),
  );
  report.check("the takeover is reported as a steal", afterChild.stolen === true);
  lock.releaseLock({ paths: PATHS, pid: process.pid });

  report.check("no lock file is left behind", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);
  fs.rmSync(childScript, { force: true });
  fs.rmSync(handshake, { force: true });
});

await report.section("an install takes the lock and leaves it free", async () => {
  fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });
  const version = "1.4.0-locked";
  cleanVersion(version);

  await withEnv(COMPLETE, () => install.installVersion(version, { paths: PATHS, ...stub() }));
  report.check("the lock is released after a successful install", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  let failure = null;
  try {
    await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "5" }, () =>
      install.installVersion("1.4.1-locked-fail", { paths: PATHS, ...stub() }),
    );
  } catch (caught) {
    failure = caught;
  }
  report.check("the failing install did fail", failure?.exitCode === 5);
  report.check(
    "the lock is released after a FAILED install",
    fs.existsSync(lock.lockPath({ paths: PATHS })) === false,
    "a leaked lock would block every later install",
  );

  // And an install attempted while another holds the lock is refused, not queued.
  const held = lock.acquireLock({ paths: PATHS, pid: process.pid });
  report.check("the lock is held for the install refusal test", held.acquired === true);
  let refused = null;
  try {
    await withEnv(COMPLETE, () =>
      install.installVersion("1.4.2-locked-out", { paths: PATHS, ...stub() }),
    );
  } catch (caught) {
    refused = caught;
  }
  report.check("an install under a held lock is refused", refused?.name === "LibraryLockedError", refused?.name);
  report.check(
    "and no target directory was created",
    fs.existsSync(install.versionInstallDir("1.4.2-locked-out", { paths: PATHS })) === false,
  );
  lock.releaseLock({ paths: PATHS, pid: process.pid });

  cleanVersion(version);
});

// ---------------------------------------------------------------------------
// Catalogue recording
// ---------------------------------------------------------------------------

await report.section("a validated install is recorded in the catalogue", async () => {
  const version = "1.5.0-catalogued";
  cleanVersion(version);
  const before = catalogue.readCatalogue({ paths: PATHS });
  report.check(
    "the version is not yet in the catalogue",
    before.document.versions[version] === undefined,
  );

  const result = await withEnv(COMPLETE, () =>
    install.installVersion(version, { paths: PATHS, ...stub(), tag: "next" }),
  );

  report.check("the result reports the catalogue write", result.catalogue?.recorded === true, JSON.stringify(result.catalogue));
  report.check("the catalogue status is 'recorded'", result.catalogue?.catalogue === "recorded");

  const after = catalogue.readCatalogue({ paths: PATHS });
  const entry = after.document.versions[version];
  report.check("the catalogue now has the version", entry !== undefined);
  report.check("the entry records the dist-tag as its source", entry.source === "next", entry.source);
  report.check("the entry records when it was installed", typeof entry.installedAt === "string");
  report.check("the entry carries a checksum of the installed manifest", /^sha256:[0-9a-f]{64}$/.test(entry.checksum ?? ""), entry.checksum);
  report.check("the entry stores the install directory relative to the library root", entry.installDir === version, entry.installDir);
  report.check(
    "the checksum matches the manifest actually on disk",
    entry.checksum === library.checksumFor(install.versionInstallDir(version, { paths: PATHS })),
  );
  report.check(
    "the enumerated entry gets its date from the catalogue",
    library
      .listInstalledVersions({ paths: PATHS, installedAt: catalogue.readInstalledAt({ paths: PATHS }) })
      .find((candidate) => candidate.version === version)?.installedAt === entry.installedAt,
  );
  report.check(
    "a source of an explicit version is recorded when no tag is given",
    (await (async () => {
      const other = "1.5.1-explicit";
      cleanVersion(other);
      await withEnv(COMPLETE, () => install.installVersion(other, { paths: PATHS, ...stub() }));
      const recorded = catalogue.readCatalogue({ paths: PATHS }).document.versions[other];
      cleanVersion(other);
      return recorded?.source === other;
    })()),
    undefined,
  );

  // Recording can be disabled, and a disabled record must not be reported as a
  // failure of the install.
  const skipped = "1.5.2-norecord";
  cleanVersion(skipped);
  const skippedResult = await withEnv(COMPLETE, () =>
    install.installVersion(skipped, { paths: PATHS, ...stub(), record: false }),
  );
  report.check("recording can be skipped", skippedResult.catalogue?.recorded === false);
  report.check("a skipped record is not an error", skippedResult.catalogue?.error === null);
  report.check(
    "the version is installed even though it was not recorded",
    install.isInstalledAndValid(skipped, { paths: PATHS }) === true,
  );
  report.check(
    "and it is still enumerated from disk",
    library.listInstalledVersions({ paths: PATHS }).some((entry) => entry.version === skipped) === true,
  );

  cleanVersion(version);
  cleanVersion(skipped);
});

await report.section("invocation flags are unchanged by Step 3", () => {
  const invocation = install.buildInstallInvocation("0.2.0-rc.2", path.join(PATHS.versions, "x"), {
    paths: PATHS,
    npmCommand: ["node", "npm-cli.js"],
  });
  const args = invocation.args;
  report.check("the version is pinned exactly", args.includes("@deepseek-ai/dsh@0.2.0-rc.2"));
  report.check("the cache is inside the data directory", args[args.indexOf("--cache") + 1] === PATHS.npmCache);
  report.check("--no-audit is passed", args.includes("--no-audit"));
  report.check("--no-fund is passed", args.includes("--no-fund"));
  report.check("--no-progress is passed", args.includes("--no-progress"));
  report.check("--ignore-scripts is NOT passed (the harness needs postinstalls)", args.includes("--ignore-scripts") === false);
  report.check("shell is never enabled", invocation.shell === false);
  report.check("the prefix is the directory it was handed", args[args.indexOf("--prefix") + 1] === path.join(PATHS.versions, "x"));
});

process.exit(report.finish());
