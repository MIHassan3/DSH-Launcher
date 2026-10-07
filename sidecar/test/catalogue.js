/**
 * Step 2 - the version library catalogue.
 *
 * Structure of this test:
 *
 *   fixtures    - a scratch library in the repo's .test-tmp containing one
 *                 validated install, one hand-made install the catalogue does
 *                 NOT know about, and one catalogue-only entry naming a version
 *                 that is not on disk. Those three are what the advisory
 *                 guarantee is tested against.
 *   document    - the schema: validation, per-entry tolerance, version refusal.
 *   read/write  - round-trip, atomicity, the absent case.
 *   corruption  - unparseable, wrong-shaped, too-large and newer-schema files,
 *                 and the quarantine that preserves each one.
 *   recording   - recordInstall / removeEntry / pruneCatalogue, including every
 *                 write-failure path.
 *   advisory    - the two properties the whole design rests on: a version on
 *                 disk with no entry is still installed, and an entry with no
 *                 version on disk is ignored.
 *
 * NOTHING HERE SPAWNS OR KILLS A PROCESS, touches the network, or writes outside
 * .test-tmp. The data directory is redirected with DSH_DOCK_DATA_DIR before any
 * module that resolves it is imported.
 *
 * Run from the repo root:
 *   node sidecar/test/catalogue.js
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "catalogue");

process.env.DSH_DOCK_DATA_DIR = TMP_ROOT;

const report = createReport("DSH-Dock catalogue: advisory version index");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");
const catalogue = await import("../lib/catalogue.js");

const PATHS = state.resolveStatePaths();
const VERSIONS = PATHS.versions;
const CATALOGUE_FILE = path.join(VERSIONS, "catalogue.json");

/** Reads the catalogue file verbatim, for assertions about its on-disk form. */
function rawCatalogue() {
  return JSON.parse(fs.readFileSync(CATALOGUE_FILE, "utf8"));
}

/** Removes the catalogue and any quarantine siblings, leaving the library. */
function clearCatalogue() {
  for (const entry of fs.readdirSync(VERSIONS)) {
    if (entry === "catalogue.json" || entry.startsWith(library.CORRUPT_PREFIX)) {
      fs.rmSync(path.join(VERSIONS, entry), { recursive: true, force: true });
    }
  }
}

/** Quarantine siblings currently in the library root. */
function quarantineFiles() {
  return fs.readdirSync(VERSIONS).filter((entry) => entry.startsWith(library.CORRUPT_PREFIX)).sort();
}

// --- fixtures ---------------------------------------------------------------

fs.mkdirSync(VERSIONS, { recursive: true });

/**
 * Builds a validated install tree for a version.
 *
 * SHA-256 of the resulting `package.json` is NOT fixed, because the version
 * string is written into it; that is intentional, so a checksum assertion cannot
 * pass by accident.
 */
function makeVersion(version) {
  const installDir = path.join(VERSIONS, version);
  const scope = path.join(installDir, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(scope, "dsh", "lib"), { recursive: true });
  fs.mkdirSync(path.join(scope, "dsh-web-app"), { recursive: true });
  fs.writeFileSync(
    path.join(scope, "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2),
  );
  fs.writeFileSync(path.join(scope, "dsh", "lib", "bin.js"), "// fixture entry point\n");
  fs.writeFileSync(
    path.join(scope, "dsh-web-app", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }, null, 2),
  );
  return installDir;
}

// Installed on disk AND (later) in the catalogue.
makeVersion("0.2.0-rc.2");
// Installed on disk by hand: the catalogue will never know about this one.
makeVersion("0.1.5");

// --- document validation (pure) --------------------------------------------

await report.section("catalogue document validation (pure)", () => {
  const empty = catalogue.emptyCatalogue("2026-10-04T00:00:00Z");
  report.check("the empty document has the current schema", empty.schemaVersion === catalogue.CATALOGUE_SCHEMA_VERSION);
  report.check("the empty document has no versions", Object.keys(empty.versions).length === 0);
  report.check("the empty document records when it was made", empty.updatedAt === "2026-10-04T00:00:00Z");

  const good = {
    schemaVersion: 1,
    updatedAt: "2026-10-04T00:00:00Z",
    versions: {
      "0.2.0-rc.2": {
        installedAt: "2026-10-03T00:00:00Z",
        source: "next",
        installDir: "0.2.0-rc.2",
        checksum: `sha256:${"a".repeat(64)}`,
      },
    },
  };
  const validated = catalogue.validateCatalogueDocument(good);
  report.check("a valid document validates", validated.ok === true, JSON.stringify(validated.problems));
  report.check("a valid document keeps its entries", Object.keys(validated.document.versions).length === 1);
  report.check("a valid document drops nothing", validated.droppedEntries.length === 0);

  const rejected = [
    ["null", null],
    ["an array", []],
    ["a string", "not a catalogue"],
    ["a number", 7],
    ["a document with no schemaVersion", { updatedAt: "x", versions: {} }],
    ["a document with a future schemaVersion", { schemaVersion: 99, versions: {} }],
    ["a document whose versions is an array", { schemaVersion: 1, versions: [] }],
    ["a document whose versions is null", { schemaVersion: 1, versions: null }],
  ];
  for (const [label, value] of rejected) {
    const result = catalogue.validateCatalogueDocument(value);
    report.check(`rejects ${label}`, result.ok === false, JSON.stringify(result.problems));
  }

  report.check(
    "a future schemaVersion says so explicitly",
    (catalogue.validateCatalogueDocument({ schemaVersion: 99, versions: {} }).problems[0] ?? "").includes(
      "newer build",
    ),
  );

  const mixed = catalogue.validateCatalogueDocument({
    schemaVersion: 1,
    updatedAt: "2026-10-04T00:00:00Z",
    versions: {
      "1.0.0": { installedAt: "2026-10-01T00:00:00Z", source: "latest", installDir: "1.0.0", checksum: null },
      "2.0.0": { installedAt: "not a date", source: "latest", installDir: "2.0.0" },
      "3.0.0": { source: "latest", installDir: "3.0.0" },
      "4.0.0": { installedAt: "2026-10-01T00:00:00Z", source: "", installDir: "4.0.0" },
      "5.0.0": { installedAt: "2026-10-01T00:00:00Z", source: "latest" },
      "6.0.0": { installedAt: "2026-10-01T00:00:00Z", source: "latest", installDir: "6.0.0", checksum: "sha256:short" },
      "not a version": { installedAt: "2026-10-01T00:00:00Z", source: "latest", installDir: "x" },
      "7.0.0": "not an object",
    },
  });
  report.check("a document with one bad entry is still usable", mixed.ok === true);
  report.check(
    "the good entry survives",
    Object.keys(mixed.document.versions).join(",") === "1.0.0",
    JSON.stringify(Object.keys(mixed.document.versions)),
  );
  report.check(
    "every bad entry is named",
    mixed.droppedEntries.length === 7,
    JSON.stringify(mixed.droppedEntries),
  );
  report.check(
    "every bad entry reports why",
    mixed.problems.some((problem) => problem.includes("installedAt")) &&
      mixed.problems.some((problem) => problem.includes("source")) &&
      mixed.problems.some((problem) => problem.includes("installDir")) &&
      mixed.problems.some((problem) => problem.includes("checksum")) &&
      mixed.problems.some((problem) => problem.includes("not a valid version name")) &&
      mixed.problems.some((problem) => problem.includes("not a JSON object")),
    JSON.stringify(mixed.problems),
  );
  report.check(
    "a missing updatedAt degrades to the epoch rather than failing",
    catalogue.validateCatalogueDocument({ schemaVersion: 1, versions: {} }).document.updatedAt ===
      new Date(0).toISOString(),
  );

  report.check(
    "an entry with a null checksum is valid (a partial tree still gets a date)",
    catalogue.validateCatalogueEntry("1.0.0", {
      installedAt: "2026-10-01T00:00:00Z",
      source: "latest",
      installDir: "1.0.0",
      checksum: null,
    }).length === 0,
  );
  report.check(
    "an entry with a malformed checksum is refused",
    catalogue.validateCatalogueEntry("1.0.0", {
      installedAt: "2026-10-01T00:00:00Z",
      source: "latest",
      installDir: "1.0.0",
      checksum: "deadbeef",
    }).length === 1,
  );
});

// --- absence ----------------------------------------------------------------

await report.section("an absent catalogue is a normal state", () => {
  clearCatalogue();
  const read = catalogue.readCatalogue({ paths: PATHS });

  report.check("the status is absent", read.status === catalogue.CATALOGUE_STATUS.ABSENT);
  report.check("the document is empty but valid", Object.keys(read.document.versions).length === 0);
  report.check("the document has the current schema", read.document.schemaVersion === catalogue.CATALOGUE_SCHEMA_VERSION);
  report.check("no problems are reported", read.problems.length === 0);
  report.check("nothing is quarantined", read.quarantinedTo === null);
  report.check(
    "reading does not create the file",
    fs.existsSync(CATALOGUE_FILE) === false,
    "a read must never have side effects",
  );

  const health = catalogue.catalogueHealth({ paths: PATHS });
  report.check("health reports absent", health.status === catalogue.CATALOGUE_STATUS.ABSENT);
  report.check("health says so in words", health.message.includes("no version catalogue yet"), health.message);
  report.check("an absent catalogue yields no dates", Object.keys(catalogue.readInstalledAt({ paths: PATHS })).length === 0);
});

// --- round trip -------------------------------------------------------------

await report.section("write and read round-trip", () => {
  clearCatalogue();

  const first = catalogue.recordInstall("0.2.0-rc.2", {
    paths: PATHS,
    now: "2026-10-03T00:00:00Z",
    source: "next",
  });
  report.check("the install is recorded", first.recorded === true, JSON.stringify(first));
  report.check("the result says recorded", first.catalogue === "recorded");
  report.check("no reason is reported on success", first.reason === null);
  report.check("the entry carries the timestamp", first.entry.installedAt === "2026-10-03T00:00:00Z");
  report.check("the entry carries the source", first.entry.source === "next");
  report.check("the entry names the package", first.entry.package === "@deepseek-ai/dsh");
  report.check(
    "the checksum is derived from the installed manifest",
    /^sha256:[0-9a-f]{64}$/.test(first.entry.checksum ?? ""),
    first.entry.checksum,
  );
  report.check("the installDir is stored relative, not absolute", first.entry.installDir === "0.2.0-rc.2");
  report.check("the file now exists", fs.existsSync(CATALOGUE_FILE) === true);

  const onDisk = rawCatalogue();
  report.check("the on-disk document has the wrapper shape", onDisk.schemaVersion === 1 && typeof onDisk.versions === "object");
  report.check("the on-disk document records when it changed", onDisk.updatedAt === "2026-10-03T00:00:00Z");
  report.check("the on-disk entry matches what was returned", onDisk.versions["0.2.0-rc.2"].source === "next");
  report.check(
    "the file is pretty-printed with a trailing newline (house style)",
    fs.readFileSync(CATALOGUE_FILE, "utf8").startsWith("{\n  \"schemaVersion\"") &&
      fs.readFileSync(CATALOGUE_FILE, "utf8").endsWith("\n"),
  );
  report.check(
    "the write is atomic: no temp file is left behind",
    fs.readdirSync(VERSIONS).some((entry) => entry.endsWith(".tmp")) === false,
    JSON.stringify(fs.readdirSync(VERSIONS)),
  );

  const read = catalogue.readCatalogue({ paths: PATHS });
  report.check("reading it back is ok", read.status === catalogue.CATALOGUE_STATUS.OK);
  report.check("the entry survives the round trip", read.document.versions["0.2.0-rc.2"].source === "next");
  report.check("no entries are dropped", read.droppedEntries.length === 0);
  report.check(
    "the dates map is ready for listInstalledVersions",
    catalogue.readInstalledAt({ paths: PATHS })["0.2.0-rc.2"] === "2026-10-03T00:00:00Z",
  );

  const second = catalogue.recordInstall("0.1.5", {
    paths: PATHS,
    now: "2026-10-04T00:00:00Z",
    source: "0.1.5",
    packageName: "@deepseek-ai/dsh",
  });
  report.check("a second install is recorded", second.recorded === true);
  const both = rawCatalogue();
  report.check("recording does not lose the previous entry", Object.keys(both.versions).length === 2);
  report.check("both entries are present", both.versions["0.2.0-rc.2"] !== undefined && both.versions["0.1.5"] !== undefined);

  const again = catalogue.recordInstall("0.1.5", {
    paths: PATHS,
    now: "2026-10-05T00:00:00Z",
    source: "0.1.5",
  });
  report.check("re-recording the same version updates rather than duplicates", again.recorded === true);
  report.check(
    "the newer timestamp wins",
    rawCatalogue().versions["0.1.5"].installedAt === "2026-10-05T00:00:00Z",
  );
  report.check("still two entries", Object.keys(rawCatalogue().versions).length === 2);

  report.check(
    "an unsafe version is refused, with a named reason",
    catalogue.recordInstall("../../evil", { paths: PATHS }).reason === catalogue.UNRECORDED_REASON.UNSAFE_VERSION,
  );
  report.check(
    "the catalogue file is not a version name",
    catalogue.recordInstall("catalogue.json", { paths: PATHS }).recorded === false,
  );
  report.check(
    "an explicit installDir is stored relative",
    catalogue.recordInstall("0.2.0-rc.2", {
      paths: PATHS,
      installDir: path.join(VERSIONS, "0.2.0-rc.2"),
      now: "2026-10-06T00:00:00Z",
    }).entry.installDir === "0.2.0-rc.2",
  );

  const health = catalogue.catalogueHealth({ paths: PATHS });
  report.check("health reports ok", health.status === catalogue.CATALOGUE_STATUS.OK);
  report.check("health counts the entries", health.entries === 2, health.message);
  report.check("health names the count in words", health.message.includes("2 entries"), health.message);
});

// --- removal and pruning ----------------------------------------------------

await report.section("removing and pruning entries", () => {
  const removed = catalogue.removeEntry("0.1.5", { paths: PATHS, now: "2026-10-06T00:00:00Z" });
  report.check("the entry is removed", removed.removed === true, JSON.stringify(removed));
  report.check("it is gone from disk", rawCatalogue().versions["0.1.5"] === undefined);
  report.check("the other entry survives", rawCatalogue().versions["0.2.0-rc.2"] !== undefined);

  const twice = catalogue.removeEntry("0.1.5", { paths: PATHS });
  report.check("removing a missing entry is not an error", twice.removed === false && twice.error === null);
  report.check("and it says the entry was not there", twice.message.includes("was not in"), twice.message);
  report.check(
    "removing an unsafe name is refused",
    catalogue.removeEntry("../../evil", { paths: PATHS }).removed === false,
  );

  // A version deleted outside the launcher leaves a stale entry. Nothing breaks
  // while it is there, and pruning must be visible rather than silent.
  catalogue.recordInstall("9.9.9", { paths: PATHS, now: "2026-10-07T00:00:00Z", source: "9.9.9" });
  report.check("the phantom entry is on disk", rawCatalogue().versions["9.9.9"] !== undefined);

  const pruned = catalogue.pruneCatalogue({ paths: PATHS, now: "2026-10-08T00:00:00Z" });
  report.check("the phantom entry is pruned", JSON.stringify(pruned.pruned) === JSON.stringify(["9.9.9"]), JSON.stringify(pruned));
  report.check("the real entry is untouched", rawCatalogue().versions["0.2.0-rc.2"] !== undefined);
  report.check("a second prune finds nothing", catalogue.pruneCatalogue({ paths: PATHS }).pruned.length === 0);
  report.check("a nothing-to-prune result does not rewrite the file", rawCatalogue().updatedAt === "2026-10-08T00:00:00Z");
});

// --- corruption -------------------------------------------------------------

await report.section("an unparseable catalogue is quarantined and degraded", () => {
  clearCatalogue();
  fs.mkdirSync(VERSIONS, { recursive: true });
  fs.writeFileSync(CATALOGUE_FILE, "{ this is not json");

  const read = catalogue.readCatalogue({ paths: PATHS });
  report.check("the status is corrupt, not ok", read.status === catalogue.CATALOGUE_STATUS.CORRUPT);
  report.check("the document degrades to empty", Object.keys(read.document.versions).length === 0);
  report.check("the reason names the parse failure", read.problems.join(" ").includes("not valid JSON"), JSON.stringify(read.problems));
  report.check("a copy is preserved", read.quarantinedTo !== null, read.quarantinedTo);
  report.check("the copy exists on disk", fs.existsSync(read.quarantinedTo) === true);
  report.check("the copy is inside the library root", library.isPathInsideVersions(read.quarantinedTo, { paths: PATHS }) === true);
  report.check("the copy kept the original bytes", fs.readFileSync(read.quarantinedTo, "utf8") === "{ this is not json");
  report.check("the bad file was moved, not copied", fs.existsSync(CATALOGUE_FILE) === false);
  report.check(
    "the library root still holds a quarantine sibling, which enumeration ignores",
    quarantineFiles().length === 1,
    JSON.stringify(quarantineFiles()),
  );
  report.check(
    "the quarantine file is not enumerated as a version",
    library.scanLibraryRoot({ paths: PATHS }).versions.includes(quarantineFiles()[0]) === false,
  );

  // A diagnostic must not mutate, so the health check is asked about a corrupt
  // catalogue that is still IN PLACE - the state the previous read just tidied
  // away. This is the regression test for the mutation bug the first run caught.
  fs.writeFileSync(CATALOGUE_FILE, "{ this is not json");
  const health = catalogue.catalogueHealth({ paths: PATHS });
  report.check("health reports corrupt", health.status === catalogue.CATALOGUE_STATUS.CORRUPT, JSON.stringify(health));
  report.check(
    "health leaves the bad file exactly where it found it",
    fs.readFileSync(CATALOGUE_FILE, "utf8") === "{ this is not json",
  );
  report.check(
    "health creates no new quarantine sibling",
    quarantineFiles().length === 1,
    JSON.stringify(quarantineFiles()),
  );
  report.check(
    "health still points at the copy preserved earlier",
    path.basename(health.quarantinedTo ?? "") === quarantineFiles()[0] && health.message.includes("preserved at"),
    `${health.quarantinedTo} vs ${quarantineFiles()[0]}`,
  );
  report.check(
    "health is idempotent: asking twice gives the same answer",
    catalogue.catalogueHealth({ paths: PATHS }).status === health.status &&
      catalogue.catalogueHealth({ paths: PATHS }).message === health.message,
  );
});

await report.section("a wrongly-shaped catalogue is quarantined", () => {
  clearCatalogue();
  fs.writeFileSync(CATALOGUE_FILE, JSON.stringify({ schemaVersion: 99, versions: {} }));

  const read = catalogue.readCatalogue({ paths: PATHS });
  report.check("a future schema is corrupt to this build", read.status === catalogue.CATALOGUE_STATUS.CORRUPT);
  report.check("the reason explains why", read.problems.join(" ").includes("newer build"), JSON.stringify(read.problems));
  report.check("it is preserved rather than deleted", read.quarantinedTo !== null && fs.existsSync(read.quarantinedTo));

  clearCatalogue();
  fs.writeFileSync(CATALOGUE_FILE, JSON.stringify([1, 2, 3]));
  report.check(
    "a JSON array is refused as a document",
    catalogue.readCatalogue({ paths: PATHS }).status === catalogue.CATALOGUE_STATUS.CORRUPT,
  );

  clearCatalogue();
  fs.writeFileSync(CATALOGUE_FILE, JSON.stringify({ schemaVersion: 1, versions: [] }));
  report.check(
    "an array of versions is refused",
    catalogue.readCatalogue({ paths: PATHS }).status === catalogue.CATALOGUE_STATUS.CORRUPT,
  );
});

await report.section("an oversized catalogue is refused without being loaded", () => {
  clearCatalogue();
  // Valid JSON, over the cap. The point is that the SIZE check fires before the
  // parse, so a huge file cannot be read into memory to find out it is garbage.
  const filler = `"${"x".repeat(64)}"`;
  const entries = Array.from({ length: 20000 }, (_, index) => `"1.0.${index}":${filler}`).join(",");
  fs.writeFileSync(CATALOGUE_FILE, `{"schemaVersion":1,"updatedAt":"2026-10-01T00:00:00Z","versions":{${entries}}}`);
  const size = fs.statSync(CATALOGUE_FILE).size;
  report.check("the fixture really is over the cap", size > catalogue.MAX_CATALOGUE_BYTES, `${size} bytes`);

  const read = catalogue.readCatalogue({ paths: PATHS });
  report.check("the status is corrupt", read.status === catalogue.CATALOGUE_STATUS.CORRUPT);
  report.check("the reason names the size", read.problems.join(" ").includes("over the"), JSON.stringify(read.problems));
  report.check("it is preserved", read.quarantinedTo !== null && fs.existsSync(read.quarantinedTo));
});

await report.section("quarantine never overwrites an earlier one", () => {
  clearCatalogue();
  fs.writeFileSync(CATALOGUE_FILE, "garbage one");
  const first = catalogue.quarantineCatalogue({ paths: PATHS, now: "2026-10-09T12:00:00.000Z" });
  fs.writeFileSync(CATALOGUE_FILE, "garbage two");
  const second = catalogue.quarantineCatalogue({ paths: PATHS, now: "2026-10-09T12:00:00.000Z" });

  report.check("both quarantines produced a destination", first.movedTo !== null && second.movedTo !== null);
  report.check("the destinations differ", first.movedTo !== second.movedTo, `${first.movedTo} vs ${second.movedTo}`);
  report.check("both files survive", fs.existsSync(first.movedTo) && fs.existsSync(second.movedTo));
  report.check(
    "the first copy still holds its own bytes",
    fs.readFileSync(first.movedTo, "utf8") === "garbage one",
  );
  report.check(
    "the second copy holds its own bytes",
    fs.readFileSync(second.movedTo, "utf8") === "garbage two",
  );
  report.check("the quarantine names carry the timestamp", path.basename(first.movedTo).includes("2026-10-09T12-00-00-000Z"));
});

await report.section("reading can be asked not to quarantine", () => {
  clearCatalogue();
  fs.writeFileSync(CATALOGUE_FILE, "still garbage");

  const read = catalogue.readCatalogue({ paths: PATHS, quarantine: false });
  report.check("the status is still reported corrupt", read.status === catalogue.CATALOGUE_STATUS.CORRUPT);
  report.check("no quarantine destination is claimed", read.quarantinedTo === null);
  report.check("the bad file is left exactly where it was", fs.readFileSync(CATALOGUE_FILE, "utf8") === "still garbage");
  report.check("no sibling was created", quarantineFiles().length === 0, JSON.stringify(quarantineFiles()));

  const health = catalogue.catalogueHealth({ paths: PATHS });
  report.check(
    "health explains that it could not be preserved",
    health.message.includes("could not be preserved"),
    health.message,
  );
});

// --- write failures are never install failures ------------------------------

await report.section("a catalogue write failure never fails an install", () => {
  // The unwritable case is produced structurally rather than with permissions, so
  // it behaves identically on Windows and POSIX: make the LIBRARY ROOT a path
  // that cannot be a directory, by putting a file where it must go.
  const blockedRoot = path.join(TMP_ROOT, "blocked");
  fs.rmSync(blockedRoot, { recursive: true, force: true });
  fs.writeFileSync(blockedRoot, "I am a file, not a directory\n");

  const blockedPaths = { ...PATHS, versions: path.join(blockedRoot, "versions") };
  const write = catalogue.writeCatalogue(catalogue.emptyCatalogue(), { paths: blockedPaths });
  report.check("the write reports failure rather than throwing", write.written === false, JSON.stringify(write));
  report.check("the write reports why", typeof write.error === "string" && write.error.length > 0, write.error);
  report.check("the write names the path it tried", write.path.includes("catalogue.json"), write.path);

  const result = catalogue.recordInstall("0.2.0-rc.2", {
    paths: blockedPaths,
    now: "2026-10-10T00:00:00Z",
    source: "next",
  });
  report.check("recording reports unrecorded, not a throw", result.recorded === false, JSON.stringify(result));
  report.check("the reason is write-failed", result.reason === catalogue.UNRECORDED_REASON.WRITE_FAILED);
  report.check("the result says unrecorded", result.catalogue === "unrecorded");
  report.check(
    "the message says the version is installed and runnable anyway",
    result.message.includes("installed and runnable"),
    result.message,
  );
  report.check("the entry it would have written is still reported", result.entry !== null);
  report.check("the error is carried for the log", result.error !== null);

  // `removeEntry` needs the version to already BE in the catalogue for the
  // removal to be attempted at all, so record it once while writes still work -
  // then re-point at the blocked root.
  catalogue.recordInstall("0.2.0-rc.2", { paths: PATHS, now: "2026-10-10T00:00:00Z", source: "next" });
  const blockedDocument = catalogue.readCatalogue({ paths: PATHS }).document;
  const removed = catalogue.removeEntry("0.2.0-rc.2", {
    paths: blockedPaths,
    document: blockedDocument,
  });
  report.check("removal on a blocked catalogue reports unrecorded, not a throw", removed.removed === false, JSON.stringify(removed));
  report.check(
    "removal's message distinguishes disk from catalogue",
    removed.message.includes("from disk"),
    removed.message,
  );

  // Pruning has nothing to prune against a blocked root (its read is empty), so
  // this asserts the no-op shape rather than a write failure.
  const pruned = catalogue.pruneCatalogue({ paths: blockedPaths });
  report.check("pruning against a blocked root is a safe no-op", pruned.catalogue === "unchanged", JSON.stringify(pruned));

  // `readCatalogue` on a path that does not exist is ABSENT, not corrupt: "there
  // is no catalogue here" is a normal state, and a blocked install directory is
  // indistinguishable from a fresh one until something tries to write.
  const blockedHealth = catalogue.catalogueHealth({ paths: blockedPaths });
  report.check(
    "health on a blocked root reports absent rather than throwing",
    blockedHealth.status === catalogue.CATALOGUE_STATUS.ABSENT,
    JSON.stringify(blockedHealth),
  );

  fs.rmSync(blockedRoot, { recursive: true, force: true });
});

await report.section("reads never throw on odd inputs", () => {
  report.check(
    "a directory where the catalogue should be is reported, not thrown",
    (() => {
      const dirRoot = path.join(TMP_ROOT, "dir-catalogue");
      const versions = path.join(dirRoot, "versions");
      fs.mkdirSync(path.join(versions, "catalogue.json"), { recursive: true });
      const read = catalogue.readCatalogue({ paths: { ...PATHS, versions } });
      return read.status === catalogue.CATALOGUE_STATUS.CORRUPT && read.problems.join(" ").includes("directory");
    })(),
  );

  report.check(
    "a catalogue path that cannot be stat'd is reported, not thrown",
    (() => {
      const read = catalogue.readCatalogue({ paths: PATHS, file: "\0bad\0path" });
      return read.status === catalogue.CATALOGUE_STATUS.CORRUPT;
    })(),
  );

  report.check("installedAtMap tolerates a missing document", Object.keys(catalogue.installedAtMap(undefined)).length === 0);
  report.check("installedAtMap tolerates a missing versions map", Object.keys(catalogue.installedAtMap({})).length === 0);
  report.check(
    "a null installedAt is preserved as null rather than dropped",
    catalogue.installedAtMap({ versions: { "1.0.0": { installedAt: null } } })["1.0.0"] === null,
  );
});

// --- the advisory guarantee -------------------------------------------------

await report.section("the catalogue is advisory: the filesystem is ground truth", () => {
  clearCatalogue();
  catalogue.recordInstall("0.2.0-rc.2", { paths: PATHS, now: "2026-10-03T00:00:00Z", source: "next" });
  // A catalogue entry for a version that is NOT on disk.
  catalogue.recordInstall("9.9.9", { paths: PATHS, now: "2026-10-02T00:00:00Z", source: "alpha" });

  const dates = catalogue.readInstalledAt({ paths: PATHS });
  const entries = library.listInstalledVersions({ paths: PATHS, installedAt: dates });
  const versions = entries.map((entry) => entry.version);

  report.check(
    "a version on disk with no catalogue entry is still enumerated and still installed",
    versions.includes("0.1.5") &&
      entries.find((entry) => entry.version === "0.1.5").state === library.LIBRARY_STATE.INSTALLED,
    JSON.stringify(versions),
  );
  report.check(
    "the unrecorded version reports no date rather than a fabricated one",
    entries.find((entry) => entry.version === "0.1.5").installedAt === null,
  );
  report.check(
    "a catalogue entry with no version on disk is NOT enumerated",
    versions.includes("9.9.9") === false,
    JSON.stringify(versions),
  );
  report.check(
    "the dated version sorts by its catalogue date",
    entries[0].version === "0.2.0-rc.2",
    JSON.stringify(entries.map((entry) => `${entry.version}@${entry.installedAt}`)),
  );

  // Now remove the catalogue entirely. Enumeration must be identical apart from
  // the dates - that is the whole guarantee.
  clearCatalogue();
  const withoutCatalogue = library.listInstalledVersions({ paths: PATHS });
  report.check(
    "with no catalogue, the same versions are enumerated",
    JSON.stringify(withoutCatalogue.map((entry) => entry.version).sort()) === JSON.stringify([...versions].sort()),
    JSON.stringify(withoutCatalogue.map((entry) => entry.version)),
  );
  report.check(
    "with no catalogue, every state is unchanged",
    withoutCatalogue.every(
      (entry) => entry.state === entries.find((other) => other.version === entry.version).state,
    ),
  );
  report.check(
    "with no catalogue, every entry reports no date",
    withoutCatalogue.every((entry) => entry.installedAt === null),
  );

  // And a corrupt catalogue must be no worse than none.
  fs.writeFileSync(CATALOGUE_FILE, "{{{ not json");
  const withCorrupt = library.listInstalledVersions({
    paths: PATHS,
    installedAt: catalogue.readInstalledAt({ paths: PATHS }),
  });
  report.check(
    "a corrupt catalogue degrades to the same enumeration as no catalogue",
    JSON.stringify(withCorrupt.map((entry) => entry.version).sort()) ===
      JSON.stringify(withoutCatalogue.map((entry) => entry.version).sort()),
    JSON.stringify(withCorrupt.map((entry) => entry.version)),
  );
  report.check(
    "and every state is still correct",
    withCorrupt.every((entry) => entry.state === library.LIBRARY_STATE.INSTALLED),
    JSON.stringify(withCorrupt.map((entry) => `${entry.version}:${entry.state}`)),
  );
});

await report.section("a catalogue entry cannot redirect a library operation", () => {
  clearCatalogue();
  // A hand-written entry claiming an install directory somewhere else entirely.
  fs.writeFileSync(
    CATALOGUE_FILE,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-10-11T00:00:00Z",
      versions: {
        "0.2.0-rc.2": {
          installedAt: "2026-10-11T00:00:00Z",
          source: "next",
          installDir: path.join(TMP_ROOT, "somewhere-else"),
          checksum: null,
        },
      },
    }),
  );

  const read = catalogue.readCatalogue({ paths: PATHS });
  report.check("the entry parses (it is well-formed JSON)", read.status === catalogue.CATALOGUE_STATUS.OK);
  report.check(
    "the entry is accepted as advisory data",
    read.document.versions["0.2.0-rc.2"].installDir === path.join(TMP_ROOT, "somewhere-else"),
  );

  const entries = library.listInstalledVersions({ paths: PATHS, installedAt: catalogue.readInstalledAt({ paths: PATHS }) });
  const entry = entries.find((candidate) => candidate.version === "0.2.0-rc.2");
  report.check(
    "the library derives the install directory from the version name, not the catalogue",
    entry.installDir === path.join(VERSIONS, "0.2.0-rc.2"),
    entry.installDir,
  );
  report.check(
    "and the derived path is still inside the library root",
    library.isPathInsideVersions(entry.installDir, { paths: PATHS }) === true,
  );
  report.check(
    "the version still validates from its real tree",
    entry.state === library.LIBRARY_STATE.INSTALLED,
  );
  report.check(
    "the redirect target was never touched",
    fs.existsSync(path.join(TMP_ROOT, "somewhere-else")) === false,
  );
});

// The model must be usable with no arguments at all, resolving the ambient data
// directory - that is how production calls it.
await report.section("the default paths resolve to the redirected data directory", () => {
  report.check("the catalogue path is under the redirected root", catalogue.cataloguePath().startsWith(TMP_ROOT));
  report.check(
    "the catalogue path is the library root's catalogue.json",
    catalogue.cataloguePath() === path.join(PATHS.versions, "catalogue.json"),
  );
  report.check("the file name is the one library.js excludes from enumeration", catalogue.CATALOGUE_FILE_NAME === "catalogue.json");
  report.check("checksumFor is re-exported here", typeof catalogue.checksumFor === "function");
  report.check(
    "the re-export is the same function as the library's",
    catalogue.checksumFor === library.checksumFor,
  );
});

process.exit(report.finish());
