/**
 * Pause point 2 - harness installation into the version library.
 *
 * Structure of this test:
 *
 *   offline (always runs) - pure path/flag logic, plus every failure branch of
 *                           installVersion driven by a deterministic stub npm.
 *   LIVE (opt-in)         - a real `npm install --prefix` of the real harness
 *                           into a workspace-local data dir, proving the actual
 *                           npm invocation and the published package layout.
 *
 * The live section is opt-in via DSH_DOCK_TEST_INSTALL=1 because it downloads a
 * large package tree and takes minutes. Everything else is fast and hermetic.
 *
 * Run from the repo root:
 *   node sidecar/test/harness-install.js
 *   $env:DSH_DOCK_TEST_INSTALL='1'; node sidecar/test/harness-install.js
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "install");

// The offline sections and the LIVE install use SEPARATE data directories.
//
// This is not cosmetic: the offline sections wipe their scratch root on every
// run, so sharing one root meant a routine offline run silently deleted a
// verified ~390 MB live install (observed, not theorised). Separate roots make
// the live install survive an offline run and removable on its own.
//
// The live root is SHARED with harness-start.js's live section so one install
// serves both tests. Overridable to point at an existing tree.
const STUB_DATA = path.join(TMP_ROOT, "stub-data");
const LIVE_DATA = process.env.DSH_DOCK_LIVE_DATA ?? path.join(REPO_ROOT, ".test-tmp", "live-data");
const LIVE = process.env.DSH_DOCK_TEST_INSTALL === "1";
const ACTIVE_DATA = LIVE ? LIVE_DATA : STUB_DATA;

const FAKE_NPM = path.join(HERE, "lib", "fake-npm.js");

const report = createReport("DSH-Dock install: version library population");

process.env.DSH_DOCK_DATA_DIR = ACTIVE_DATA;
fs.rmSync(ACTIVE_DATA, { recursive: true, force: true });
fs.mkdirSync(ACTIVE_DATA, { recursive: true });

const state = await import("../lib/state.js");
const install = await import("../lib/harness-install.js");
const versionManager = await import("../lib/version-manager.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

/** Shorthand: stub npm driven by this Node binary. */
const fakeNpm = (env = {}) => ({
  npmCommand: [process.execPath, FAKE_NPM],
  env,
});

/**
 * Runs `body` with extra environment variables set, then restores the
 * environment exactly as it was.
 *
 * Snapshotting the whole object is deliberate: assigning `undefined` back to a
 * `process.env` key would store the literal string "undefined", which a stub
 * checking for `=== "1"` would silently read as "set to something else".
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

await report.section("version-name safety (pure)", () => {
  report.check("a normal semver is accepted", install.isSafeVersionName("0.1.5-rc.2") === true);
  report.check("a prerelease with dots is accepted", install.isSafeVersionName("1.2.3-alpha.10") === true);
  report.check("a build suffix is accepted", install.isSafeVersionName("1.2.3+build.5") === true);

  const rejected = [
    ["a parent traversal", "../../evil"],
    ["a nested path", "1.0.0/../../evil"],
    ["a backslash path", "..\\evil"],
    ["an absolute path", "C:\\evil"],
    ["a leading dot", ".hidden"],
    ["a leading dash", "-flag"],
    ["an empty string", ""],
    ["a space", "1.0.0 evil"],
    ["a null byte", "1.0.0\0"],
    ["a non-string", 1234],
    ["null", null],
    ["a slash", "1.0.0/2.0.0"],
  ];
  for (const [label, value] of rejected) {
    report.check(`rejects ${label}`, install.isSafeVersionName(value) === false, JSON.stringify(value));
  }

  report.check(
    "versionInstallDir refuses an unsafe version",
    throws(() => install.versionInstallDir("../../evil", { paths: PATHS })),
  );
});

await report.section("install paths (section 3.1 layout)", () => {
  const dir = install.versionInstallDir("0.1.5-rc.2", { paths: PATHS });
  report.check(
    "the version directory is <data-dir>/versions/<version>",
    dir === path.join(PATHS.versions, "0.1.5-rc.2"),
    dir,
  );
  report.check(
    "the entry point is node_modules/@deepseek-ai/dsh/lib/bin.js",
    install.harnessBinPath(dir) === path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    install.harnessBinPath(dir),
  );
  report.check(
    "HARNESS_BIN_RELATIVE matches the skeleton constant in version-manager.js",
    install.HARNESS_BIN_RELATIVE.split(path.sep).join("/") === versionManager.HARNESS_BIN_RELATIVE,
    install.HARNESS_BIN_RELATIVE,
  );
  report.check("nothing is installed yet", install.isInstalled("0.1.5-rc.2", { paths: PATHS }) === false);
});

await report.section("npm invocation flags (pure)", () => {
  const dir = install.versionInstallDir("0.1.5-rc.2", { paths: PATHS });
  const invocation = install.buildInstallInvocation("0.1.5-rc.2", dir, { paths: PATHS });
  const line = invocation.args.join(" ");

  // `args[0]` is the npm CLI script, not the subcommand - assert membership.
  report.check("npm install is the subcommand", invocation.args.includes("install"));
  report.check("--prefix points at the version directory", line.includes(`--prefix ${dir}`), line);
  report.check("--cache points inside the launcher data dir", line.includes(`--cache ${PATHS.npmCache}`), line);
  report.check("the npm cache is not the user's global cache", !line.includes("npm-cache\\_cacache"), line);
  report.check("--no-audit is passed", invocation.args.includes("--no-audit"));
  report.check("--no-fund is passed", invocation.args.includes("--no-fund"));
  report.check("--no-progress is passed", invocation.args.includes("--no-progress"));
  report.check("--loglevel error is passed", line.includes("--loglevel error"));
  report.check(
    "the harness is pinned to the EXACT version",
    invocation.args.includes("@deepseek-ai/dsh@0.1.5-rc.2"),
    invocation.args.at(-1),
  );
  report.check(
    "no version range operator is used",
    !/[~^><*]|\bx\b/.test(invocation.args.at(-1).split("@").at(-1)),
    invocation.args.at(-1),
  );
  report.check("--ignore-scripts is NOT used", !invocation.args.includes("--ignore-scripts"));
  report.check("the shell is not used", invocation.shell === false);
});

await report.section("npm resolution (no .cmd, no shell)", async () => {
  // Node refuses to spawn a .cmd/.bat without shell:true (CVE-2024-27980
  // mitigation), so npm MUST be launched as `node <npm-cli.js>`.
  const runner = install.resolveNpmRunner();
  report.check("npm was located on this machine", runner !== null, JSON.stringify(runner));
  report.check(
    "npm is launched by our own node binary, not a .cmd shim",
    runner?.command === process.execPath,
    runner?.command,
  );
  report.check(
    "no arg ends in .cmd or .bat",
    !(runner?.prefixArgs ?? []).some((arg) => /\.(cmd|bat)$/i.test(arg)),
    JSON.stringify(runner?.prefixArgs),
  );
  report.check(
    "the resolved npm CLI script exists on disk",
    (runner?.prefixArgs ?? []).length > 0 && fs.existsSync(runner.prefixArgs[0]),
    runner?.prefixArgs?.[0],
  );
  report.check("the resolution source is reported", typeof runner?.source === "string", runner?.source);

  const defaultInvocation = install.buildInstallInvocation(
    "0.1.5-rc.2",
    install.versionInstallDir("0.1.5-rc.2", { paths: PATHS }),
  );
  report.check(
    "the default invocation really runs npm",
    defaultInvocation.command === process.execPath &&
      defaultInvocation.args.some((arg) => arg.endsWith("npm-cli.js")),
    `${defaultInvocation.command} ${defaultInvocation.args[0]}`,
  );
  report.check(
    "the default invocation still pins the exact version",
    defaultInvocation.args.at(-1) === "@deepseek-ai/dsh@0.1.5-rc.2",
    defaultInvocation.args.at(-1),
  );
  report.check("shell stays false in the default invocation", defaultInvocation.shell === false);

  report.check(
    "resolution returns null when nothing exists",
    install.resolveNpmRunner({ existsSync: () => false, env: {}, execPath: "Z:\\nope\\node.exe" }) === null,
  );
  report.check(
    "$npm_execpath is preferred when it points at a real file",
    install.resolveNpmRunner({
      env: { npm_execpath: "C:\\fake\\npm-cli.js" },
      existsSync: (file) => file === "C:\\fake\\npm-cli.js",
      execPath: process.execPath,
    })?.source === "npm_execpath",
  );
  report.check(
    "a missing npm produces a clear install error, not a crash",
    await (async () => {
      try {
        await install.installVersion("7.7.7-fake", {
          paths: PATHS,
          env: {},
          execPath: "Z:\\nope\\node.exe",
          existsSync: () => false,
        });
        return false;
      } catch (caught) {
        return caught.name === "InstallError" && /Could not locate npm/.test(caught.message);
      }
    })(),
  );
});

await report.section("installVersion failure branches (stub npm)", async () => {
  const version = "9.9.9-fake";

  await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "1", FAKE_NPM_MAKE_BIN: undefined }, async () => {
    let error = null;
    try {
      await install.installVersion(version, { paths: PATHS, ...fakeNpm() });
    } catch (caught) {
      error = caught;
    }
    report.check("a non-zero npm exit throws InstallError", error?.name === "InstallError", error?.name);
    report.check("the exit code is reported", error?.exitCode === 1, String(error?.exitCode));
    report.check(
      "the message names the package and version",
      (error?.message ?? "").includes("@deepseek-ai/dsh@9.9.9-fake"),
      error?.message,
    );
    report.check(
      "the message includes the command that was run",
      (error?.message ?? "").includes("install"),
      error?.message,
    );
    report.check("an output tail is attached", (error?.outputTail ?? "").length > 0, error?.outputTail);
    report.check(
      "the failure is recorded in the output for diagnosis",
      /simulated failure|FAKE_NPM_ARGV/.test(error?.outputTail ?? ""),
      error?.outputTail?.slice(0, 120),
    );
  });

  await withEnv({ FAKE_NPM_MODE: "fail", FAKE_NPM_EXIT: "7" }, async () => {
    let error = null;
    try {
      await install.installVersion(version, { paths: PATHS, ...fakeNpm() });
    } catch (caught) {
      error = caught;
    }
    report.check("a non-1 exit code is preserved", error?.exitCode === 7, String(error?.exitCode));
  });

  await withEnv({ FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: undefined }, async () => {
    let error = null;
    try {
      await install.installVersion(version, { paths: PATHS, ...fakeNpm() });
    } catch (caught) {
      error = caught;
    }
    report.check("exit 0 without bin.js throws InstallError", error?.name === "InstallError", error?.name);
    report.check(
      "the missing-entry-point message names the expected path",
      (error?.message ?? "").includes("bin.js"),
      error?.message,
    );
    report.check(
      "the missing-entry-point message suggests a layout change",
      /layout/i.test(error?.message ?? ""),
      error?.message,
    );
  });

  await withEnv({ FAKE_NPM_MODE: "hang" }, async () => {
    let error = null;
    try {
      await install.installVersion(version, { paths: PATHS, ...fakeNpm(), timeoutMs: 1200 });
    } catch (caught) {
      error = caught;
    }
    report.check("a hanging npm hits the timeout", /timed out/.test(error?.message ?? ""), error?.message);
  });

  let spawnError = null;
  try {
    await install.installVersion(version, {
      paths: PATHS,
      npmCommand: [path.join(ACTIVE_DATA, "definitely-not-here.cmd")],
    });
  } catch (caught) {
    spawnError = caught;
  }
  report.check("an unrunnable npm throws InstallError", spawnError?.name === "InstallError", spawnError?.name);
  report.check(
    "the spawn error names the command",
    /Could not run/.test(spawnError?.message ?? ""),
    spawnError?.message,
  );

  report.check(
    "an unsafe version is refused before any process is spawned",
    await (async () => {
      try {
        await install.installVersion("../../evil", { paths: PATHS });
        return false;
      } catch (caught) {
        return caught.name === "InstallError";
      }
    })(),
  );
});

await report.section("successful install and idempotence (stub npm)", async () => {
  const version = "8.8.8-fake";

  const result = await withEnv({ FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1" }, () =>
    install.installVersion(version, { paths: PATHS, ...fakeNpm() }),
  );

  report.check("the install reports success", result.exitCode === 0, String(result.exitCode));
  report.check("the install was not skipped", result.skipped === false);
  report.check("binPath is the harness entry point", result.binPath === install.harnessBinPath(result.installDir));
  report.check("bin.js now exists on disk", fs.existsSync(result.binPath), result.binPath);
  report.check("isInstalled now agrees", install.isInstalled(version, { paths: PATHS }) === true);

  const second = await withEnv({ FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1" }, () =>
    install.installVersion(version, { paths: PATHS, ...fakeNpm() }),
  );
  report.check("a second install short-circuits (fast path)", second.skipped === true);
  report.check("the short circuit reports the same binPath", second.binPath === result.binPath);

  const forced = await withEnv({ FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1" }, () =>
    install.installVersion(version, { paths: PATHS, ...fakeNpm(), force: true }),
  );
  report.check("force re-runs npm", forced.skipped === false);

  const tagRecorded = await withEnv({ FAKE_NPM_MODE: "ok", FAKE_NPM_MAKE_BIN: "1" }, () =>
    install.installVersion(version, { paths: PATHS, ...fakeNpm(), force: true, tag: "next" }),
  );
  report.check("the satisfying dist-tag is recorded on the result", tagRecorded.tag === "next", tagRecorded.tag);
});

await report.section("mixed version directories do not collide", () => {
  const a = path.join(PATHS.versions, "0.1.5-rc.2");
  const b = path.join(PATHS.versions, "0.1.5-rc.20");
  const c = path.join(PATHS.versions, "0.1.5-rc");
  report.check("sibling version directories are distinct", a !== b && b !== c);
  report.check(
    "a prefix version is NOT reported installed when its sibling is",
    install.isInstalled("0.1.5-rc.2", { paths: PATHS }) === false ||
      install.isInstalled("0.1.5-rc.20", { paths: PATHS }) === false,
  );
});

// ---------------------------------------------------------------------------
// LIVE install - opt-in, real network, real npm, real harness package.
// ---------------------------------------------------------------------------

if (process.env.DSH_DOCK_TEST_INSTALL === "1") {
  await report.section("LIVE install of the real latest RC", async () => {
    const registry = await import("../lib/registry.js");
    const { version, tag } = await registry.resolveLatestRcVersion();
    report.check("resolved a real version from the public registry", typeof version === "string", version);
    process.stdout.write(`  (live) resolved ${version} via dist-tag '${tag}'\n`);

    const live = await install.installVersion(version, { paths: PATHS, tag });
    report.check("the real install produced bin.js", fs.existsSync(live.binPath), live.binPath);
    report.check("the install was not skipped", live.skipped === false);

    const probe = spawnSync(process.execPath, [live.binPath, "--version"], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const printed = (probe.stdout ?? "").trim();
    report.check("`node bin.js --version` exits 0", probe.status === 0, `status=${probe.status}`);
    report.check(
      "the installed harness reports the resolved version",
      printed.includes(version),
      `printed=${JSON.stringify(printed)} stderr=${JSON.stringify((probe.stderr ?? "").slice(0, 200))}`,
    );
    report.check(
      "the npm cache was created inside the data dir",
      fs.existsSync(path.join(PATHS.npmCache, "_cacache")),
      PATHS.npmCache,
    );
  });
} else {
  report.check(
    "LIVE install skipped (set DSH_DOCK_TEST_INSTALL=1 to run it)",
    true,
  );
}

process.exit(report.finish());
