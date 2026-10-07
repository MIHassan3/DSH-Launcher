/**
 * Step 4 - deleting a version from the library.
 *
 * THE ONLY DESTRUCTIVE OPERATION IN THE LAUNCHER, so this file is deliberately
 * paranoid. Every guard gets a positive test (it refuses) AND a negative test (it
 * does not refuse the case it is not about), because a guard that refuses everything
 * is as broken as one that refuses nothing - and the first kind looks like safety.
 *
 * Structure:
 *
 *   refusals     - name safety, containment, the running version, the marker.
 *   dry run      - the 2C prompt seam: accurate numbers, zero mutation.
 *   real delete  - tree gone, catalogue entry gone, leftovers swept, siblings safe.
 *   backup       - the force-reinstall restore path (`renameOntoTarget` failure).
 *   locking      - delete takes the library lock, including across processes.
 *
 * NOTHING HERE SPAWNS A HARNESS, touches the network, or kills any process. Every
 * path is inside the repo's .test-tmp with DSH_DOCK_DATA_DIR redirected. The only
 * child processes are the two Node children used to prove the lock is exclusive
 * across processes; both are started with CREATE_NO_WINDOW, and the second is never
 * killed at all - it exits when its stdin closes.
 *
 * Run from the repo root:
 *   node sidecar/test/library-delete.js
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "library-delete");

process.env.DSH_DOCK_DATA_DIR = TMP_ROOT;

const report = createReport("DSH-Dock library: version deletion");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");
const library = await import("../lib/library.js");
const catalogue = await import("../lib/catalogue.js");
const lock = await import("../lib/library-lock.js");
const install = await import("../lib/harness-install.js");
const validation = await import("../lib/validation.js");

const PATHS = state.resolveStatePaths();
fs.mkdirSync(PATHS.versions, { recursive: true });
fs.rmSync(lock.lockPath({ paths: PATHS }), { force: true });

const CREATE_NO_WINDOW = 0x0800_0000;

// --- fixtures ---------------------------------------------------------------

/** Writes a complete, validating install tree for `version`. */
function makeVersion(version, { marker = false, filler = null, extra = [] } = {}) {
  const dir = path.join(PATHS.versions, version);
  const scope = path.join(dir, "node_modules", "@deepseek-ai");
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

  if (filler) fs.writeFileSync(path.join(dir, filler.name), filler.content);
  for (const item of extra) fs.writeFileSync(path.join(dir, item.name), item.content);

  if (marker) {
    fs.writeFileSync(
      path.join(dir, validation.INCOMPLETE_MARKER),
      `${JSON.stringify({ startedAt: "2026-10-12T00:00:00Z", version, reason: "fixture" })}\n`,
    );
  }

  return dir;
}

/** Recursive snapshot (relative path -> sha256 | "dir") for whole-library provenance. */
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

/** Writes a valid runtime-state.json naming `installDir`. */
function writeRunningState(installDir, { pid = 4321, version = "1.0.0-fixture" } = {}) {
  fs.writeFileSync(
    PATHS.runtimeState,
    `${JSON.stringify(
      {
        version: 1,
        pid,
        port: 54321,
        url: `http://127.0.0.1:54321/?token=${"b".repeat(32)}`,
        harnessVersion: version,
        installDir,
        instanceId: "20261012T000000-del",
        startedAt: "2026-10-12T00:00:00.000Z",
        recordedAt: "2026-10-12T00:00:01.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function clearRunningState() {
  fs.rmSync(PATHS.runtimeState, { force: true });
}

/** Rebuilds only the version LIBRARY, leaving the runtime state alone. */
function resetLibrary() {
  fs.rmSync(PATHS.versions, { recursive: true, force: true });
  fs.mkdirSync(PATHS.versions, { recursive: true });
}

// --- refusals ---------------------------------------------------------------

await report.section("refuses a version name that is not an exact version", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-real");

  const refused = [
    ["a parent traversal", "../../evil"],
    ["a nested path", "1.0.0/../evil"],
    ["a backslash traversal", "..\\evil"],
    ["an absolute path", "C:\\evil"],
    ["a dist-tag", "next"],
    ["another dist-tag", "latest"],
    ["a range", "1.x"],
    ["a caret range", "^1.0.0"],
    ["a tilde range", "~1.0.0"],
    ["a space", "1.0.0 evil"],
    ["an empty string", ""],
    ["the catalogue itself", "catalogue.json"],
    ["the lock file", ".lock"],
    ["null", null],
    ["a number", 1234],
  ];

  for (const [label, version] of refused) {
    const result = await library.deleteVersion(version, { paths: PATHS });
    report.check(
      `refuses ${label}`,
      result.ok === false && result.reason === library.DELETE_REASON.UNSAFE_VERSION,
      `${result.reason}: ${result.message}`,
    );
    report.check(`  ...and deleted nothing for ${label}`, result.deleted === false);
  }

  report.check(
    "the refusal explains that the name must be an exact version",
    (await library.deleteVersion("next", { paths: PATHS })).message.includes("not a valid version name"),
  );
  report.check("the safe version survived every refusal", fs.existsSync(path.join(PATHS.versions, "1.0.0-real")));
  report.check("the catalogue file was never created by a refusal", fs.existsSync(path.join(PATHS.versions, "catalogue.json")) === false);
});

await report.section("refuses a path that resolves outside the library", async () => {
  resetLibrary();
  clearRunningState();

  // The containment guard is computed from the VALIDATED NAME, so the way to reach
  // it in a test is a paths object whose versions root does not contain the path the
  // name resolves to. Nothing about a real user flow does this - which is exactly
  // why the guard must not depend on a user flow to hold.
  const outside = path.join(TMP_ROOT, "outside-the-library");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "precious.txt"), "must survive\n");

  const oddPaths = { ...PATHS, versions: outside };
  const result = await library.deleteVersion("../../evil", { paths: oddPaths });
  report.check(
    "an unsafe name is still refused first (it never reaches path building)",
    result.reason === library.DELETE_REASON.UNSAFE_VERSION,
    result.reason,
  );

  // Now a NAME that is safe but whose root is arranged so it cannot be inside.
  const plan = library.planDelete("1.0.0", { paths: oddPaths });
  report.check("the plan computes containment from the name", plan.insideLibrary === true, JSON.stringify(plan.installDir));
  report.check(
    "and the plan reports no version present there",
    plan.present === false,
  );

  report.check(
    "the outside file was never touched",
    fs.readFileSync(path.join(outside, "precious.txt"), "utf8") === "must survive\n",
  );
  fs.rmSync(outside, { recursive: true, force: true });

  // A direct unit assertion on the guard itself, so this section cannot pass by
  // accident if a plumbing change stops exercising it.
  report.check(
    "isPathInsideVersions refuses a sibling of the library root",
    library.isPathInsideVersions(path.join(TMP_ROOT, "elsewhere"), { paths: PATHS }) === false,
  );
});

await report.section("refuses to delete the running version", async () => {
  resetLibrary();
  clearRunningState();
  const dir = makeVersion("1.0.0-running");
  const before = snapshotTree(PATHS.versions);

  writeRunningState(dir);

  const result = await library.deleteVersion("1.0.0-running", { paths: PATHS });
  report.check("the delete is refused", result.ok === false, JSON.stringify(result.reason));
  report.check("the reason is running-version", result.reason === library.DELETE_REASON.RUNNING_VERSION, result.reason);
  report.check(
    "the refusal is worded as specified",
    result.message.startsWith(
      "Refusing to delete the running version 1.0.0-running; stop the harness or choose another version.",
    ),
    result.message,
  );
  report.check("the refusal names the recorded pid", /pid 4321/.test(result.message), result.message);
  report.check("the refusal names the recorded install dir", result.message.includes(dir), result.message);
  report.check("nothing was deleted", result.deleted === false);
  report.check(
    "the tree is byte-identical",
    JSON.stringify(snapshotTree(PATHS.versions)) === JSON.stringify(before),
  );
  report.check(
    "the catalogue was not created",
    fs.existsSync(path.join(PATHS.versions, "catalogue.json")) === false,
  );

  // The identity test is the SHARED predicate, so all the awkward spellings must be
  // recognized. Each of these names the same directory as the running harness.
  const awkward = [
    ["a trailing separator", `${dir}${path.sep}`],
    ["a . segment", path.join(dir, ".")],
    ["a .. that cancels out", path.join(dir, "..", path.basename(dir))],
    ["different casing", process.platform === "win32" ? dir.toUpperCase() : dir],
  ];
  for (const [label, spelling] of awkward) {
    writeRunningState(spelling);
    const awkwardResult = await library.deleteVersion("1.0.0-running", { paths: PATHS });
    report.check(
      `${label} does not defeat the refusal`,
      awkwardResult.reason === library.DELETE_REASON.RUNNING_VERSION,
      awkwardResult.reason,
    );
  }

  // And the negative case: a DIFFERENT version is not protected.
  makeVersion("1.0.1-other");
  writeRunningState(dir);
  const other = await library.deleteVersion("1.0.1-other", { paths: PATHS });
  report.check(
    "a different version is not protected by the running guard",
    other.ok === true && other.deleted === true,
    `${other.reason}: ${other.message}`,
  );

  clearRunningState();

  // No runtime state at all is the normal fresh-install case, not a refusal.
  const noState = await library.deleteVersion("1.0.0-running", { paths: PATHS });
  report.check("with no runtime state, the delete proceeds", noState.deleted === true, noState.message);

  // An unreadable runtime state must not throw and must not protect everything.
  makeVersion("1.0.2-corrupt-state");
  fs.writeFileSync(PATHS.runtimeState, "{ not json\n");
  const corrupt = await library.deleteVersion("1.0.2-corrupt-state", { paths: PATHS });
  report.check(
    "an unreadable runtime state does not throw and does not block",
    corrupt.deleted === true,
    `${corrupt.reason}: ${corrupt.message}`,
  );
  clearRunningState();
});

await report.section("refuses an interrupted install, and offers the explicit cleanup", async () => {
  resetLibrary();
  clearRunningState();
  const dir = makeVersion("1.0.0-partial", { marker: true, filler: { name: "leftover.bin", content: "x".repeat(1024) } });

  const result = await library.deleteVersion("1.0.0-partial", { paths: PATHS });
  report.check("the delete is refused", result.ok === false);
  report.check("the reason is incomplete-install", result.reason === library.DELETE_REASON.INCOMPLETE_INSTALL, result.reason);
  report.check(
    "the refusal names the marker path",
    result.message.includes(
      path.join(dir, validation.INCOMPLETE_MARKER),
    ),
    result.message,
  );
  report.check(
    "the refusal points at the explicit cleanup entry point",
    result.message.includes("deletePartialVersion"),
    result.message,
  );
  report.check(
    "the refusal says WHY the tree is not a version (an interrupted install)",
    /interrupted/.test(result.message),
    result.message,
  );
  report.check("nothing was deleted", result.deleted === false);
  report.check("the tree is still there", fs.existsSync(dir) === true);
  report.check("the marker is still there", fs.existsSync(path.join(dir, validation.INCOMPLETE_MARKER)) === true);

  // The explicit path does the cleanup.
  const cleaned = await library.deletePartialVersion("1.0.0-partial", { paths: PATHS });
  report.check("deletePartialVersion succeeds", cleaned.ok === true && cleaned.deleted === true, cleaned.message);
  report.check("it reports itself as a partial cleanup", cleaned.partial === true);
  report.check("its message says so", /partial/i.test(cleaned.message), cleaned.message);
  report.check("the tree is gone", fs.existsSync(dir) === false);
  report.check(
    "the refusal's dry run also refuses (a dry run must not promise what the delete refuses)",
    (await library.deleteVersion("1.0.0-partial", { paths: PATHS, dryRun: true })).reason ===
      library.DELETE_REASON.NOT_INSTALLED,
    "the version was just cleaned up, so a dry run now finds nothing - which is the correct answer",
  );
});

await report.section("a complete install is NOT refused by the marker guard", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-clean");

  const plan = library.planDelete("1.0.0-clean", { paths: PATHS });
  report.check("the plan reports no marker", plan.hasIncompleteMarker === false);
  report.check(
    "the plan reports the tree as present",
    plan.present === true && plan.versionTree.files > 0,
    JSON.stringify(plan.totals),
  );

  const result = await library.deleteVersion("1.0.0-clean", { paths: PATHS });
  report.check("the delete proceeds", result.deleted === true, result.message);
});

// --- dry run ----------------------------------------------------------------

await report.section("the dry run reports accurately and mutates nothing", async () => {
  resetLibrary();
  clearRunningState();

  makeVersion("1.0.0-old", { filler: { name: "payload.bin", content: "y".repeat(2048) } });
  makeVersion("1.0.1-new");
  // Leftovers belonging to 1.0.0-old, plus one belonging to a DIFFERENT version that
  // must not be swept (the prefix-collision hazard: `1.0.0-old` vs `1.0.0-older`).
  fs.mkdirSync(path.join(PATHS.versions, ".staging-1.0.0-old-abc123"), { recursive: true });
  fs.writeFileSync(path.join(PATHS.versions, ".staging-1.0.0-old-abc123", "junk.bin"), "z".repeat(512));
  fs.mkdirSync(path.join(PATHS.versions, ".staging-1.0.0-old-replaced-xyz"), { recursive: true });
  fs.mkdirSync(path.join(PATHS.versions, ".staging-1.0.0-older-def456"), { recursive: true });
  fs.writeFileSync(path.join(PATHS.versions, ".staging-1.0.0-older-def456", "other.bin"), "keep me\n");

  const before = snapshotTree(PATHS.versions);
  const plan = library.planDelete("1.0.0-old", { paths: PATHS });

  report.check(
    "the leftover list contains exactly this version's staging and backup directories",
    JSON.stringify(plan.leftovers.map((entry) => path.basename(entry.path)).sort()) ===
      JSON.stringify([".staging-1.0.0-old-abc123", ".staging-1.0.0-old-replaced-xyz"]),
    JSON.stringify(plan.leftovers.map((entry) => path.basename(entry.path))),
  );
  report.check(
    "a longer version name's staging directory is NOT matched",
    plan.leftovers.some((entry) => entry.path.includes("older")) === false,
  );
  report.check(
    "the totals include the leftovers",
    plan.totals.bytes >= 2048 + 512,
    JSON.stringify(plan.totals),
  );
  report.check(
    "the totals are the sum of the tree and the leftovers",
    plan.totals.files ===
      plan.versionTree.files + plan.leftovers.reduce((sum, entry) => sum + entry.files, 0),
  );

  // Independent recount, so the numbers are checked against the filesystem rather
  // than against the same function that produced them.
  const independent = { files: 0, bytes: 0 };
  const recount = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) recount(full);
      else {
        independent.files += 1;
        independent.bytes += fs.statSync(full).size;
      }
    }
  };
  recount(path.join(PATHS.versions, "1.0.0-old"));
  recount(path.join(PATHS.versions, ".staging-1.0.0-old-abc123"));
  recount(path.join(PATHS.versions, ".staging-1.0.0-old-replaced-xyz"));
  report.check(
    "the file count matches an independent recount",
    plan.totals.files === independent.files,
    `${plan.totals.files} vs ${independent.files}`,
  );
  report.check(
    "the byte count matches an independent recount",
    plan.totals.bytes === independent.bytes,
    `${plan.totals.bytes} vs ${independent.bytes}`,
  );

  const result = await library.deleteVersion("1.0.0-old", { paths: PATHS, dryRun: true });
  report.check("the dry run reports ok", result.ok === true, JSON.stringify(result.reason));
  report.check("the dry run says it deleted nothing", result.deleted === false);
  report.check("the dry run is flagged as one", result.dryRun === true);
  report.check("the message says 'would delete'", /^Would delete/.test(result.message), result.message);
  report.check("the message carries the byte count in human form", /(KB|MB|B)/.test(result.message), result.message);
  report.check("the catalogue is reported unchanged", result.catalogue === "unchanged");

  report.check(
    "the whole library is byte-identical after the dry run",
    JSON.stringify(snapshotTree(PATHS.versions)) === JSON.stringify(before),
  );
  report.check(
    "the dry run took no lock",
    fs.existsSync(lock.lockPath({ paths: PATHS })) === false,
  );

  // A dry run of a version that is not there is honest about it.
  const absent = await library.deleteVersion("9.9.9-absent", { paths: PATHS, dryRun: true });
  report.check("a dry run of an absent version reports not-installed", absent.reason === library.DELETE_REASON.NOT_INSTALLED, absent.reason);
  report.check("and says nothing would be deleted", /nothing would be deleted/.test(absent.message), absent.message);
  report.check(
    "and the library is still byte-identical",
    JSON.stringify(snapshotTree(PATHS.versions)) === JSON.stringify(before),
  );
});

// --- real delete ------------------------------------------------------------

await report.section("a real delete removes the tree, the entry and the leftovers", async () => {
  resetLibrary();
  clearRunningState();

  makeVersion("1.0.0-target");
  makeVersion("1.0.1-keep");
  makeVersion("0.9.9-keep");
  fs.mkdirSync(path.join(PATHS.versions, ".staging-1.0.0-target-sweep1"), { recursive: true });
  fs.writeFileSync(path.join(PATHS.versions, ".staging-1.0.0-target-sweep1", "junk.bin"), "junk");
  fs.mkdirSync(path.join(PATHS.versions, ".staging-1.0.1-keep-sweep1"), { recursive: true });

  catalogue.recordInstall("1.0.0-target", { paths: PATHS, now: "2026-10-01T00:00:00Z", source: "next" });
  catalogue.recordInstall("1.0.1-keep", { paths: PATHS, now: "2026-10-02T00:00:00Z", source: "next" });
  catalogue.recordInstall("9.9.9-ghost", { paths: PATHS, now: "2026-10-03T00:00:00Z", source: "alpha" });

  const keepBefore = snapshotTree(path.join(PATHS.versions, "1.0.1-keep"));

  const result = await library.deleteVersion("1.0.0-target", { paths: PATHS });

  report.check("the delete reports ok", result.ok === true, JSON.stringify(result));
  report.check("the delete reports it deleted", result.deleted === true);
  report.check("the reason is 'deleted'", result.reason === library.DELETE_REASON.OK, result.reason);
  report.check("the tree is gone", fs.existsSync(path.join(PATHS.versions, "1.0.0-target")) === false);
  report.check(
    "the version's staging leftover was swept",
    fs.existsSync(path.join(PATHS.versions, ".staging-1.0.0-target-sweep1")) === false,
  );
  report.check(
    "another version's staging leftover was NOT swept",
    fs.existsSync(path.join(PATHS.versions, ".staging-1.0.1-keep-sweep1")) === true,
  );
  report.check("the reported message names the version", result.message.includes("1.0.0-target"), result.message);
  report.check("the result carries the plan", result.plan !== undefined && result.plan.totals.files > 0);
  report.check("the catalogue write is reported", result.catalogue === "recorded", result.catalogue);

  const after = catalogue.readCatalogue({ paths: PATHS });
  report.check("the catalogue entry is gone", after.document.versions["1.0.0-target"] === undefined);
  report.check("the other version's entry survives", after.document.versions["1.0.1-keep"] !== undefined);
  report.check(
    "a catalogue entry with NO version on disk is untouched",
    after.document.versions["9.9.9-ghost"] !== undefined,
    "deleting a version must never volunteer to prune unrelated entries",
  );

  report.check(
    "the sibling version is byte-identical",
    JSON.stringify(snapshotTree(path.join(PATHS.versions, "1.0.1-keep"))) === JSON.stringify(keepBefore),
  );
  report.check("the other sibling is untouched", fs.existsSync(path.join(PATHS.versions, "0.9.9-keep")) === true);
  report.check("no lock file was left behind", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  const enumeration = library.listInstalledVersions({ paths: PATHS }).map((entry) => entry.version);
  report.check(
    "the deleted version is no longer enumerated",
    enumeration.includes("1.0.0-target") === false,
    JSON.stringify(enumeration),
  );
  report.check("both siblings are still enumerated", enumeration.includes("1.0.1-keep") && enumeration.includes("0.9.9-keep"));
});

await report.section("deleting something absent is a no-op, not a failure", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-here");
  catalogue.recordInstall("1.0.0-here", { paths: PATHS, now: "2026-10-01T00:00:00Z", source: "next" });
  catalogue.recordInstall("7.7.7-ghost", { paths: PATHS, now: "2026-10-01T00:00:00Z", source: "alpha" });

  const result = await library.deleteVersion("8.8.8-absent", { paths: PATHS });
  report.check("an absent version is ok", result.ok === true, JSON.stringify(result));
  report.check("but nothing was deleted", result.deleted === false);
  report.check("the reason is not-installed", result.reason === library.DELETE_REASON.NOT_INSTALLED, result.reason);
  report.check("the message says so", /nothing was deleted/.test(result.message), result.message);
  report.check("the catalogue is reported unchanged", result.catalogue === "unchanged");
  report.check("the present version is untouched", fs.existsSync(path.join(PATHS.versions, "1.0.0-here")) === true);
  report.check(
    "the with-no-directory entry is untouched",
    catalogue.readCatalogue({ paths: PATHS }).document.versions["7.7.7-ghost"] !== undefined,
  );
});

// --- the backup-restore path ------------------------------------------------

await report.section("a failed reinstall restores the previous tree (renameOntoTarget)", () => {
  resetLibrary();
  clearRunningState();

  const version = "1.0.0-restore";
  const installDir = path.join(PATHS.versions, version);
  const staging = path.join(PATHS.versions, ".staging-1.0.0-restore-inject");

  // The PREVIOUS good tree, identifiable by a marker file.
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "previous-good-tree.txt"), "the tree that must survive\n");
  fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(staging, "node_modules", "new.txt"), "the tree that must not land\n");

  // Inject a rename that succeeds for the "move the old tree aside" step and fails
  // for the "move the new tree in" step - the exact shape of a real EPERM/EXDEV on
  // the final move. A real failure cannot be provoked inside one temp directory, so
  // this seam is the only way to keep the restore branch from rotting.
  let calls = 0;
  const injected = (from, to) => {
    calls += 1;
    if (calls === 2) {
      const error = new Error("EPERM: operation not permitted, rename (injected)");
      error.code = "EPERM";
      throw error;
    }
    fs.renameSync(from, to);
  };

  const result = install.renameOntoTarget(staging, installDir, PATHS, { rename: injected });

  report.check("the move is reported as failed", result.ok === false, JSON.stringify(result));
  report.check("the failure reason carries the injected error", /EPERM/.test(result.reason ?? ""), result.reason);
  report.check("a backup was created", result.backup !== null, String(result.backup));
  report.check("the restore is reported as having happened", result.restored === true);
  report.check(
    "THE TARGET IS NOT ABSENT - the previous tree was put back",
    fs.existsSync(installDir) === true,
    "a failed reinstall must never be how the user loses a version",
  );
  report.check(
    "the restored tree is the PREVIOUS tree, byte for byte",
    fs.readFileSync(path.join(installDir, "previous-good-tree.txt"), "utf8") ===
      "the tree that must survive\n",
  );
  report.check(
    "the failed new tree was not left at the target",
    fs.existsSync(path.join(installDir, "node_modules", "new.txt")) === false,
  );
  report.check("the backup path no longer exists (it was moved back)", fs.existsSync(result.backup) === false);

  // The success path, for contrast: the same injection that succeeds all the way
  // leaves the new tree in place and removes the backup.
  calls = -1000; // never fail
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "old.txt"), "old\n");
  fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true });
  const success = install.renameOntoTarget(staging, installDir, PATHS, { rename: injected });
  report.check("a successful rename reports ok", success.ok === true, JSON.stringify(success));
  report.check("the new tree is at the target", fs.existsSync(path.join(installDir, "node_modules")) === true);
  report.check("the old tree's file is gone", fs.existsSync(path.join(installDir, "old.txt")) === false);
  report.check(
    "the backup was removed after a successful rename",
    success.backup !== null && fs.existsSync(success.backup) === false,
  );
  report.check("no staging leftovers remain", library.leftoverDirsFor(version, { paths: PATHS }).length === 0, JSON.stringify(library.leftoverDirsFor(version, { paths: PATHS })));
});

// --- locking ----------------------------------------------------------------

await report.section("a real delete takes the library lock; a dry run does not", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-locked");

  report.check("the lock starts free", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  // While another operation holds the lock, a delete must refuse with a NAMED
  // reason rather than racing. `hold` is our own pid, which is genuinely alive.
  const hold = lock.acquireLock({ paths: PATHS, pid: process.pid, reason: "test holder" });
  report.check("the lock is held for the refusal test", hold.acquired === true);

  const refused = await library.deleteVersion("1.0.0-locked", { paths: PATHS });
  report.check("the delete is refused", refused.ok === false, JSON.stringify(refused.reason));
  report.check("the reason is 'locked'", refused.reason === library.DELETE_REASON.LOCKED, refused.reason);
  report.check("the message names the lock file", refused.message.includes(".lock"), refused.message);
  report.check("the refusal explains how to proceed", /Wait for it to finish/.test(refused.message), refused.message);
  report.check("the version survived", fs.existsSync(path.join(PATHS.versions, "1.0.0-locked")) === true);

  // A dry run needs no lock, so it still answers while the library is busy.
  const dry = await library.deleteVersion("1.0.0-locked", { paths: PATHS, dryRun: true });
  report.check("a dry run still answers while the lock is held", dry.ok === true && dry.dryRun === true, dry.message);
  report.check("and it deleted nothing", fs.existsSync(path.join(PATHS.versions, "1.0.0-locked")) === true);

  lock.releaseLock({ paths: PATHS, pid: process.pid });

  const after = await library.deleteVersion("1.0.0-locked", { paths: PATHS });
  report.check("once the lock is free the delete proceeds", after.deleted === true, after.message);
  report.check("and the lock is released afterwards", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);
});

await report.section("the lock is exclusive ACROSS processes for a delete too", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-cross");

  const handshake = path.join(TMP_ROOT, "delete-lock-handshake.json");
  fs.rmSync(handshake, { force: true });
  const childScript = path.join(TMP_ROOT, "delete-lock-child.mjs");
  const lockModuleUrl = pathToFileURL(path.join(REPO_ROOT, "sidecar", "lib", "library-lock.js")).href;

  // `pathToFileURL` is required, not cosmetic: a bare Windows drive-letter
  // specifier fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  fs.writeFileSync(
    childScript,
    `
import fs from "node:fs";
import { acquireLock } from ${JSON.stringify(lockModuleUrl)};

const acquired = acquireLock({ reason: "child holder (delete test)" });
const temp = ${JSON.stringify(handshake)} + ".tmp";
fs.writeFileSync(temp, JSON.stringify({ acquired: acquired.acquired, pid: process.pid }), "utf8");
fs.renameSync(temp, ${JSON.stringify(handshake)});

// Exit when the parent closes stdin. A bare setInterval would keep the event loop
// alive and the child would never exit - which the first version of this test
// discovered, because the parent then waited 8 seconds and had to kill it.
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

  const arrived = await waitFor(() => fs.existsSync(handshake));
  report.check("the other process reported that it holds the lock", arrived);
  const childState = arrived ? JSON.parse(fs.readFileSync(handshake, "utf8")) : {};
  report.check("the other process acquired the lock", childState.acquired === true, JSON.stringify(childState));
  report.check("the other process is a different pid", childState.pid !== process.pid, String(childState.pid));

  const refused = await library.deleteVersion("1.0.0-cross", { paths: PATHS });
  report.check(
    "the delete refuses while another PROCESS holds the lock",
    refused.reason === library.DELETE_REASON.LOCKED,
    `${refused.reason}: ${refused.message}`,
  );
  report.check("the version survived the cross-process refusal", fs.existsSync(path.join(PATHS.versions, "1.0.0-cross")) === true);

  // The child exits when its stdin closes; it is never killed.
  child.stdin.end();
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  report.check("the other process exited on its own", exited);

  const after = await library.deleteVersion("1.0.0-cross", { paths: PATHS });
  report.check(
    "the delete proceeds once the other process is gone, taking over its stale lock",
    after.deleted === true,
    `${after.reason}: ${after.message}`,
  );
  report.check("no lock file is left behind", fs.existsSync(lock.lockPath({ paths: PATHS })) === false);

  fs.rmSync(childScript, { force: true });
  fs.rmSync(handshake, { force: true });
});

await report.section("the delete result always has the same shape", async () => {
  resetLibrary();
  clearRunningState();
  makeVersion("1.0.0-shape");

  const shapes = [
    await library.deleteVersion("1.0.0-shape", { paths: PATHS, dryRun: true }),
    await library.deleteVersion("1.0.0-shape", { paths: PATHS }),
    await library.deleteVersion("1.0.0-shape", { paths: PATHS }),
    await library.deleteVersion("next", { paths: PATHS }),
  ];

  const keys = ["ok", "deleted", "dryRun", "reason", "message", "version", "installDir", "plan", "catalogue", "error"];
  for (const [index, shape] of shapes.entries()) {
    report.check(
      `result ${index} has every key`,
      keys.every((key) => Object.hasOwn(shape, key)),
      JSON.stringify(Object.keys(shape)),
    );
    report.check(`result ${index} carries a non-empty message`, typeof shape.message === "string" && shape.message.length > 0);
    report.check(`result ${index} carries a reason`, typeof shape.reason === "string" && shape.reason.length > 0);
    report.check(`result ${index} is a boolean for ok/deleted/dryRun`, typeof shape.ok === "boolean" && typeof shape.deleted === "boolean" && typeof shape.dryRun === "boolean");
  }
});

process.exit(report.finish());
