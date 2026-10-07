/**
 * Step 5 - the LIVE tier: a real npm install of two real published harness
 * versions into a scratch library, proving the Phase 2A library end to end.
 *
 * WHY TWO VERSIONS. One version proves staged install + validation + catalogue +
 * enumeration. TWO prove the thing 2A actually exists for: that the library holds
 * N versions side by side and enumerates them independently. A single-version live
 * test would pass against the pre-Phase-2 single-version layout.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT:
 *   - REAL: npm (invoked as `node <npm-cli.js>`, never a `.cmd`), the network, the
 *     published `@deepseek-ai/dsh` tarballs, the install tree, the rename, the
 *     catalogue on disk.
 *   - NOT REAL: no harness is ever spawned or killed, and `$DSH_HOME` is never
 *     touched (it is not read, written or passed anywhere by this file).
 *
 * GATE: `RUN_LIVE=1` (the Phase 2 plan's name). `DSH_DOCK_TEST_INSTALL=1` is ALSO
 * accepted, because that is the existing sidecar convention and silently skipping
 * an explicitly-requested ~12-minute network test is the more expensive mistake.
 * Either way the run is announced loudly at the top of the output.
 *
 *   node sidecar/test/library-live.js
 *   $env:RUN_LIVE='1'; node sidecar/test/library-live.js
 *   $env:DSH_DOCK_LIVE_DATA='C:\some\where'; $env:RUN_LIVE='1'; node sidecar/test/library-live.js
 *
 * SAFETY, checked before anything else runs:
 *   1. The resolved data directory must be under the OS temp root (or under the
 *      repo's .test-tmp), and must NOT be under %LOCALAPPDATA%. If it is not, the
 *      run REFUSES TO START - the user's live DSH-Dock install is in
 *      %LOCALAPPDATA%\DSH-Dock\ and is running the session this is written from.
 *   2. Every path written is inside that data directory. npm's cache is redirected
 *      into it with `--cache`, so the user's global npm cache is never used.
 *   3. The scratch library is PRESERVED after a successful run, so both version
 *      trees can be inspected afterwards. `.test-tmp/` is gitignored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const DEFAULT_LIVE_DATA = path.join(REPO_ROOT, ".test-tmp", "library-live");

const report = createReport("DSH-Dock library: LIVE install of two real versions");

const GATE_RUN_LIVE = process.env.RUN_LIVE === "1";
const GATE_TEST_INSTALL = process.env.DSH_DOCK_TEST_INSTALL === "1";

if (!GATE_RUN_LIVE && !GATE_TEST_INSTALL) {
  report.check(
    "LIVE install skipped (set RUN_LIVE=1 to run it)",
    true,
    "this test downloads ~370 MB per version and takes minutes; it is opt-in",
  );
  process.exit(report.finish());
}

const LIVE_DATA = path.resolve(process.env.DSH_DOCK_LIVE_DATA ?? DEFAULT_LIVE_DATA);
process.env.DSH_DOCK_DATA_DIR = LIVE_DATA;

// --- the safety gate, BEFORE any import that could resolve a path -------------

const TEMP_ROOTS = [path.resolve(os.tmpdir()), path.resolve(REPO_ROOT, ".test-tmp")];
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : null;

const sameOrUnder = (candidate, root) => {
  const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const rootNormalized = process.platform === "win32" ? root.toLowerCase() : root;
  return normalized === rootNormalized || normalized.startsWith(rootNormalized + path.sep);
};

const underTemp = TEMP_ROOTS.some((root) => sameOrUnder(LIVE_DATA, root));
const underLocalAppData = LOCAL_APP_DATA !== null && sameOrUnder(LIVE_DATA, LOCAL_APP_DATA);

console.log(`data dir:        ${LIVE_DATA}`);
console.log(`temp roots:      ${TEMP_ROOTS.join(", ")}`);
console.log(`LOCALAPPDATA:    ${LOCAL_APP_DATA ?? "(unset)"}`);
console.log(`gate:            ${GATE_RUN_LIVE ? "RUN_LIVE=1" : "DSH_DOCK_TEST_INSTALL=1"}\n`);

if (underLocalAppData || !underTemp) {
  // A hard refusal, not a warning. Continuing would install into, or delete from,
  // the directory holding the user's running harness.
  report.check(
    "the data directory is inside a temp root and NOT inside %LOCALAPPDATA%",
    false,
    `REFUSING TO RUN: ${LIVE_DATA} is ${underLocalAppData ? "inside %LOCALAPPDATA%" : "not under any temp root"}. ` +
      `Set DSH_DOCK_LIVE_DATA to a path under ${TEMP_ROOTS[0]}.`,
  );
  process.exit(report.finish());
}

report.check("the data directory is inside a temp root", underTemp, LIVE_DATA);
report.check("the data directory is not inside %LOCALAPPDATA%", underLocalAppData === false);

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");
const catalogue = await import("../lib/catalogue.js");
const install = await import("../lib/harness-install.js");
const validation = await import("../lib/validation.js");
const registry = await import("../lib/registry.js");

const PATHS = state.resolveStatePaths();
report.check(
  "the resolved state paths agree with the requested data dir",
  path.resolve(PATHS.root) === LIVE_DATA,
  PATHS.root,
);
report.check(
  "npm's cache is redirected inside the data dir",
  path.resolve(PATHS.npmCache).startsWith(LIVE_DATA),
  PATHS.npmCache,
);

// --- pick two real published versions ---------------------------------------

/**
 * Reads the packument straight from the registry and returns published versions,
 * newest first. Uses the product's own registry client rather than a bespoke fetch,
 * so this exercises `registry.js` too and cannot drift from how the launcher reads
 * the same document.
 */
async function publishedVersions() {
  const packument = await registry.fetchPackument("@deepseek-ai/dsh", { retries: 1 });
  const versions = Object.keys(packument.versions ?? {});
  return { packument, versions };
}

let chosen = [];
try {
  const { packument, versions } = await publishedVersions();

  const distTags = packument["dist-tags"] ?? {};
  console.log(`registry dist-tags: ${JSON.stringify(distTags)}`);
  console.log(`published versions: ${versions.length} total`);
  console.log(`  newest 12: ${versions.slice(-12).join(", ")}\n`);

  report.check("the registry returned published versions", versions.length > 0, String(versions.length));
  report.check(
    "every published version passes Phase 2A's version-name rule",
    versions.every((version) => install.isSafeVersionName(version)),
    versions.filter((version) => !install.isSafeVersionName(version)).join(", ") || "all valid",
  );

  // Prefer the two newest versions, but allow an explicit pin so the pair can be
  // chosen deliberately: consecutive RCs of the same channel are the ideal
  // coexistence test (same codebase, different versions, both real).
  //
  //   $env:DSH_DOCK_LIVE_VERSIONS='0.2.0-rc.1,0.2.0-rc.2'
  const pinned = (process.env.DSH_DOCK_LIVE_VERSIONS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (pinned.length > 0) {
    const unknown = pinned.filter((version) => !versions.includes(version));
    report.check(
      "every pinned version is actually published",
      unknown.length === 0,
      unknown.length > 0 ? `not published: ${unknown.join(", ")}` : pinned.join(", "),
    );
    if (unknown.length > 0) process.exit(report.finish());
    chosen = pinned;
  } else {
    chosen = versions.slice(-2).reverse();
  }

  console.log(`target versions: ${chosen.join(" and ")}\n`);
} catch (error) {
  report.check("the registry could be reached", false, `${error.name}: ${error.message}`);
  process.exit(report.finish());
}

fs.mkdirSync(PATHS.root, { recursive: true });
const startedAll = Date.now();

// --- install each version ---------------------------------------------------

for (const version of chosen) {
  console.log(`${"-".repeat(72)}\ninstalling ${version}\n${"-".repeat(72)}`);

  const before = catalogue.readInstalledAt({ paths: PATHS });
  const alreadyPresent = before[version] !== undefined;

  // A RE-RUN IS NOT A FRESH RUN, and the test must not pretend otherwise. The first
  // execution installed both versions; running it again against the preserved
  // library exercises the idempotent path instead. Asserting "it installed" on that
  // second run would fail for a correct implementation - which is what the first
  // version of this loop did. So the two cases are separated explicitly.
  if (alreadyPresent) {
    console.log(`${version} is already installed; asserting the FAST PATH instead`);
    const shortcut = await install.installVersion(version, { paths: PATHS });
    report.check(`${version}: a re-run short-circuits and reports skipped`, shortcut.skipped === true);
    report.check(
      `${version}: the short circuit did not touch the network or the tree`,
      shortcut.approach === null && shortcut.exitCode === 0,
      `approach=${shortcut.approach} exitCode=${shortcut.exitCode}`,
    );
    report.check(
      `${version}: it still validates`,
      validation.validateInstallTree(version, shortcut.installDir).ok === true,
    );
    report.check(
      `${version}: it is still recorded in the catalogue`,
      catalogue.readCatalogue({ paths: PATHS }).document.versions[version] !== undefined,
    );
    report.check(
      `${version}: enumeration still reports it installed`,
      library.readLibraryEntry(version, { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
    );
    continue;
  }

  report.check(`${version}: not already present before the install`, true);

  const started = Date.now();
  let result = null;
  let error = null;
  try {
    result = await install.installVersion(version, {
      paths: PATHS,
      source: version,
    });
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - started;
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;

  if (error !== null) {
    // The exact npm output tail, as requested. Preserved rather than summarised.
    console.log(`\nFAILED after ${elapsed}\n`);
    console.log(`step:         ${error.step}`);
    console.log(`exit code:    ${error.exitCode}`);
    console.log(`message:\n${error.message}\n`);
    if (error.outputTail) {
      console.log(`--- npm stderr tail ---\n${error.outputTail}\n-----------------------\n`);
    }
    report.check(`${version}: the install succeeded`, false, `${error.step}: ${error.message.split("\n")[0]}`);
    continue;
  }

  console.log(
    `installed ${version} in ${elapsed}: approach=${result.approach}` +
      `${result.fallbackReason ? ` (fallback: ${result.fallbackReason})` : ""}`,
  );
  if (result.catalogue?.recorded === false) {
    console.log(`  catalogue note: ${result.catalogue.message}`);
  }

  report.check(`${version}: the install succeeded`, result.skipped === false);
  report.check(
    `${version}: the result reports which approach landed`,
    result.approach === install.INSTALL_APPROACH.STAGED || result.approach === install.INSTALL_APPROACH.IN_PLACE,
    String(result.approach),
  );
  report.check(
    `${version}: the install tree validates at its final path`,
    validation.validateInstallTree(version, result.installDir).ok === true,
    JSON.stringify(validation.validateInstallTree(version, result.installDir).problems.map((p) => p.code)),
  );
  report.check(
    `${version}: bin.js exists where the layout says it should`,
    fs.existsSync(path.join(result.installDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")),
  );
  report.check(
    `${version}: the web-app package is resolvable`,
    validation.isPackageResolvable(result.installDir, "@deepseek-ai/dsh-web-app"),
    validation.resolvedPackagePath(result.installDir, "@deepseek-ai/dsh-web-app"),
  );
  report.check(
    `${version}: the real harness manifest parses and names the right package`,
    (() => {
      const read = validation.readPackageJson(result.installDir, "@deepseek-ai/dsh");
      return read.status === "ok" && read.value.name === "@deepseek-ai/dsh";
    })(),
  );
  report.check(
    `${version}: the manifest's version is the version we asked for`,
    (() => {
      const read = validation.readPackageJson(result.installDir, "@deepseek-ai/dsh");
      return read.status === "ok" && read.value.version === version;
    })(),
    JSON.stringify(validation.readPackageJson(result.installDir, "@deepseek-ai/dsh").value?.version),
  );
  report.check(
    `${version}: no staging directory was left behind`,
    library.leftoverDirsFor(version, { paths: PATHS }).length === 0,
    JSON.stringify(library.leftoverDirsFor(version, { paths: PATHS }).map((dir) => path.basename(dir))),
  );
  report.check(
    `${version}: it is recorded in the catalogue`,
    catalogue.readCatalogue({ paths: PATHS }).document.versions[version] !== undefined,
  );
  report.check(
    `${version}: the catalogue checksum matches the installed manifest`,
    catalogue.readCatalogue({ paths: PATHS }).document.versions[version]?.checksum ===
      library.checksumFor(result.installDir),
  );
  report.check(
    `${version}: enumeration reports it installed`,
    library.readLibraryEntry(version, { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
    library.readLibraryEntry(version, { paths: PATHS }).state,
  );
  report.check(
    `${version}: a second install short-circuits (the fast path never touches the network)`,
    (await install.installVersion(version, { paths: PATHS })).skipped === true,
  );
}

// --- the coexistence proof ---------------------------------------------------

await report.section("two real versions coexist in one library", () => {
  const entries = library.listInstalledVersions({
    paths: PATHS,
    installedAt: catalogue.readInstalledAt({ paths: PATHS }),
  });
  const installed = entries.filter((entry) => entry.state === library.LIBRARY_STATE.INSTALLED);

  report.check(
    `the library holds ${chosen.length} installed versions`,
    installed.length >= chosen.length,
    JSON.stringify(entries.map((entry) => `${entry.version}:${entry.state}`)),
  );
  report.check(
    "both target versions are among them",
    chosen.every((version) => installed.some((entry) => entry.version === version)),
    JSON.stringify(installed.map((entry) => entry.version)),
  );
  report.check(
    "each version's install directory is its own",
    new Set(chosen.map((version) => library.installDirFor(version, { paths: PATHS }))).size === chosen.length,
  );
  report.check(
    "each version's bin.js is a distinct file",
    new Set(
      chosen.map((version) =>
        path.join(library.installDirFor(version, { paths: PATHS }), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      ),
    ).size === chosen.length,
  );
  report.check(
    "the checksums differ, proving the trees are genuinely different versions",
    new Set(
      chosen.map((version) =>
        library.checksumFor(library.installDirFor(version, { paths: PATHS })),
      ),
    ).size === chosen.length,
  );
  report.check(
    "the catalogue holds an entry for each",
    chosen.every((version) => catalogue.readCatalogue({ paths: PATHS }).document.versions[version] !== undefined),
  );
  report.check(
    "the dated ordering places the two installs by their real timestamps",
    (() => {
      const dates = chosen.map(
        (version) => catalogue.readCatalogue({ paths: PATHS }).document.versions[version].installedAt,
      );
      return dates.every((value) => typeof value === "string" && !Number.isNaN(Date.parse(value)));
    })(),
  );
  report.check(
    "no launcher-owned file is enumerated as a version",
    entries.every((entry) => library.isVersionDirName(entry.version)),
  );
  report.check(
    "the library root holds no staging leftovers at all",
    library.scanLibraryRoot({ paths: PATHS }).staging.length === 0,
    JSON.stringify(library.scanLibraryRoot({ paths: PATHS }).staging),
  );
});

// --- the report the user asked for -------------------------------------------

const totalMs = Date.now() - startedAll;

console.log(`\n${"=".repeat(72)}`);
console.log("LIVE REPORT");
console.log("=".repeat(72));
console.log(`data dir:            ${PATHS.root}`);
console.log(`npm cache:           ${PATHS.npmCache}`);
console.log(`versions requested:  ${chosen.join(", ")}`);
console.log(`total wall time:     ${(totalMs / 1000).toFixed(1)}s`);
console.log(`library now holds:   ${library.listInstalledVersions({ paths: PATHS }).length} version directory(ies)`);

console.log("\nlistInstalledVersions output:");
console.log(
  library.describeLibrary(
    library.listInstalledVersions({
      paths: PATHS,
      installedAt: catalogue.readInstalledAt({ paths: PATHS }),
      // Checksums are OFF by default (hashing every tree on every enumeration would
      // be far too slow); the report asks for them explicitly so the recorded
      // checksum can be seen next to the entry it belongs to.
      checksums: true,
    }),
  ),
);

console.log("\ncatalogue.json contents:");
try {
  console.log(fs.readFileSync(path.join(PATHS.versions, "catalogue.json"), "utf8"));
} catch (error) {
  console.log(`  (could not be read: ${error.message})`);
}

console.log("library root:");
for (const entry of fs.readdirSync(PATHS.versions)) {
  const full = path.join(PATHS.versions, entry);
  const kind = fs.statSync(full).isDirectory() ? "dir " : "file";
  console.log(`  ${kind}  ${entry}`);
}
console.log(`\nthe library was PRESERVED at ${PATHS.root} for inspection.`);
console.log("=".repeat(72));

process.exit(report.finish());
