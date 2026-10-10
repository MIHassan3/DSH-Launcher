/**
 * Phase 2B: the registry routes.
 *
 * `GET /registry/versions` projects a packument into what a UI needs: version,
 * channel, dist-tag, publish date, and whether the local library already has it.
 * The projection is the whole substance, so most of this suite asserts SHAPE and
 * ORDER rather than transport - a wrong order in a version list is a wrong answer,
 * not a cosmetic problem.
 *
 * The registry is a LOOPBACK STUB on a dynamic port, never the public one: this is
 * the offline tier, and it must pass with the network unplugged. The stub is passed
 * as `packumentOptions: { registryUrl, allowInsecure: true }`, which is the same
 * seam `registry.js` already uses.
 *
 * Run from the repo root:  node sidecar/test/version-registry.js
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "version-registry");

const report = createReport("DSH-Dock registry routes: /registry/versions projection");

const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.DSH_DOCK_DATA_DIR = DATA_DIR;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const state = await import("../lib/state.js");
const jobs = await import("../lib/version-jobs.js");
const library = await import("../lib/library.js");
const control = await import("../lib/control.js");
const service = await import("../lib/service.js");

const PATHS = state.resolveStatePaths();
state.ensureDataDirs(PATHS);

/** Starts a stub registry that serves one packument document. */
function startStubRegistry(packument, status = 200) {
  const server = http.createServer((req, res) => {
    const body = status === 200 ? JSON.stringify(packument) : "";
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Minimal JSON client. */
function request(port, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch {
            reject(new Error(`Invalid JSON from ${route}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.once("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout on ${method} ${route}`)));
    req.end();
  });
}

/** A complete install tree, so `installed`/`state` can be asserted. */
function makeCompleteTree(version, spec = {}) {
  const installDir = path.join(PATHS.versions, version);
  const scope = path.join(installDir, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(scope, "dsh", "lib"), { recursive: true });
  fs.writeFileSync(path.join(scope, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version }));
  fs.writeFileSync(path.join(scope, "dsh", "lib", "bin.js"), "// fixture\n");
  if (spec.withWebApp !== false) {
    fs.mkdirSync(path.join(scope, "dsh-web-app"), { recursive: true });
    fs.writeFileSync(path.join(scope, "dsh-web-app", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }));
  }
  if (spec.incomplete === true) fs.writeFileSync(path.join(installDir, ".incomplete"), "{}\n");
  return installDir;
}

function removeTree(version) {
  fs.rmSync(path.join(PATHS.versions, version), { recursive: true, force: true });
}

/** A packument shaped like the real one: 3 releases, one alpha, plus dist-tags. */
const PACKUMENT = {
  "dist-tags": { alpha: "0.3.0-alpha.1", next: "0.2.0-rc.2", latest: "0.2.0-rc.2" },
  versions: {
    "0.1.0-rc.1": {},
    "0.2.0-rc.1": {},
    "0.2.0-rc.2": {},
    "0.3.0-alpha.1": {},
  },
  time: {
    created: "2026-08-10T19:41:11.384Z",
    modified: "2026-10-03T04:53:22.536Z",
    "0.1.0-rc.1": "2026-08-10T19:41:11.858Z",
    "0.2.0-rc.1": "2026-09-28T12:34:03.181Z",
    "0.2.0-rc.2": "2026-09-29T09:56:27.792Z",
    "0.3.0-alpha.1": "2026-10-03T04:53:22.343Z",
  },
};

const cleanups = [];

/** Builds a manager wired to the stub, plus a served sidecar. */
async function setup(stub, options = {}) {
  const controller = new control.HarnessControl({
    paths: PATHS,
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["fixture"], startFresh: true }),
  });
  const versions = new jobs.VersionManager({
    paths: PATHS,
    control: controller,
    log: () => {},
    packumentFn: (name, packumentOptions) => {
      // The real client is used, with the stub's URL: this exercises the
      // insecure-transport gate as well as the projection.
      const { fetchPackument } = registryModule;
      void fetchPackument;
      return realFetch(name, { ...packumentOptions, registryUrl: stub.url, allowInsecure: true });
    },
    ...options,
  });
  const instance = await service.startService({ control: controller, versions });
  cleanups.push({ dispose: () => instance.dispose() });
  return { instance, controller, versions };
}

const registryModule = await import("../lib/registry.js");
const realFetch = registryModule.fetchPackument;

// ---------------------------------------------------------------------------
// 1. The projection
// ---------------------------------------------------------------------------

await report.section("1. the projection: fields, channels, and publish-date order", async () => {
  const stub = await startStubRegistry(PACKUMENT);
  cleanups.push({ dispose: stub.close });
  const { instance } = await setup(stub);

  const res = await request(instance.port, "GET", "/registry/versions");
  report.check("the route answers 200", res.status === 200, String(res.status));

  const body = res.json;
  report.check("the payload names the package", body.package === "@deepseek-ai/dsh", String(body.package));
  report.check("the payload is an array of versions", Array.isArray(body.versions), typeof body.versions);
  report.check("the payload reports the total", body.total === 4, String(body.total));
  report.check("the payload reports whether it was truncated", body.truncated === false, String(body.truncated));
  report.check("the payload reports the limit it applied", body.limit === jobs.AVAILABLE_VERSIONS_LIMIT, String(body.limit));
  report.check("the payload reports the minimum supported version", typeof body.minimumSupported === "string", String(body.minimumSupported));
  report.check("the payload reports when it was fetched", typeof body.fetchedAt === "string", String(body.fetchedAt));
  report.check("a first read is not from cache", body.fromCache === false, String(body.fromCache));

  report.check(
    "the channel tags are reported as the user-facing channel names",
    body.channelTags.stable === "0.2.0-rc.2" && body.channelTags.rc === "0.2.0-rc.2" && body.channelTags.alpha === "0.3.0-alpha.1",
    JSON.stringify(body.channelTags),
  );

  const order = body.versions.map((entry) => entry.version);
  report.check(
    "versions are newest-first BY PUBLISH DATE",
    order.join(",") === "0.3.0-alpha.1,0.2.0-rc.2,0.2.0-rc.1,0.1.0-rc.1",
    order.join(","),
  );

  const byVersion = Object.fromEntries(body.versions.map((entry) => [entry.version, entry]));
  report.check(
    "a version that holds BOTH latest and next reports `stable` (the channel a user means by stable)",
    byVersion["0.2.0-rc.2"].channel === "stable",
    byVersion["0.2.0-rc.2"].channel,
  );
  report.check(
    "and it still reports every channel it holds",
    (byVersion["0.2.0-rc.2"].allChannels ?? []).sort().join(",") === "rc,stable",
    JSON.stringify(byVersion["0.2.0-rc.2"].allChannels),
  );
  report.check("the dist-tag it won on is named", byVersion["0.2.0-rc.2"].distTag === "latest", String(byVersion["0.2.0-rc.2"].distTag));
  report.check("an alpha-only version reports `alpha`", byVersion["0.3.0-alpha.1"].channel === "alpha", byVersion["0.3.0-alpha.1"].channel);
  report.check("an untagged version reports `other`, not a guess", byVersion["0.1.0-rc.1"].channel === "other", byVersion["0.1.0-rc.1"].channel);
  report.check("an untagged version carries no dist-tag", byVersion["0.1.0-rc.1"].distTag === null, String(byVersion["0.1.0-rc.1"].distTag));

  report.check(
    "each entry carries its publish date",
    body.versions.every((entry) => typeof entry.publishedAt === "string"),
    JSON.stringify(body.versions.map((e) => e.publishedAt)),
  );
  report.check("nothing is installed yet", body.versions.every((entry) => entry.installed === false));
  report.check("nothing installed means state `absent`", body.versions.every((entry) => entry.state === "absent"));

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// 2. Local state is joined in
// ---------------------------------------------------------------------------

await report.section("2. the local library is joined into the registry list", async () => {
  const stub = await startStubRegistry(PACKUMENT);
  cleanups.push({ dispose: stub.close });

  makeCompleteTree("0.2.0-rc.1");
  makeCompleteTree("0.2.0-rc.2", { incomplete: true });

  const { instance } = await setup(stub);
  const res = await request(instance.port, "GET", "/registry/versions");
  const byVersion = Object.fromEntries(res.json.versions.map((entry) => [entry.version, entry]));

  report.check("an installed version is reported installed", byVersion["0.2.0-rc.1"].installed === true, JSON.stringify(byVersion["0.2.0-rc.1"]));
  report.check("and its state is `installed`", byVersion["0.2.0-rc.1"].state === "installed", byVersion["0.2.0-rc.1"].state);
  report.check("a partial version is NOT reported installed", byVersion["0.2.0-rc.2"].installed === false, JSON.stringify(byVersion["0.2.0-rc.2"]));
  report.check("its state is `partial`", byVersion["0.2.0-rc.2"].state === "partial", byVersion["0.2.0-rc.2"].state);
  report.check("and the marker is surfaced so the UI can offer a cleanup", byVersion["0.2.0-rc.2"].hasIncompleteMarker === true);
  report.check("a version that is not on disk is `absent`", byVersion["0.3.0-alpha.1"].state === "absent", byVersion["0.3.0-alpha.1"].state);

  await instance.dispose();
  removeTree("0.2.0-rc.1");
  removeTree("0.2.0-rc.2");
});

// ---------------------------------------------------------------------------
// 3. belowMinimum marks, never omits
// ---------------------------------------------------------------------------

await report.section("3. belowMinimum marks every entry, and omits none", async () => {
  const stub = await startStubRegistry(PACKUMENT);
  cleanups.push({ dispose: stub.close });
  const { instance } = await setup(stub);

  // MIN_SUPPORTED_DSH is still "0.0.0" (2B does not set it: that is Step 11), so
  // nothing is below it. The route takes the minimum as an option so the BEHAVIOR is
  // testable now, independently of the value Step 11 will derive.
  const direct = await instance.versions.available({ minimumSupported: "0.2.0-rc.1" });
  const byVersion = Object.fromEntries(direct.versions.map((entry) => [entry.version, entry]));

  report.check("a version below the minimum is MARKED", byVersion["0.1.0-rc.1"].belowMinimum === true, JSON.stringify(byVersion["0.1.0-rc.1"]));
  report.check("a version AT the minimum is not marked", byVersion["0.2.0-rc.1"].belowMinimum === false);
  report.check("a version above the minimum is not marked", byVersion["0.2.0-rc.2"].belowMinimum === false);
  report.check(
    "NOTHING is omitted for being below the minimum (Q77: mark, never block)",
    direct.versions.length === 4,
    `${direct.versions.length} of 4`,
  );
  report.check("the minimum used is echoed back", direct.minimumSupported === "0.2.0-rc.1", String(direct.minimumSupported));

  // An unparseable version must not be declared unsupported: "we cannot tell" is not
  // "it is too old".
  report.check("an unparseable version is not marked below anything", jobs.compareVersions("not-a-version", "9.9.9") === 0);

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// 4. Ordering details
// ---------------------------------------------------------------------------

await report.section("4. ordering: pre-releases, undated versions, and the semver trap", async () => {
  report.check("a pre-release sorts BELOW its own release", jobs.compareVersions("0.2.1-alpha.1", "0.2.1") === -1);
  report.check("and above an older release", jobs.compareVersions("0.2.1-alpha.1", "0.2.0") === 1);
  report.check("rc.2 sorts above rc.1", jobs.compareVersions("0.2.0-rc.2", "0.2.0-rc.1") === 1);
  // THE TRAP. As strings, "rc.10" < "rc.9" is TRUE, so a naive comparator calls
  // rc.10 the OLDER version - which would badge a newer release as below the
  // minimum. Pre-release identifiers are therefore compared part by part, numeric
  // parts as numbers.
  report.check(
    "rc.10 sorts above rc.9 (numeric identifiers, not string comparison)",
    jobs.compareVersions("0.2.0-rc.10", "0.2.0-rc.9") === 1,
    `${jobs.compareVersions("0.2.0-rc.10", "0.2.0-rc.9")}`,
  );
  report.check("alpha.2 sorts above alpha.10's opposite - 10 above 2", jobs.compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2") === 1);
  report.check(
    "a numeric identifier sorts BELOW an alphanumeric one (semver's rule)",
    jobs.compareVersions("1.0.0-1", "1.0.0-alpha") === -1,
    `${jobs.compareVersions("1.0.0-1", "1.0.0-alpha")}`,
  );
  report.check("alpha sorts below alpha.1 (a shorter list is lower)", jobs.compareVersions("1.0.0-alpha", "1.0.0-alpha.1") === -1);
  report.check("build metadata is ignored for precedence", jobs.compareVersions("1.0.0+build.2", "1.0.0+build.1") === 0);
  report.check("equal versions are equal", jobs.compareVersions("0.2.0-rc.1", "0.2.0-rc.1") === 0);
  report.check("the comparison is antisymmetric", jobs.compareVersions("0.2.0-rc.9", "0.2.0-rc.10") === -1);

  const withUndated = {
    "dist-tags": { latest: "0.2.0-rc.2" },
    versions: { "0.2.0-rc.2": {}, "1.0.0-unpublished": {} },
    time: { "0.2.0-rc.2": "2026-09-29T09:56:27.792Z" },
  };
  const stub = await startStubRegistry(withUndated);
  cleanups.push({ dispose: stub.close });
  const { instance } = await setup(stub);

  const res = await request(instance.port, "GET", "/registry/versions");
  const order = res.json.versions.map((entry) => entry.version);
  report.check(
    "an UNDATED version sorts LAST, never first (unknown date is not 'newest')",
    order[order.length - 1] === "1.0.0-unpublished",
    order.join(","),
  );

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// 5. The bound
// ---------------------------------------------------------------------------

await report.section("5. the list is bounded, and says so", async () => {
  const many = { "dist-tags": { latest: "9.9.60" }, versions: {}, time: {} };
  for (let index = 1; index <= 60; index += 1) {
    const version = `9.9.${index}`;
    many.versions[version] = {};
    // Ascending publish dates, so the newest are 9.9.60 downward.
    many.time[version] = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  }

  const stub = await startStubRegistry(many);
  cleanups.push({ dispose: stub.close });
  const { instance } = await setup(stub);

  const res = await request(instance.port, "GET", "/registry/versions");
  report.check("the list is capped at the limit", res.json.versions.length === jobs.AVAILABLE_VERSIONS_LIMIT, String(res.json.versions.length));
  report.check("the TOTAL reports the real count, not the capped one", res.json.total === 60, String(res.json.total));
  report.check("truncated is reported", res.json.truncated === true, String(res.json.truncated));
  report.check("the newest survive the cap", res.json.versions[0].version === "9.9.60", String(res.json.versions[0].version));
  report.check(
    "and the ones dropped are the OLDEST",
    res.json.versions.some((entry) => entry.version === "9.9.60") && res.json.versions.every((entry) => entry.version !== "9.9.1"),
    JSON.stringify(res.json.versions.map((e) => e.version).slice(-3)),
  );

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// 6. Failure and caching
// ---------------------------------------------------------------------------

await report.section("6a. an unreachable registry is a typed 503, not a 500", async () => {
  const { instance } = await setup({
    url: "http://127.0.0.1:9",
    close: async () => {},
  });

  const res = await request(instance.port, "GET", "/registry/versions");
  report.check("the route answers 503", res.status === 503, String(res.status));
  report.check("the error is typed", res.json.error === "registry-unreachable", String(res.json.error));
  report.check(
    "the message says NOTHING was changed and local versions are unaffected",
    /Nothing was changed/i.test(res.json.message ?? "") && /unaffected/i.test(res.json.message ?? ""),
    (res.json.message ?? "").slice(0, 240),
  );
  report.check("ok is false", res.json.ok === false, String(res.json.ok));

  // A registry failure must not take the harness routes down with it.
  const health = await request(instance.port, "GET", "/harness/status");
  report.check("the harness routes still work while the registry is down", health.status === 200, String(health.status));
  const localLibrary = await request(instance.port, "GET", "/versions/status");
  report.check("and the local library route still works", localLibrary.status === 200, String(localLibrary.status));
  report.check("it reports the library even with no registry", Array.isArray(localLibrary.json.library), typeof localLibrary.json.library);

  await instance.dispose();
});

await report.section("6b. the listing is cached briefly, and ?refresh=1 bypasses it", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PACKUMENT));
  });
  const stub = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((d) => server.close(d)) }));
  });
  cleanups.push({ dispose: stub.close });

  const { instance } = await setup(stub);

  const first = await request(instance.port, "GET", "/registry/versions");
  report.check("the first read fetched from the registry", first.json.fromCache === false && requests === 1, `requests=${requests}`);
  report.check("the cache TTL is reported by the module, not the UI", jobs.LISTING_TTL_MS > 0, String(jobs.LISTING_TTL_MS));

  const second = await request(instance.port, "GET", "/registry/versions");
  report.check("a second read inside the TTL is served from cache", second.json.fromCache === true, String(second.json.fromCache));
  report.check("and did NOT hit the registry again", requests === 1, `requests=${requests}`);
  report.check("the cached answer is the same answer", second.json.total === first.json.total);

  const refreshed = await request(instance.port, "GET", "/registry/versions?refresh=1");
  report.check("?refresh=1 bypasses the cache", refreshed.json.fromCache === false, String(refreshed.json.fromCache));
  report.check("and did hit the registry", requests === 2, `requests=${requests}`);

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// 7. The download route
// ---------------------------------------------------------------------------

await report.section("7. /registry/download/<version> installs and does NOT start", async () => {
  const stub = await startStubRegistry(PACKUMENT);
  cleanups.push({ dispose: stub.close });

  let installCalls = [];
  let startCalls = 0;
  const controller = new control.HarnessControl({
    paths: PATHS,
    adoptFn: async () => ({ decision: "fresh", stateStatus: "absent", reasons: ["fixture"], startFresh: true }),
    startFn: async () => {
      startCalls += 1;
      throw new Error("a download must not start a harness");
    },
  });
  const versions = new jobs.VersionManager({
    paths: PATHS,
    control: controller,
    log: () => {},
    installFn: async (version) => {
      installCalls.push(version);
      return { version, installDir: path.join(PATHS.versions, version), binPath: "x", skipped: false, exitCode: 0 };
    },
  });
  const instance = await service.startService({ control: controller, versions });
  cleanups.push({ dispose: () => instance.dispose() });

  const res = await request(instance.port, "POST", "/registry/download/0.2.0-rc.2");
  report.check("the download is accepted with 202", res.status === 202, String(res.status));
  report.check("the job names the download kind", res.json.kind === "download", String(res.json.kind));
  report.check("the job names the version from the PATH segment", res.json.version === "0.2.0-rc.2", String(res.json.version));
  report.check("the job starts at the resolving phase", res.json.phase === "resolving", String(res.json.phase));

  await versions.settled();

  report.check("the installer was asked for exactly that version", installCalls.join(",") === "0.2.0-rc.2", installCalls.join(","));
  report.check("NO harness was started by a download (Q86)", startCalls === 0, `startCalls=${startCalls}`);
  report.check("runtime-state.json is untouched", fs.existsSync(PATHS.runtimeState) === false);
  report.check("and the search-parameter form is NOT accepted, because the path is the contract", (await request(instance.port, "POST", "/registry/download?version=0.2.0-rc.2")).status === 404);

  await instance.dispose();
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

for (const item of cleanups) {
  try {
    await item.dispose();
  } catch {
    /* best effort */
  }
}

process.exit(report.finish());
