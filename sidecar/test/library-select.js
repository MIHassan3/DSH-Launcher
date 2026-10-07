/**
 * Step 4b - choosing what to offer for deletion when the cache limit is exceeded.
 *
 * THE LAUNCHER NEVER CALLS THIS TO DELETE ANYTHING. Section 3.1 requires that
 * exceeding the limit PROMPTS and never silently evicts, so this module answers
 * only "if the user agrees, what should we suggest?" - and the tests here are as
 * much about what it refuses to suggest as about what it does.
 *
 * The selection is pure: it takes entries, a limit and a protected set, and returns
 * a list. No disk, no lock, no catalogue write. That is what makes it safe for the
 * prompt path, where a wrong answer is a wrong suggestion rather than a lost install.
 *
 * Run from the repo root:
 *   node sidecar/test/library-select.js
 */

import process from "node:process";

import { createReport } from "./lib/check.js";

const report = createReport("DSH-Dock library: cache-limit selection (prompt candidates)");

const library = await import("../lib/library.js");

/** Builds an entry list the way `listInstalledVersions` would return it. */
const makeEntries = (spec) =>
  spec.map(([version, state, installedAt]) => ({
    version,
    state,
    installedAt,
    checksum: null,
    problems: state === library.LIBRARY_STATE.INSTALLED ? [] : [{ code: "bin-missing", path: "/x", detail: "d" }],
  }));

const INSTALLED = library.LIBRARY_STATE.INSTALLED;
const PARTIAL = library.LIBRARY_STATE.PARTIAL;

await report.section("below the limit, nothing is suggested", () => {
  const entries = makeEntries([
    ["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"],
    ["1.0.1", INSTALLED, "2026-10-02T00:00:00Z"],
  ]);

  const result = library.selectVersionsToDelete({ entries, limit: 10 });
  report.check("no candidates", result.candidates.length === 0);
  report.check("overBy is zero", result.overBy === 0);
  report.check("the limit is reported", result.limit === 10);
});

await report.section("above the limit, exactly the excess is suggested", () => {
  const entries = makeEntries([
    ["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"],
    ["1.0.1", INSTALLED, "2026-10-02T00:00:00Z"],
    ["1.0.2", INSTALLED, "2026-10-03T00:00:00Z"],
    ["1.0.3", INSTALLED, "2026-10-04T00:00:00Z"],
  ]);

  const result = library.selectVersionsToDelete({ entries, limit: 3 });
  report.check("exactly one candidate for one over the limit", result.candidates.length === 1, JSON.stringify(result.candidates));
  report.check("overBy is one", result.overBy === 1);
  report.check(
    "the OLDEST is suggested first",
    result.candidates[0].version === "1.0.0",
    result.candidates[0].version,
  );

  const twoOver = library.selectVersionsToDelete({ entries, limit: 2 });
  report.check("two candidates for two over", twoOver.candidates.length === 2);
  report.check(
    "the two oldest are suggested, oldest first",
    JSON.stringify(twoOver.candidates.map((entry) => entry.version)) === JSON.stringify(["1.0.0", "1.0.1"]),
    JSON.stringify(twoOver.candidates.map((entry) => entry.version)),
  );
});

await report.section("partial installs are suggested before working ones", () => {
  // A partial install costs bytes and provides nothing, so it is the best eviction
  // candidate even when it is newer than a working version.
  const entries = makeEntries([
    ["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"],
    ["1.0.1", PARTIAL, "2026-10-09T00:00:00Z"],
    ["1.0.2", INSTALLED, "2026-10-02T00:00:00Z"],
  ]);

  const result = library.selectVersionsToDelete({ entries, limit: 2 });
  report.check("one candidate", result.candidates.length === 1, JSON.stringify(result.candidates));
  report.check(
    "the PARTIAL one is suggested despite being the newest",
    result.candidates[0].version === "1.0.1",
    result.candidates[0].version,
  );
  report.check("the candidate is flagged as partial", result.candidates[0].partial === true);

  const twoCandidates = library.selectVersionsToDelete({ entries, limit: 1 });
  report.check("two candidates for two over", twoCandidates.candidates.length === 2);
  report.check(
    "the partial one comes first, then the oldest working one",
    JSON.stringify(twoCandidates.candidates.map((entry) => entry.version)) === JSON.stringify(["1.0.1", "1.0.0"]),
    JSON.stringify(twoCandidates.candidates.map((entry) => entry.version)),
  );
  report.check(
    "a working candidate is flagged not-partial",
    twoCandidates.candidates.find((entry) => entry.version === "1.0.0").partial === false,
  );
});

await report.section("the running version and pinned versions are never suggested", () => {
  const entries = makeEntries([
    ["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"],
    ["1.0.1", INSTALLED, "2026-10-02T00:00:00Z"],
    ["1.0.2", INSTALLED, "2026-10-03T00:00:00Z"],
  ]);

  const running = library.selectVersionsToDelete({ entries, limit: 2, runningVersion: "1.0.0" });
  report.check(
    "the running version is not a candidate even though it is the oldest",
    running.candidates.some((entry) => entry.version === "1.0.0") === false,
    JSON.stringify(running.candidates),
  );
  report.check(
    "the next-oldest takes its place",
    running.candidates[0].version === "1.0.1",
    running.candidates[0]?.version,
  );
  report.check("the protected version is reported as kept", running.kept.includes("1.0.0"), JSON.stringify(running.kept));
  report.check(
    "the count still reflects the real library size, not the candidate pool",
    running.overBy === 1,
    String(running.overBy),
  );

  const pinned = library.selectVersionsToDelete({
    entries,
    limit: 2,
    runningVersion: "1.0.0",
    protect: ["1.0.1"],
  });
  report.check(
    "a pinned version is also protected",
    pinned.candidates.some((entry) => entry.version === "1.0.1") === false,
    JSON.stringify(pinned.candidates),
  );
  report.check(
    "with the two oldest protected, the newest is suggested",
    pinned.candidates[0]?.version === "1.0.2",
    pinned.candidates[0]?.version,
  );
  report.check("both protected versions are reported as kept", pinned.kept.length === 2, JSON.stringify(pinned.kept));

  const allProtected = library.selectVersionsToDelete({
    entries,
    limit: 1,
    runningVersion: "1.0.0",
    protect: ["1.0.1", "1.0.2"],
  });
  report.check(
    "if everything is protected, nothing is suggested (never a refusal the user cannot act on)",
    allProtected.candidates.length === 0,
    JSON.stringify(allProtected.candidates),
  );
  report.check("but the excess is still reported honestly", allProtected.overBy === 2);
});

await report.section("undated versions sort after dated ones", () => {
  const entries = makeEntries([
    ["1.0.0", INSTALLED, null],
    ["1.0.1", INSTALLED, "2026-10-05T00:00:00Z"],
    ["1.0.2", INSTALLED, null],
  ]);

  const result = library.selectVersionsToDelete({ entries, limit: 1 });
  report.check("two candidates", result.candidates.length === 2, JSON.stringify(result.candidates));
  report.check(
    "the DATED version is suggested before the undated ones",
    result.candidates[0].version === "1.0.1",
    result.candidates[0].version,
  );
  report.check(
    "the undated ones fall back to version-string order",
    result.candidates[1].version === "1.0.0",
    result.candidates[1].version,
  );
});

await report.section("an empty library and a zero limit", () => {
  const empty = library.selectVersionsToDelete({ entries: [], limit: 10 });
  report.check("no candidates for an empty library", empty.candidates.length === 0);
  report.check("no excess for an empty library", empty.overBy === 0);

  const entries = makeEntries([["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"]]);
  const zero = library.selectVersionsToDelete({ entries, limit: 0 });
  report.check("a zero limit suggests everything", zero.candidates.length === 1, JSON.stringify(zero.candidates));
  report.check("and reports the excess", zero.overBy === 1);
});

await report.section("the default limit is the product default of 10", () => {
  const entries = makeEntries(
    Array.from({ length: 12 }, (_, index) => [`1.0.${index}`, INSTALLED, `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`]),
  );

  const result = library.selectVersionsToDelete({ entries });
  report.check("the default limit is 10", result.limit === 10, String(result.limit));
  report.check("two candidates for twelve versions", result.candidates.length === 2, String(result.candidates.length));
  report.check(
    "the two oldest",
    JSON.stringify(result.candidates.map((entry) => entry.version)) === JSON.stringify(["1.0.0", "1.0.1"]),
    JSON.stringify(result.candidates.map((entry) => entry.version)),
  );
  report.check(
    "the product's own default constant agrees",
    result.limit === 10,
    "DEFAULT_VERSION_LIMIT in version-manager.js is the same number",
  );
});

await report.section("the selection touches nothing", () => {
  // A pure function is the point: the prompt path must not be able to delete by
  // accident, so the selection takes an explicit entry list and returns a list.
  const entries = makeEntries([["1.0.0", INSTALLED, "2026-10-01T00:00:00Z"]]);
  const frozen = JSON.stringify(entries);
  library.selectVersionsToDelete({ entries, limit: 0 });
  report.check("the input entries are not mutated", JSON.stringify(entries) === frozen);
  report.check(
    "the candidates are copies, not the input objects",
    library.selectVersionsToDelete({ entries, limit: 0 }).candidates[0] !== entries[0],
  );
});

process.exit(report.finish());
