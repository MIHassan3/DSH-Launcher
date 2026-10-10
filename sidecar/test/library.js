/**
 * Step 1 - the version library and install-tree validation.
 *
 * Structure of this test:
 *
 *   fixtures   - a scratch library built in the repo's .test-tmp, containing
 *                every state the library must distinguish: validated installs,
 *                partial trees, an incomplete install, staging leftovers and
 *                launcher-owned files in the library root.
 *   pure       - name safety, path derivation, containment, candidate paths.
 *   validation - every problem code, against deliberately broken fixtures.
 *   library    - enumeration, ordering, the three states, leftover detection.
 *
 * NOTHING HERE TOUCHES A REAL HARNESS. No process is started, no process is
 * killed, no network is used, and every path written is inside .test-tmp. The
 * data directory is redirected with DSH_DOCK_DATA_DIR, which is a supported
 * product feature (state.js) and never set by production code.
 *
 * Run from the repo root:
 *   node sidecar/test/library.js
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "library");

// Redirect the launcher data directory BEFORE importing anything that resolves
// it. `resolveStatePaths()` is called per-invocation rather than cached, but
// setting this first removes any question of ordering.
process.env.DSH_DOCK_DATA_DIR = TMP_ROOT;

const report = createReport("DSH-Dock library: enumeration and install validation");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");
const validation = await import("../lib/validation.js");
const install = await import("../lib/harness-install.js");
const versionManager = await import("../lib/version-manager.js");

const PATHS = state.resolveStatePaths();
const VERSIONS = PATHS.versions;

// --- fixture construction ---------------------------------------------------

/**
 * Writes a plausible installed package tree for one version.
 *
 * @param {{installDir: string, withBin?: boolean, withDsh?: boolean,
 *          withWebApp?: boolean, webAppNested?: boolean,
 *          dshJson?: string, incomplete?: boolean}} spec
 */
function makeTree(spec) {
  const {
    installDir,
    withBin = true,
    withDsh = true,
    withWebApp = true,
    webAppNested = false,
    dshJson,
    incomplete = false,
  } = spec;

  const scope = path.join(installDir, "node_modules", "@deepseek-ai");
  fs.mkdirSync(scope, { recursive: true });

  if (withDsh) {
    const dshDir = path.join(scope, "dsh");
    fs.mkdirSync(path.join(dshDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dshDir, "package.json"),
      dshJson ?? JSON.stringify({ name: "@deepseek-ai/dsh", version: path.basename(installDir) }, null, 2),
    );
    if (withBin) {
      fs.writeFileSync(path.join(dshDir, "lib", "bin.js"), "// fixture entry point\n");
    }
  }

  if (withWebApp) {
    const webAppDir = webAppNested
      ? path.join(scope, "dsh", "node_modules", "@deepseek-ai", "dsh-web-app")
      : path.join(scope, "dsh-web-app");
    fs.mkdirSync(webAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(webAppDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }, null, 2),
    );
  }

  if (incomplete) {
    fs.writeFileSync(path.join(installDir, validation.INCOMPLETE_MARKER), "staged by test\n");
  }

  return installDir;
}

/** Convenience: build `<versions>/<version>` from a spec. */
function makeVersion(version, spec = {}) {
  return makeTree({ installDir: path.join(VERSIONS, version), ...spec });
}

fs.mkdirSync(VERSIONS, { recursive: true });

// A validated install, newest of the dated pair.
makeVersion("0.2.0-rc.2");
// A validated install whose web-app is nested rather than hoisted - the layout
// npm produces on a version conflict, and just as valid.
makeVersion("0.2.0-rc.1", { webAppNested: true });
// A valid install the catalogue will NOT know about (installed by hand, or by an
// older build). It must still be enumerated, and must sort after dated entries.
makeVersion("0.1.5");
// An interrupted install in the in-place fallback mode: marker present, and
// bin.js present too, because an older tree survived underneath.
makeVersion("0.1.4", { incomplete: true });
// A tree that exists but never produced an entry point.
makeVersion("0.1.3", { withBin: false });
// A tree with an entry point but no web-app package.
makeVersion("0.1.2", { withWebApp: false });
// A tree whose harness manifest is present but unparseable.
makeVersion("0.1.1", { dshJson: "{ this is not json" });
// A tree whose manifest is a valid JSON array rather than an object.
makeVersion("0.1.0", { dshJson: "[1, 2, 3]" });

// Launcher-owned and leftover entries in the library root. NONE of these may be
// enumerated as a version, and none may be deleted by a version operator.
fs.writeFileSync(
  path.join(VERSIONS, "catalogue.json"),
  JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-10-04T00:00:00Z",
    versions: {
      "0.2.0-rc.2": {
        installedAt: "2026-10-03T00:00:00Z",
        source: "next",
        installDir: "0.2.0-rc.2",
        checksum: "sha256:fixture",
      },
      "0.2.0-rc.1": {
        installedAt: "2026-10-01T00:00:00Z",
        source: "0.2.0-rc.1",
        installDir: "0.2.0-rc.1",
        checksum: "sha256:fixture",
      },
    },
  }),
);
fs.writeFileSync(path.join(VERSIONS, library.LOCK_FILE_NAME), JSON.stringify({ pid: 1 }));
fs.mkdirSync(path.join(VERSIONS, ".staging-0.3.0-abc123"), { recursive: true });
fs.mkdirSync(path.join(VERSIONS, ".corrupt-20261004T000000"), { recursive: true });
fs.writeFileSync(path.join(VERSIONS, "stray-note.txt"), "not a version\n");

const CATALOGUE_DATES = {
  "0.2.0-rc.2": "2026-10-03T00:00:00Z",
  "0.2.0-rc.1": "2026-10-01T00:00:00Z",
};

// --- pure path and name logic ----------------------------------------------

await report.section("version directory names (the gate on library enumeration)", () => {
  for (const name of ["0.2.0-rc.2", "1.2.3-alpha.10", "1.2.3+build.5", "0.1.5"]) {
    report.check(`accepts ${name}`, library.isVersionDirName(name) === true);
  }

  const rejected = [
    ["the catalogue", "catalogue.json"],
    ["a lock file", ".lock"],
    ["a staging directory", ".staging-0.3.0-abc"],
    ["a corrupt backup", ".corrupt-20261004T000000"],
    ["a parent traversal", ".."],
    ["the current directory", "."],
    ["a nested path", "1.0.0/2.0.0"],
    ["a backslash path", "..\\evil"],
    ["an absolute path", "C:\\evil"],
    ["a leading dot", ".hidden"],
    ["a leading dash", "-flag"],
    ["an empty string", ""],
    ["a space", "1.0.0 evil"],
    ["a null byte", "1.0.0\0"],
    ["a non-string", 1234],
    ["null", null],
    ["undefined", undefined],
    // Step 4 additions: the library's gate must agree with the install module's, so
    // a dist-tag or a range can never be treated as a version directory.
    ["a dist-tag", "next"],
    ["another dist-tag", "latest"],
    ["a range", "1.x"],
    ["a caret range", "^1.0.0"],
    ["a tilde range", "~1.0.0"],
    ["a partial version", "1.0"],
    ["a letters-only name", "alpha"],
  ];
  for (const [label, value] of rejected) {
    report.check(`rejects ${label}`, library.isVersionDirName(value) === false, JSON.stringify(value));
  }

  // THE CROSS-MODULE PIN. `library.js` and `harness-install.js` each define a
  // version-name rule; if they ever disagree, one accepts a name the other refuses,
  // and the disagreement surfaces as a confusing failure deep in an install or a
  // delete. Both are checked against the same list here.
  const agreed = ["0.2.0-rc.2", "1.2.3", "1.2.3-alpha.10", "1.2.3+build.5", "0.0.1", "10.20.30-rc.1+b"];
  const refused = ["next", "latest", "alpha", "*", "1.x", "^1.0.0", "~1.0.0", "1.0", "1.0.0/2", "1.0.0 evil", "", "C:\\x"];
  for (const name of agreed) {
    report.check(
      `both modules accept ${JSON.stringify(name)}`,
      library.isSafeVersionName(name) === true && install.isSafeVersionName(name) === true,
      `library=${library.isSafeVersionName(name)} install=${install.isSafeVersionName(name)}`,
    );
  }
  for (const name of refused) {
    report.check(
      `both modules refuse ${JSON.stringify(name)}`,
      library.isSafeVersionName(name) === false && install.isSafeVersionName(name) === false,
      `library=${library.isSafeVersionName(name)} install=${install.isSafeVersionName(name)}`,
    );
  }
  report.check(
    "the two modules agree on every case in the list",
    agreed.every((name) => library.isSafeVersionName(name) === install.isSafeVersionName(name)) &&
      refused.every((name) => library.isSafeVersionName(name) === install.isSafeVersionName(name)),
  );
  report.check(
    "both modules enforce the same length cap",
    library.MAX_VERSION_LENGTH === install.MAX_VERSION_LENGTH,
    `${library.MAX_VERSION_LENGTH} vs ${install.MAX_VERSION_LENGTH}`,
  );
});

await report.section("library paths", () => {
  report.check(
    "the library root is <data-dir>/versions",
    library.versionsRoot({ paths: PATHS }) === VERSIONS,
    library.versionsRoot({ paths: PATHS }),
  );
  report.check(
    "an install dir is <versions>/<version>",
    library.installDirFor("0.2.0-rc.2", { paths: PATHS }) === path.join(VERSIONS, "0.2.0-rc.2"),
  );
  report.check(
    "an unsafe version is refused",
    throws(() => library.installDirFor("../../evil", { paths: PATHS })),
  );
  report.check(
    "the catalogue is refused as a version",
    throws(() => library.installDirFor("catalogue.json", { paths: PATHS })),
  );
});

await report.section("containment (the guard every destructive operation uses)", () => {
  const inside = [
    ["a version directory", path.join(VERSIONS, "0.2.0-rc.2")],
    ["a nested file", path.join(VERSIONS, "0.2.0-rc.2", "node_modules", "x", "y.js")],
    ["a staging directory", path.join(VERSIONS, ".staging-1-abc")],
  ];
  for (const [label, candidate] of inside) {
    report.check(`accepts ${label}`, library.isPathInsideVersions(candidate, { paths: PATHS }) === true);
  }

  const outside = [
    ["the library root itself", VERSIONS],
    ["the data directory", PATHS.root],
    ["a sibling of the library root", path.join(PATHS.root, "logs")],
    ["a traversal out of the library", path.join(VERSIONS, "..", "settings.json")],
    ["a traversal through a version", path.join(VERSIONS, "0.2.0-rc.2", "..", "..", "logs")],
    ["an unrelated absolute path", path.join(REPO_ROOT, "sidecar", "index.js")],
    ["an empty string", ""],
    ["null", null],
  ];
  for (const [label, candidate] of outside) {
    report.check(`refuses ${label}`, library.isPathInsideVersions(candidate, { paths: PATHS }) === false);
  }

  // Case handling is OS-dependent and is the difference between a spurious
  // refusal and a security hole, so both branches are exercised explicitly.
  report.check(
    "Windows containment is case-insensitive",
    library.isPathInsideVersions(path.join(VERSIONS, "ABC"), { paths: PATHS, platform: "win32" }) === true,
  );
  report.check(
    "POSIX containment is case-sensitive",
    library.isPathInsideVersions(path.join(VERSIONS, "ABC"), { paths: PATHS, platform: "linux" }) === false,
  );
});

await report.section("the entry-point path is defined once (duplicate constants cannot drift)", () => {
  const probe = path.join(VERSIONS, "0.2.0-rc.2");
  report.check(
    "harness-install's HARNESS_BIN_RELATIVE matches the real layout",
    install.HARNESS_BIN_RELATIVE === path.join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    install.HARNESS_BIN_RELATIVE,
  );
  report.check(
    "harness-install and validation derive the same bin path",
    install.harnessBinPath(probe) === validation.harnessBinPath(probe),
    `${install.harnessBinPath(probe)} vs ${validation.harnessBinPath(probe)}`,
  );
  report.check(
    "harness-install and version-manager agree on the relative path",
    versionManager.HARNESS_BIN_RELATIVE.split("\\").join("/") ===
      install.HARNESS_BIN_RELATIVE.split("\\").join("/"),
    `${versionManager.HARNESS_BIN_RELATIVE} vs ${install.HARNESS_BIN_RELATIVE}`,
  );
  report.check(
    "library derives the same bin path too",
    library.readLibraryEntry("0.2.0-rc.2", { paths: PATHS }).binPath === install.harnessBinPath(probe),
  );
});

await report.section("@deepseek-ai package resolution (hoisted and nested)", () => {
  const hoisted = path.join(VERSIONS, "0.2.0-rc.2");
  const nested = path.join(VERSIONS, "0.2.0-rc.1");

  report.check(
    "a hoisted package resolves",
    validation.isPackageResolvable(hoisted, "@deepseek-ai/dsh-web-app") === true,
  );
  report.check(
    "a nested (conflict-layout) package resolves",
    validation.isPackageResolvable(nested, "@deepseek-ai/dsh-web-app") === true,
  );
  report.check(
    "a missing package does not resolve",
    validation.isPackageResolvable(hoisted, "@deepseek-ai/dsh-web-app-missing") === false,
  );
  report.check(
    "an unscoped name is accepted",
    validation.isPackageResolvable(hoisted, "dsh-web-app") === true,
  );
  report.check(
    "an empty name does not resolve",
    validation.isPackageResolvable(hoisted, "") === false,
  );

  const candidates = validation.packageJsonCandidates(hoisted, "dsh-web-app");
  report.check("the hoisted path is tried first", candidates.length === 2 && candidates[0].includes(
    path.join("node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
  ));
  report.check(
    "the nested path is tried second",
    candidates[1].includes(path.join("dsh", "node_modules", "@deepseek-ai", "dsh-web-app")),
  );
  report.check(
    "the resolved path is the one that exists",
    validation.resolvedPackagePath(nested, "dsh-web-app") ===
      path.join(nested, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
  );
});

await report.section("package.json reading is a discriminated result", () => {
  report.check(
    "a valid manifest parses",
    validation.readPackageJson(path.join(VERSIONS, "0.2.0-rc.2"), "@deepseek-ai/dsh").status === "ok",
  );
  report.check(
    "an absent manifest is reported absent, not thrown",
    validation.readPackageJson(path.join(VERSIONS, "0.2.0-rc.2"), "@deepseek-ai/nope").status === "absent",
  );
  report.check(
    "an unparseable manifest is reported invalid",
    validation.readPackageJson(path.join(VERSIONS, "0.1.1"), "@deepseek-ai/dsh").status === "invalid",
  );
  report.check(
    "a JSON array is reported invalid",
    validation.readPackageJson(path.join(VERSIONS, "0.1.0"), "@deepseek-ai/dsh").status === "invalid",
  );
});

// --- validation problem codes ----------------------------------------------

await report.section("install tree validation", () => {
  const good = validation.validateInstallTree("0.2.0-rc.2", path.join(VERSIONS, "0.2.0-rc.2"));
  report.check("a complete tree validates", good.ok === true, validation.describeProblems(good.problems));
  report.check("a valid tree has no problems", good.problems.length === 0);
  report.check("the bin path is reported back", good.binPath.endsWith(path.join("lib", "bin.js")));

  const nested = validation.validateInstallTree("0.2.0-rc.1", path.join(VERSIONS, "0.2.0-rc.1"));
  report.check("a conflict-layout tree also validates", nested.ok === true, validation.describeProblems(nested.problems));

  const noBin = validation.validateInstallTree("0.1.3", path.join(VERSIONS, "0.1.3"));
  report.check("a tree without bin.js fails", noBin.ok === false);
  report.check(
    "the failure names bin-missing",
    noBin.problems.some((problem) => problem.code === validation.PROBLEM.BIN_MISSING),
    JSON.stringify(noBin.problems.map((problem) => problem.code)),
  );

  const noWebApp = validation.validateInstallTree("0.1.2", path.join(VERSIONS, "0.1.2"));
  report.check("a tree without the web-app fails", noWebApp.ok === false);
  const webAppProblem = noWebApp.problems.find(
    (problem) => problem.code === validation.PROBLEM.WEB_APP_MISSING,
  );
  // Step 3 split the single `package-missing` code into one per package, because
  // the repair differs: a missing `dsh` means the install never happened, while a
  // missing `dsh-web-app` means it happened incompletely. This assertion moved with
  // it.
  report.check("the failure is coded web-app-missing", webAppProblem !== undefined, JSON.stringify(noWebApp.problems.map((p) => p.code)));
  report.check(
    "the failure names dsh-web-app specifically",
    (webAppProblem?.detail ?? "").includes("@deepseek-ai/dsh-web-app"),
    webAppProblem?.detail,
  );
  report.check(
    "the failure explains the boot symptom (ERR_MODULE_NOT_FOUND)",
    (webAppProblem?.detail ?? "").includes("ERR_MODULE_NOT_FOUND"),
  );
  report.check(
    "the failure lists every candidate location searched",
    (webAppProblem?.detail ?? "").includes("looked in"),
    webAppProblem?.detail,
  );

  const invalidJson = validation.validateInstallTree("0.1.1", path.join(VERSIONS, "0.1.1"));
  report.check(
    "an unparseable manifest fails",
    invalidJson.problems.some((problem) => problem.code === validation.PROBLEM.PACKAGE_JSON_INVALID),
    JSON.stringify(invalidJson.problems.map((problem) => problem.code)),
  );

  const marker = validation.validateInstallTree("0.1.4", path.join(VERSIONS, "0.1.4"));
  report.check(
    "an .incomplete marker fails even though bin.js exists",
    marker.problems.some((problem) => problem.code === validation.PROBLEM.INCOMPLETE_MARKER),
    JSON.stringify(marker.problems.map((problem) => problem.code)),
  );

  const absent = validation.validateInstallTree("9.9.9", path.join(VERSIONS, "9.9.9"));
  report.check("a non-existent tree fails", absent.ok === false);
  report.check(
    "every problem is reported at once, not just the first",
    absent.problems.filter((problem) => problem.code === validation.PROBLEM.BIN_MISSING).length === 1 &&
      absent.problems.filter((problem) => problem.code === validation.PROBLEM.DSH_PACKAGE_MISSING).length === 1 &&
      absent.problems.filter((problem) => problem.code === validation.PROBLEM.WEB_APP_MISSING).length === 1,
    JSON.stringify(absent.problems.map((problem) => problem.code)),
  );

  report.check(
    "a directory where bin.js should be is distinct from a missing file",
    (() => {
      const dir = path.join(VERSIONS, "0.0.9");
      fs.mkdirSync(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), { recursive: true });
      const result = validation.validateInstallTree("0.0.9", dir);
      const codes = result.problems.map((problem) => problem.code);
      fs.rmSync(dir, { recursive: true, force: true });
      return codes.includes(validation.PROBLEM.BIN_NOT_A_FILE);
    })(),
  );
});

await report.section("the cheap probe answers the SAME question, only cheaper", () => {
  // THE CROSS-MODULE PIN (Q71), AND THE ONE THAT MATTERS MOST IN 2B.
  //
  // Two predicates answer "can this version be run?": the strict one reads every
  // required manifest, the cheap one only `stat`s entries. The status list uses the
  // cheap one; the start path uses the strict one. If they disagree, the UI offers
  // a version that is then silently reinstalled - or refuses one that works.
  //
  // This walks EVERY fixture, including the interesting partial cases the real-tree
  // probe cannot cover (a missing web-app, an unparseable manifest, a directory
  // where bin.js belongs). One divergence is allowed and named below.
  const strictOnlyCodes = new Set([
    validation.PROBLEM.PACKAGE_JSON_INVALID,
    validation.PROBLEM.PACKAGE_JSON_UNREADABLE,
  ]);

  const disagreements = [];
  const expectedCheapOnly = [];

  for (const version of library.scanLibraryRoot({ paths: PATHS }).versions) {
    const cheap = library.readLibraryEntry(version, { paths: PATHS, validate: false }).state;
    const strictEntry = library.readLibraryEntry(version, { paths: PATHS });
    if (cheap === strictEntry.state) continue;

    // The ONE allowed divergence, and it must be in the SAFE direction: a tree
    // whose only problem is an unparseable or unreadable manifest reads
    // `installed` cheaply (the entry is present) and `partial` strictly. Safe
    // because the strict check is the one that gates a start.
    const codes = strictEntry.problems.map((problem) => problem.code);
    const onlyManifestProblem = codes.length > 0 && codes.every((code) => strictOnlyCodes.has(code));
    if (cheap === library.LIBRARY_STATE.INSTALLED && onlyManifestProblem) {
      expectedCheapOnly.push(version);
      continue;
    }
    disagreements.push(`${version}: cheap=${cheap} strict=${strictEntry.state} codes=${JSON.stringify(codes)}`);
  }

  report.check(
    "every fixture agrees except the documented manifest case",
    disagreements.length === 0,
    disagreements.join(" | "),
  );
  report.check(
    "the manifest case is the only divergence, and it errs toward `installed` (the safe direction)",
    expectedCheapOnly.sort().join(",") === "0.1.0,0.1.1",
    expectedCheapOnly.sort().join(","),
  );

  // The specific case that motivated the shared predicate: bin.js present, web-app
  // absent. This is the over-approximation that would have shipped.
  report.check(
    "the missing-web-app fixture really is missing its web-app",
    fs.existsSync(path.join(VERSIONS, "0.1.2", "node_modules", "@deepseek-ai", "dsh-web-app")) === false,
  );
  report.check(
    "the cheap probe calls a tree with no web-app PARTIAL",
    library.readLibraryEntry("0.1.2", { paths: PATHS, validate: false }).state === library.LIBRARY_STATE.PARTIAL,
    library.readLibraryEntry("0.1.2", { paths: PATHS, validate: false }).state,
  );
  report.check(
    "while the historical isInstalled check still says yes - the gap that used to exist",
    install.isInstalled("0.1.2", { paths: PATHS }) === true,
  );

  // The marker stays decisive on the cheap path.
  const marked = library.readLibraryEntry("0.1.4", { paths: PATHS, validate: false });
  report.check("the marked fixture really is marked, with a bin.js present", marked.hasIncompleteMarker === true && marked.hasBin === true);
  report.check("the cheap probe reports it PARTIAL", marked.state === library.LIBRARY_STATE.PARTIAL, marked.state);
  report.check("the cheap path does not invent problems it never collected", marked.problems.length === 0);

  // The predicate itself, so a failure above names the right module.
  report.check("hasRequiredEntries accepts a complete tree", validation.hasRequiredEntries(path.join(VERSIONS, "0.2.0-rc.2")) === true);
  report.check("hasRequiredEntries rejects the marked tree", validation.hasRequiredEntries(path.join(VERSIONS, "0.1.4")) === false);
  report.check("hasRequiredEntries rejects the no-bin tree", validation.hasRequiredEntries(path.join(VERSIONS, "0.1.3")) === false);
  report.check(
    "installTreeEssentials names WHICH package is missing, not merely that one is",
    validation.installTreeEssentials(path.join(VERSIONS, "0.1.2")).missingPackages.join(",") === "@deepseek-ai/dsh-web-app",
    JSON.stringify(validation.installTreeEssentials(path.join(VERSIONS, "0.1.2")).missingPackages),
  );
});

await report.section("the SHELL's version predicate is a subset of the library's (Q71 across the wire)", () => {
  // THE AUTHORITY IS HERE; THE SHELL'S COPY IS A GATE. Phase 2B added
  // `is_switchable_version` to `src-tauri/src/menu.rs`, because a malformed menu id
  // must never become an HTTP request and the user deserves a reason rather than a
  // 400 from a service they did not know was involved.
  //
  // The relation that must hold is a SUBSET, not equality:
  //
  //   shell accepts   =>  library accepts       (required: a dispatched route is valid)
  //   library accepts =/=>  shell accepts       (allowed: the shell may be stricter)
  //
  // The second is deliberate and narrow - the shell refuses the empty dot-separated
  // identifiers the library's pattern tolerates - and it is safe because its only
  // consequence is a refusal the user can see, never a bad request.
  //
  // The corpus below is a COPY of the shell test's corpus. It cannot be shared across
  // the language boundary, so it is duplicated on purpose: a version added to one list
  // and not the other is exactly the drift this pair exists to catch.
  const shellAccepts = [
    "0.2.0-rc.1",
    "0.2.0-rc.2",
    "0.2.1-alpha.1",
    "1.2.3",
    "1.2.3-alpha.10",
    "1.2.3+build.5",
    "1.2.3-rc.1+build.5",
    "0.0.1-rc.1",
    "10.20.30",
  ];
  const shellRefuses = [
    "../../evil",
    "1.0.0/../evil",
    "next",
    "latest",
    "1.x",
    "^1.2.3",
    "1.2",
    "1.2.3.4",
    "1.2.3-",
    "1.2.3+",
    "1.2.3 ",
    "1.2.3-rc.1+",
    "v1.2.3",
  ];

  const violations = shellAccepts
    .filter((version) => !library.isSafeVersionName(version))
    .map((version) => `${version}: the shell would dispatch it, the library would refuse it`);
  report.check(
    "every version the shell would dispatch is one the library accepts",
    violations.length === 0,
    violations.join(" | "),
  );

  // The other direction, so "subset" is actually tested and not assumed: everything
  // the shell refuses must ALSO be refused here, or the shell would be refusing
  // versions the rest of the launcher considers valid.
  const disagreements = shellRefuses
    .filter((version) => library.isSafeVersionName(version))
    .map((version) => `${version}: the shell refuses it but the library accepts it`);
  report.check(
    "every version the shell refuses is one the library refuses too",
    disagreements.length === 0,
    disagreements.join(" | "),
  );

  // And the corpus is not vacuous in either direction.
  report.check(
    "the accepted corpus is really accepted, so the subset check is not trivially true",
    shellAccepts.every((version) => library.isSafeVersionName(version)),
  );
  report.check(
    "the refused corpus is really refused, so the agreement check is not trivially true",
    shellRefuses.every((version) => !library.isSafeVersionName(version)),
  );

  // ON THE DIRECTION NOT PROVEN HERE. The relation required of the shell is a subset:
  // anything it dispatches must be valid. The shell's predicate is stricter by
  // construction (it refuses the empty dot-separated identifiers that the library's
  // pattern would need a concrete example to demonstrate), and NOTHING in this corpus
  // distinguishes them - the two agree on every string above. Rather than assert a
  // divergence with an invented example, this records the honest position: they agree
  // on everything tested, and the shell may only ever refuse MORE.
});

await report.section("harness-install delegating helpers (additive, no behavior change)", () => {
  const good = path.join(VERSIONS, "0.2.0-rc.2");
  report.check(
    "isInstalled still means 'bin.js is a file'",
    install.isInstalled("0.2.0-rc.2", { paths: PATHS }) === true,
  );
  report.check(
    "isInstalled still accepts a tree the new validation rejects",
    install.isInstalled("0.1.2", { paths: PATHS }) === true,
    "the Phase 1 contract is deliberately unchanged in Step 1",
  );
  report.check(
    "hasInstallEntryPoint agrees with isInstalled",
    install.hasInstallEntryPoint("0.1.2", { paths: PATHS }) === install.isInstalled("0.1.2", { paths: PATHS }),
  );
  report.check(
    "validateInstalledVersion reports the missing web-app",
    install.validateInstalledVersion("0.1.2", { paths: PATHS }).ok === false,
  );
  report.check(
    "isInstalledAndValid accepts a complete tree",
    install.isInstalledAndValid("0.2.0-rc.2", { paths: PATHS }) === true,
  );
  report.check(
    "isInstalledAndValid rejects the incomplete tree",
    install.isInstalledAndValid("0.1.4", { paths: PATHS }) === false,
  );
  report.check("the fixture path is what we think it is", good === path.join(VERSIONS, "0.2.0-rc.2"));
});

// --- library enumeration ----------------------------------------------------

await report.section("library scan separates versions from launcher-owned entries", () => {
  const scan = library.scanLibraryRoot({ paths: PATHS });

  report.check(
    "every version on disk is enumerated",
    scan.versions.length === 8,
    JSON.stringify(scan.versions),
  );
  report.check(
    "the catalogue is not a version",
    scan.versions.includes("catalogue.json") === false,
  );
  report.check("the lock file is not a version", scan.versions.includes(".lock") === false);
  report.check(
    "a staging directory is reported as staging",
    scan.staging.includes(".staging-0.3.0-abc123") === true,
    JSON.stringify(scan.staging),
  );
  report.check(
    "a corrupt backup is reported as corrupt",
    scan.corrupt.includes(".corrupt-20261004T000000") === true,
  );
  report.check(
    "an unknown file lands in 'other', never in versions",
    scan.other.includes("catalogue.json") &&
      scan.other.includes(".lock") &&
      scan.other.includes("stray-note.txt"),
    JSON.stringify(scan.other),
  );
  report.check("the version list is sorted", JSON.stringify(scan.versions) === JSON.stringify([...scan.versions].sort()));
});

report.check(
  "an unreadable/missing library root is an empty library, not an error",
  (() => {
    const empty = path.join(TMP_ROOT, "no-such-library");
    const scan = library.scanLibraryRoot({ paths: { ...PATHS, versions: empty } });
    return scan.versions.length === 0 && scan.staging.length === 0;
  })(),
);

await report.section("library enumeration and ordering", () => {
  const entries = library.listInstalledVersions({ paths: PATHS, installedAt: CATALOGUE_DATES });

  report.check("every version is listed", entries.length === 8, JSON.stringify(entries.map((e) => e.version)));
  report.check(
    "the order is deterministic across calls",
    JSON.stringify(library.listInstalledVersions({ paths: PATHS, installedAt: CATALOGUE_DATES }).map((e) => e.version)) ===
      JSON.stringify(entries.map((e) => e.version)),
  );
  report.check(
    "dated entries come first, newest date first",
    entries[0].version === "0.2.0-rc.2" && entries[1].version === "0.2.0-rc.1",
    JSON.stringify(entries.slice(0, 3).map((e) => `${e.version}@${e.installedAt}`)),
  );
  report.check(
    "undated entries sort after dated ones, by version string descending",
    entries.slice(2).every((entry) => entry.installedAt === null) &&
      JSON.stringify(entries.slice(2).map((entry) => entry.version)) ===
        JSON.stringify(["0.1.5", "0.1.4", "0.1.3", "0.1.2", "0.1.1", "0.1.0"]),
    JSON.stringify(entries.slice(2).map((entry) => entry.version)),
  );

  const byVersion = Object.fromEntries(entries.map((entry) => [entry.version, entry]));
  report.check("a complete tree is installed", byVersion["0.2.0-rc.2"].state === library.LIBRARY_STATE.INSTALLED);
  report.check("a conflict-layout tree is installed", byVersion["0.2.0-rc.1"].state === library.LIBRARY_STATE.INSTALLED);
  report.check("an unknown-to-the-catalogue tree is still installed", byVersion["0.1.5"].state === library.LIBRARY_STATE.INSTALLED);
  report.check("a missing bin.js is partial", byVersion["0.1.3"].state === library.LIBRARY_STATE.PARTIAL);
  report.check("a missing web-app is partial", byVersion["0.1.2"].state === library.LIBRARY_STATE.PARTIAL);
  report.check("an unparseable manifest is partial", byVersion["0.1.1"].state === library.LIBRARY_STATE.PARTIAL);
  report.check("an .incomplete install is partial", byVersion["0.1.4"].state === library.LIBRARY_STATE.PARTIAL);
  report.check(
    "a partial entry carries its problems",
    byVersion["0.1.2"].problems.length > 0,
    JSON.stringify(byVersion["0.1.2"].problems.map((problem) => problem.code)),
  );
  report.check(
    "a partial entry records the incomplete marker",
    byVersion["0.1.4"].hasIncompleteMarker === true,
  );
  report.check(
    "an installed entry carries no problems",
    byVersion["0.2.0-rc.2"].problems.length === 0,
  );

  report.check(
    "checksums are not computed unless asked for",
    entries.every((entry) => entry.checksum === null),
  );

  const withChecksums = library.listInstalledVersions({ paths: PATHS, checksums: true });
  const verified = withChecksums.find((entry) => entry.version === "0.2.0-rc.2");
  report.check(
    "a checksum is sha256:<hex>",
    /^sha256:[0-9a-f]{64}$/.test(verified.checksum ?? ""),
    verified.checksum,
  );
  report.check(
    "a partial tree with an intact manifest still has a checksum",
    /^sha256:[0-9a-f]{64}$/.test(withChecksums.find((entry) => entry.version === "0.1.2").checksum ?? ""),
    withChecksums.find((entry) => entry.version === "0.1.2").checksum,
  );
  report.check(
    "a tree with no manifest has no checksum",
    library.checksumFor(path.join(VERSIONS, "0.9.9")) === null &&
      library.checksumFor(path.join(VERSIONS, "no-such-version")) === null,
  );
  report.check(
    "a version directory with no harness manifest at all checksums as null",
    (() => {
      const bare = path.join(VERSIONS, "0.0.7");
      fs.mkdirSync(path.join(bare, "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
      fs.writeFileSync(
        path.join(bare, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }),
      );
      const entry = library.readLibraryEntry("0.0.7", { paths: PATHS, checksums: true });
      fs.rmSync(bare, { recursive: true, force: true });
      return entry.checksum === null && entry.state === library.LIBRARY_STATE.PARTIAL;
    })(),
  );

  report.check(
    "listReadyVersions excludes every partial tree",
    JSON.stringify(library.listReadyVersions({ paths: PATHS }).map((entry) => entry.version).sort()) ===
      JSON.stringify(["0.1.5", "0.2.0-rc.1", "0.2.0-rc.2"]),
    JSON.stringify(library.listReadyVersions({ paths: PATHS }).map((entry) => entry.version)),
  );
});

await report.section("single-version reads", () => {
  report.check(
    "an installed version reads as installed",
    library.readLibraryEntry("0.2.0-rc.2", { paths: PATHS }).state === library.LIBRARY_STATE.INSTALLED,
  );
  report.check(
    "an absent version reads as absent",
    library.readLibraryEntry("7.7.7", { paths: PATHS }).state === library.LIBRARY_STATE.ABSENT,
  );
  // PHASE 2B CORRECTED THIS ASSERTION. It used to read "the cheap probe
  // (validate:false) calls a bin-only tree installed" and required INSTALLED for
  // `0.1.2` - a tree with `bin.js` but NO `dsh-web-app`. That pinned the bug: the
  // cheap probe was asked a different question from the strict one, so the status
  // list offered a version the start path then refused and silently reinstalled.
  // The cheap probe now asks the shared predicate, and a tree missing a required
  // package is PARTIAL on both paths.
  report.check(
    "the cheap probe (validate:false) calls a tree with no web-app partial",
    library.readLibraryEntry("0.1.2", { paths: PATHS, validate: false }).state === library.LIBRARY_STATE.PARTIAL,
    library.readLibraryEntry("0.1.2", { paths: PATHS, validate: false }).state,
  );
  report.check(
    "the cheap probe still calls a bin-less tree partial",
    library.readLibraryEntry("0.1.3", { paths: PATHS, validate: false }).state === library.LIBRARY_STATE.PARTIAL,
  );
  report.check(
    "and it calls a complete tree installed",
    library.readLibraryEntry("0.2.0-rc.2", { paths: PATHS, validate: false }).state === library.LIBRARY_STATE.INSTALLED,
  );
  report.check(
    "isInstalledInLibrary matches the state field",
    library.isInstalledInLibrary("0.1.2", { paths: PATHS }) === false &&
      library.isInstalledInLibrary("0.2.0-rc.2", { paths: PATHS }) === true,
  );
  report.check(
    "reading an unsafe version name throws",
    throws(() => library.readLibraryEntry("../../evil", { paths: PATHS })),
  );
});

await report.section("leftover detection", () => {
  const partial = library.partialInstallDirs({ paths: PATHS });
  report.check(
    "staging leftovers are found",
    JSON.stringify(partial.staging) === JSON.stringify([".staging-0.3.0-abc123"]),
    JSON.stringify(partial.staging),
  );
  report.check(
    "incomplete-marked version directories are found as versions",
    JSON.stringify(partial.incomplete) === JSON.stringify(["0.1.4"]),
    JSON.stringify(partial.incomplete),
  );
  report.check(
    "corrupt backups are found",
    JSON.stringify(partial.corrupt) === JSON.stringify([".corrupt-20261004T000000"]),
  );
  report.check(
    "a valid install is never reported as leftover",
    partial.incomplete.includes("0.2.0-rc.2") === false && partial.staging.includes("0.2.0-rc.2") === false,
  );
});

await report.section("human-readable summary", () => {
  const entries = library.listInstalledVersions({ paths: PATHS, installedAt: CATALOGUE_DATES });
  const text = library.describeLibrary(entries);
  report.check("the summary names each version", entries.every((entry) => text.includes(entry.version)));
  report.check("the summary reports state", text.includes("[installed]") && text.includes("[partial]"));
  report.check("the summary reports unknown dates rather than inventing one", text.includes("unknown date"));
  report.check("an empty library says so", library.describeLibrary([]) === "  (the version library is empty)");
});

// The library must be usable when the catalogue is absent entirely, because a
// fresh data directory has no catalogue and the catalogue is advisory only.
await report.section("the library does not depend on the catalogue", () => {
  const bare = path.join(TMP_ROOT, "bare-versions");
  fs.mkdirSync(path.join(bare, "1.0.0", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  fs.writeFileSync(path.join(bare, "1.0.0", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// x\n");
  fs.writeFileSync(
    path.join(bare, "1.0.0", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh" }),
  );
  fs.mkdirSync(path.join(bare, "1.0.0", "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
  fs.writeFileSync(
    path.join(bare, "1.0.0", "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }),
  );

  const paths = { ...PATHS, versions: bare };
  const entries = library.listInstalledVersions({ paths });
  report.check("a version is enumerated with no catalogue present", entries.length === 1);
  report.check("and it is installed", entries[0].state === library.LIBRARY_STATE.INSTALLED);
  report.check("with no date", entries[0].installedAt === null);
});

process.exit(report.finish());
