/**
 * Step 1 pause-point probe: prints the library exactly as the launcher would
 * enumerate it.
 *
 * This is a READ-ONLY diagnostic. It exists so the fixture library built by
 * `sidecar/test/library.js` can be inspected by eye - "what would Recent
 * Versions show, and what would the storage prompt count?" - without running the
 * launcher, the sidecar service, or any harness process.
 *
 * It writes nothing except creating the scratch data directory if it is absent,
 * and it never deletes anything.
 *
 * Run from the repo root:
 *   node sidecar/test/library-probe.js
 *   $env:DSH_DOCK_DATA_DIR='C:\some\where'; node sidecar/test/library-probe.js
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");

// Default to the fixture library the test suite builds. An explicit override is
// honoured so the probe can be pointed at any library, including a real one.
process.env.DSH_DOCK_DATA_DIR ??= path.join(REPO_ROOT, ".test-tmp", "library");

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");

const PATHS = state.resolveStatePaths();
fs.mkdirSync(PATHS.versions, { recursive: true });

// The catalogue is admitted only as a SOURCE OF DATES here, which is exactly the
// advisory role it plays in the launcher. Enumeration itself never reads it.
let installedAt = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(PATHS.versions, "catalogue.json"), "utf8"));
  installedAt = Object.fromEntries(
    Object.entries(raw.versions ?? {}).map(([version, entry]) => [version, entry.installedAt ?? null]),
  );
} catch {
  // No catalogue: the library still enumerates, with unknown dates.
}

console.log(`data dir:   ${PATHS.root}`);
console.log(`library:    ${PATHS.versions}\n`);

const entries = library.listInstalledVersions({ paths: PATHS, installedAt });
console.log(`enumerated ${entries.length} version(s):`);
console.log(library.describeLibrary(entries));

const ready = entries.filter((entry) => entry.state === library.LIBRARY_STATE.INSTALLED);
const partialEntries = entries.filter((entry) => entry.state === library.LIBRARY_STATE.PARTIAL);
console.log(`\nready to run:  ${ready.length}  (${ready.map((entry) => entry.version).join(", ") || "none"})`);
console.log(`partial:       ${partialEntries.length}  (${partialEntries.map((entry) => entry.version).join(", ") || "none"})`);

console.log("\nwhat section 3.8's Recent Versions would show (newest 5):");
for (const entry of library.listReadyVersions({ paths: PATHS, installedAt }).slice(0, 5)) {
  console.log(`  v${entry.version}${entry.installedAt ? `   (${entry.installedAt})` : "   (no date)"}`);
}

const leftovers = library.partialInstallDirs({ paths: PATHS });
console.log("\nleftovers (never counted as versions, never shown in the menu):");
console.log(`  staging directories:  ${leftovers.staging.join(", ") || "none"}`);
console.log(`  incomplete installs:  ${leftovers.incomplete.join(", ") || "none"}`);
console.log(`  corrupt backups:      ${leftovers.corrupt.join(", ") || "none"}`);
