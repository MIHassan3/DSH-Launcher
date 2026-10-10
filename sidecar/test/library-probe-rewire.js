/**
 * Read-only Phase 2B probe: what the rewritten start path now decides about the
 * REAL library, and what the status payload reports about it.
 *
 * WHY THIS EXISTS AS A FILE. The rewire's whole risk is a claim about real trees -
 * "we never adopt a tree we can prove is incomplete" - and the realistic failure
 * is the opposite one: calling a WORKING install broken, which turns an instant
 * startup into a multi-minute reinstall. Fixtures cannot answer that; only the
 * real `0.2.0-rc.1` / `0.2.0-rc.2` trees installed in Phase 2A can.
 *
 * IT WRITES NOTHING. It installs nothing, stops nothing and starts nothing: every
 * call here is a predicate or a read. That is deliberate, because the library it
 * inspects is the preserved evidence base Step 11 depends on.
 *
 * Run (from the repository root, with the live data dir selected):
 *
 *   $env:DSH_DOCK_DATA_DIR='.test-tmp/library-live'; node sidecar/test/library-probe-rewire.js
 *
 * Exits 1 if any real version that should be usable is reported unusable, because
 * that is not a diagnostic - that is the rewire being wrong.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const DEFAULT_LIVE_DATA = path.join(REPO_ROOT, ".test-tmp", "library-live");

const report = createReport("DSH-Dock: Phase 2B rewire, against the REAL library");

const LIVE_DATA = path.resolve(process.env.DSH_DOCK_DATA_DIR ?? DEFAULT_LIVE_DATA);
process.env.DSH_DOCK_DATA_DIR = LIVE_DATA;

// Same safety gate as the live tier: never point this at the user's real install.
const tempRoot = path.resolve(os.tmpdir());
const underTemp = LIVE_DATA.toLowerCase().startsWith(tempRoot.toLowerCase());
const underRepo = LIVE_DATA.toLowerCase().startsWith(REPO_ROOT.toLowerCase());
if (!underTemp && !underRepo) {
  report.check(
    "refusing to probe outside a temp root",
    false,
    `${LIVE_DATA} is neither under ${tempRoot} nor under ${REPO_ROOT}`,
  );
  process.exit(report.finish());
}

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");
const catalogue = await import("../lib/catalogue.js");
const install = await import("../lib/harness-install.js");
const control = await import("../lib/control.js");

const PATHS = state.resolveStatePaths();

report.check(
  "the data directory is a temp/repo root, not the user's install",
  underTemp || underRepo,
  PATHS.root,
);

const entries = library.listInstalledVersions({
  paths: PATHS,
  installedAt: catalogue.readInstalledAt({ paths: PATHS }),
});

report.check("the real library has at least two versions", entries.length >= 2, `${entries.length}`);
for (const entry of entries) {
  process.stdout.write(
    `  ${entry.version}  state=${entry.state}  installedAt=${entry.installedAt ?? "none"}\n`,
  );
}

// THE REWIRE'S ACTUAL CLAIM, on real trees: every real version must be reported
// usable by BOTH the cheap probe and the strict one. A disagreement here would
// mean the status list says "installed" while the start path decides to reinstall.
await report.section("the start path agrees with the library about every real version", () => {
  for (const entry of entries) {
    const strict = install.isInstalledAndValid(entry.version, { paths: PATHS });
    const cheap = entry.hasBin;
    report.check(
      `${entry.version}: validation accepts it (so a start will NOT reinstall it)`,
      strict === true,
      `isInstalledAndValid=${strict}`,
    );
    report.check(
      `${entry.version}: the cheap probe agrees it is runnable`,
      cheap === true && entry.state === library.LIBRARY_STATE.INSTALLED,
      `hasBin=${cheap} state=${entry.state}`,
    );
    report.check(
      `${entry.version}: no validation problems are reported`,
      entry.problems.length === 0,
      JSON.stringify(entry.problems.map((problem) => problem.code)),
    );
  }
});

await report.section("a partial tree is repaired, never adopted (fixture, real API)", () => {
  // A marked tree built inside the live library and removed again, so the claim is
  // exercised through the REAL code path rather than only in a scratch suite.
  const version = "0.0.1-probe-partial";
  const installDir = path.join(PATHS.versions, version);
  const scope = path.join(installDir, "node_modules", "@deepseek-ai");

  try {
    fs.mkdirSync(path.join(scope, "dsh", "lib"), { recursive: true });
    fs.writeFileSync(path.join(scope, "dsh", "lib", "bin.js"), "// stale entry point\n");
    fs.writeFileSync(path.join(scope, "dsh", "package.json"), "{}\n");
    fs.writeFileSync(path.join(installDir, ".incomplete"), "{}\n");

    report.check(
      "the cheap probe calls the marked tree partial",
      library.readLibraryEntry(version, { paths: PATHS, validate: false }).state ===
        library.LIBRARY_STATE.PARTIAL,
    );
    report.check(
      "the start path's strict check rejects it",
      install.isInstalledAndValid(version, { paths: PATHS }) === false,
    );
    report.check(
      "so a start WOULD reinstall rather than adopt",
      install.isInstalled(version, { paths: PATHS }) === true,
      "the stale bin.js is exactly what the old check would have trusted",
    );
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
    report.check("the probe tree was removed again", fs.existsSync(installDir) === false);
  }
});

await report.section("the status payload against the real library", async () => {
  const controller = new control.HarnessControl({ paths: PATHS });
  const libraryView = controller.librarySummary();

  report.check(
    "recentVersions lists every real version, newest first",
    libraryView.versions.length === entries.length,
    `${libraryView.versions.length} vs ${entries.length}`,
  );
  report.check(
    "the ordering matches the catalogue dates (newest first)",
    libraryView.versions.map((v) => v.version).join(",") === entries.map((v) => v.version).join(","),
    libraryView.versions.map((v) => v.version).join(","),
  );
  report.check(
    "every real version carries its installedAt date",
    libraryView.versions.every((v) => typeof v.installedAt === "string"),
    JSON.stringify(libraryView.versions.map((v) => v.installedAt)),
  );

  const summary = await controller.status({ probe: true });
  report.check(
    "the status payload carries the same list",
    (summary.recentVersions ?? []).map((v) => v.version).join(",") ===
      libraryView.versions.map((v) => v.version).join(","),
  );
  process.stdout.write(`  status=${summary.status} version=${summary.version ?? "none"}\n`);

  // The memo must not be the thing that makes this cheap and wrong.
  const first = controller.librarySummary();
  first.versions.push({ version: "9.9.9-mutated-by-caller", state: "installed", installedAt: null });
  const second = controller.librarySummary();
  report.check(
    "a caller cannot mutate the memo through the returned array",
    second.versions.some((v) => v.version === "9.9.9-mutated-by-caller") === false,
    JSON.stringify(second.versions.map((v) => v.version)),
  );
});

process.stdout.write(`\n  data dir: ${PATHS.root}\n`);
process.stdout.write("  (nothing was written: this probe installs, stops and starts nothing)\n");
process.exit(report.finish());
