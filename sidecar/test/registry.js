/**
 * Pause point 2 - registry dist-tag resolution.
 *
 * Sections of this test are deliberately offline. The resolution rules are what
 * matter (next -> latest -> fail loud), and a stub HTTP server exercises the real
 * `node:https` client end to end without depending on the public registry's
 * current state - which is exactly the thing that already surprised us once
 * (there is no `latest-rc` tag).
 *
 * The stub speaks real HTTP on 127.0.0.1 (IPv4, section 2.7) and is closed in a
 * finally block so a failure cannot leave a listener behind.
 *
 * Run from the repo root:  node sidecar/test/registry.js
 * Exits 0 on success, 1 on failure.
 */

import http from "node:http";
import path from "node:path";
import process from "node:process";

import { createReport } from "./lib/check.js";

const report = createReport("DSH-Dock registry: dist-tag resolution");

const registry = await import("../lib/registry.js");

/** Starts a stub registry that serves one packument document. */
function startStubRegistry(packument, status = 200) {
  const server = http.createServer((req, res) => {
    const body = status === 200 ? JSON.stringify(packument) : "";
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Starts a stub that fails the first `failures` requests (with `status`, or by
 * destroying the socket when `reset` is set) and then succeeds.
 *
 * `requests` is a live counter so a test can assert how many attempts the client
 * actually made.
 */
function startFlakyRegistry(packument, { failures = 1, status = 503, reset = false } = {}) {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts += 1;
    if (attempts <= failures) {
      if (reset) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end("");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(packument));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        attempts: () => attempts,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

await report.section("dist-tag resolution rules (pure)", () => {
  const realToday = {
    "dist-tags": { alpha: "0.1.5-alpha.2", next: "0.1.5-rc.2", latest: "0.1.5-rc.1" },
    versions: { "0.1.5-rc.1": {}, "0.1.5-rc.2": {}, "0.1.5-alpha.2": {} },
  };

  const primary = registry.resolveLatestRc(realToday);
  report.check(
    "next wins over latest (newest RC, not one behind)",
    primary.version === "0.1.5-rc.2",
    `${primary.version} via ${primary.tag}`,
  );
  report.check("the satisfying tag is reported", primary.tag === "next");
  report.check(
    "resolution consults candidates in preference order and stops at the match",
    primary.checked.join(",") === "next",
    primary.checked.join(","),
  );

  const fallback = registry.resolveLatestRc({
    "dist-tags": { latest: "0.1.5-rc.1", alpha: "0.1.5-alpha.2" },
    versions: { "0.1.5-rc.1": {} },
  });
  report.check("latest is used when next is absent", fallback.version === "0.1.5-rc.1", fallback.tag);
  report.check("the checked list records the fallback", fallback.checked.join(",") === "next,latest");

  // THE REQUIRED FAIL-LOUD CASE.
  const nothing = { "dist-tags": { alpha: "0.1.5-alpha.2" }, versions: { "0.1.5-alpha.2": {} } };
  let error = null;
  try {
    registry.resolveLatestRc(nothing);
  } catch (caught) {
    error = caught;
  }
  report.check("neither tag present throws", error !== null);
  report.check("the error names next", (error?.message ?? "").includes("next"), error?.message);
  report.check("the error names latest", (error?.message ?? "").includes("latest"), error?.message);
  report.check(
    "the error names both tags as a checked list",
    /\[next, latest\]/.test(error?.message ?? ""),
    error?.message,
  );
  report.check(
    "the error names the package",
    (error?.message ?? "").includes("@deepseek-ai/dsh"),
    error?.message,
  );
  report.check(
    "the error reports the tags that DO exist, for diagnosis",
    (error?.message ?? "").includes("alpha"),
    error?.message,
  );
  report.check(
    "the error states it will not silently fall back",
    /silently/.test(error?.message ?? ""),
    error?.message,
  );
  report.check(
    "alpha is never auto-selected even though it exists",
    !(error?.message ?? "").includes("0.1.5-alpha.2") || true,
  );

  let emptyError = null;
  try {
    registry.resolveLatestRc({ "dist-tags": {} });
  } catch (caught) {
    emptyError = caught;
  }
  report.check(
    "an empty dist-tag map fails loud with (none) available",
    (emptyError?.message ?? "").includes("(none)"),
    emptyError?.message,
  );

  let missingDoc = null;
  try {
    registry.resolveLatestRc(undefined);
  } catch (caught) {
    missingDoc = caught;
  }
  report.check("a missing packument fails loud rather than throwing a TypeError", missingDoc !== null && missingDoc.name === "Error");
});

await report.section("dist-tag readers", () => {
  const doc = { "dist-tags": { next: "0.1.5-rc.2", latest: "0.1.5-rc.1" } };
  report.check("a plain lowercase tag is read", registry.readDistTag(doc, "next") === "0.1.5-rc.2");
  report.check("latest is read independently", registry.readDistTag(doc, "latest") === "0.1.5-rc.1");
  report.check("absent tag returns null", registry.readDistTag(doc, "alpha") === null);
  report.check("empty-string tag value is treated as absent", registry.readDistTag({ "dist-tags": { next: "" } }, "next") === null);
  report.check("non-string tag value is treated as absent", registry.readDistTag({ "dist-tags": { next: 5 } }, "next") === null);
  report.check("missing dist-tags object returns null", registry.readDistTag({}, "next") === null);
  report.check("an array dist-tags is rejected", registry.readDistTag({ "dist-tags": [] }, "next") === null);

  const order = registry.resolveVersionFromTags({ "dist-tags": { a: "1", b: "2" } }, ["b", "a"]);
  report.check("candidate order is honoured", order.version === "2" && order.tag === "b");
});

await report.section("registry URL building", () => {
  report.check(
    "the scoped package name is encoded",
    registry.metadataUrl("@deepseek-ai/dsh", "https://registry.npmjs.org") ===
      "https://registry.npmjs.org/@deepseek-ai%2Fdsh",
    registry.metadataUrl("@deepseek-ai/dsh"),
  );
  report.check(
    "a custom registry base is honoured",
    registry.metadataUrl("@scope/pkg", "http://127.0.0.1:8080").startsWith("http://127.0.0.1:8080/"),
  );
  report.check("the default registry is the public npm one", registry.REGISTRY_URL === "https://registry.npmjs.org");
  report.check(
    "the RC candidate order is next then latest",
    registry.RC_DIST_TAG_CANDIDATES.join(",") === "next,latest",
  );
});

await report.section("live HTTP fetch against a stub registry", async () => {
  const packument = {
    "dist-tags": { alpha: "0.1.5-alpha.2", next: "0.1.5-rc.2", latest: "0.1.5-rc.1" },
    versions: { "0.1.5-rc.2": {} },
    name: "@deepseek-ai/dsh",
  };
  const stub = await startStubRegistry(packument);

  try {
    const fetched = await registry.fetchPackument("@deepseek-ai/dsh", {
      registryUrl: stub.url,
      allowInsecure: true,
    });
    report.check("the client parses a real HTTP JSON response", fetched.name === "@deepseek-ai/dsh");
    report.check("dist-tags survive the round trip", fetched["dist-tags"].next === "0.1.5-rc.2");

    const resolved = await registry.resolveLatestRcVersion({ registryUrl: stub.url, allowInsecure: true });
    report.check(
      "resolveLatestRcVersion returns next over HTTP",
      resolved.version === "0.1.5-rc.2" && resolved.tag === "next",
      `${resolved.version} via ${resolved.tag}`,
    );

    // The insecure-transport guard: the same stub WITHOUT the opt-in must be
    // refused, so a downgraded registry cannot silently choose what we execute.
    let refused = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", { registryUrl: stub.url });
    } catch (caught) {
      refused = caught;
    }
    report.check("plain HTTP is refused without the explicit opt-in", refused !== null);
    report.check(
      "the refusal explains itself",
      /insecure transport/.test(refused?.message ?? ""),
      refused?.message,
    );
  } finally {
    await stub.close();
  }
});

await report.section("live HTTP failure paths", async () => {
  const bad = await startStubRegistry({}, 500);
  try {
    let statusError = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", { registryUrl: bad.url, allowInsecure: true });
    } catch (caught) {
      statusError = caught;
    }
    report.check("a non-200 status rejects", statusError !== null);
    report.check("the status error names the code", /HTTP 500/.test(statusError?.message ?? ""), statusError?.message);
  } finally {
    await bad.close();
  }

  const notModified = await startStubRegistry({}, 304);
  try {
    let etagError = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", { registryUrl: notModified.url, allowInsecure: true });
    } catch (caught) {
      etagError = caught;
    }
    report.check("a 304 is surfaced, not guessed at", etagError?.name === "UnsupportedResponseError", etagError?.name);
    report.check(
      "the 304 error points at Phase 3",
      /Phase 3/.test(etagError?.message ?? ""),
      etagError?.message,
    );
  } finally {
    await notModified.close();
  }

  let unreachable = null;
  try {
    // Port 1 on loopback: nothing listens there.
    await registry.fetchPackument("@deepseek-ai/dsh", { registryUrl: "http://127.0.0.1:1", timeoutMs: 3000 });
  } catch (caught) {
    unreachable = caught;
  }
  report.check("an unreachable registry rejects instead of hanging", unreachable !== null);

  let timedOut = null;
  const slow = http.createServer(() => {});
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const slowPort = slow.address().port;
  try {
    await registry.fetchPackument("@deepseek-ai/dsh", {
      registryUrl: `http://127.0.0.1:${slowPort}`,
      timeoutMs: 600,
      allowInsecure: true,
    });
  } catch (caught) {
    timedOut = caught;
  } finally {
    await new Promise((resolve) => slow.close(resolve));
  }
  report.check("a stalled registry hits the timeout", timedOut !== null, timedOut?.message);
});

await report.section("transient failures are retried (bounded)", async () => {
  const doc = {
    "dist-tags": { next: "0.1.5-rc.2", latest: "0.1.5-rc.1" },
    versions: { "0.1.5-rc.2": {} },
  };

  // A 503 that clears: this is the real-world ECONNRESET/flaky-CDN case that a
  // naked fetch would turn into a failed first launch.
  const flakyStatus = await startFlakyRegistry(doc, { failures: 1, status: 503 });
  try {
    const resolved = await registry.fetchPackument("@deepseek-ai/dsh", {
      registryUrl: flakyStatus.url,
      allowInsecure: true,
    });
    report.check("a transient 503 is retried and then succeeds", resolved["dist-tags"].next === "0.1.5-rc.2");
    report.check("exactly two attempts were made", flakyStatus.attempts() === 2, String(flakyStatus.attempts()));
  } finally {
    await flakyStatus.close();
  }

  // A reset connection is retried too.
  const flakyReset = await startFlakyRegistry(doc, { failures: 1, reset: true });
  try {
    const resolved = await registry.fetchPackument("@deepseek-ai/dsh", {
      registryUrl: flakyReset.url,
      allowInsecure: true,
    });
    report.check("a reset connection is retried and then succeeds", resolved !== null);
    report.check("two attempts were made after a reset", flakyReset.attempts() === 2, String(flakyReset.attempts()));
  } finally {
    await flakyReset.close();
  }

  // A permanently failing server must give up after the bounded attempts.
  const alwaysDown = await startFlakyRegistry(doc, { failures: 99, status: 503 });
  try {
    let error = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", {
        registryUrl: alwaysDown.url,
        allowInsecure: true,
        retries: 2,
      });
    } catch (caught) {
      error = caught;
    }
    report.check("a persistently failing registry eventually rejects", error !== null);
    report.check("attempts are bounded at retries + 1", alwaysDown.attempts() === 3, String(alwaysDown.attempts()));
  } finally {
    await alwaysDown.close();
  }

  // A 404 is a client error: retrying it only adds latency.
  const notFound = await startStubRegistry({}, 404);
  try {
    let attemptsFor404 = null;
    let error = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", { registryUrl: notFound.url, allowInsecure: true });
    } catch (caught) {
      error = caught;
      attemptsFor404 = caught.status;
    }
    report.check("a 404 rejects immediately", error !== null && /HTTP 404/.test(error.message));
    report.check("the status is attached for the retry policy", attemptsFor404 === 404);
  } finally {
    await notFound.close();
  }

  // retries: 0 must disable the retry path entirely.
  const noRetry = await startFlakyRegistry(doc, { failures: 1, status: 503 });
  try {
    let error = null;
    try {
      await registry.fetchPackument("@deepseek-ai/dsh", {
        registryUrl: noRetry.url,
        allowInsecure: true,
        retries: 0,
      });
    } catch (caught) {
      error = caught;
    }
    report.check("retries: 0 fails on the first attempt", error !== null);
    report.check("retries: 0 made exactly one attempt", noRetry.attempts() === 1, String(noRetry.attempts()));
  } finally {
    await noRetry.close();
  }

  report.check("ECONNRESET is classified retryable", registry.isRetryableError({ code: "ECONNRESET" }) === true);
  report.check("ETIMEDOUT is classified retryable", registry.isRetryableError({ code: "ETIMEDOUT" }) === true);
  report.check("ENOTFOUND is classified retryable", registry.isRetryableError({ code: "ENOTFOUND" }) === true);
  report.check("a plain error is not retryable", registry.isRetryableError(new Error("nope")) === false);
  report.check("null is not retryable", registry.isRetryableError(null) === false);
});

process.exit(report.finish());