/**
 * npm registry client (docs/PROJECT_DSH-DOCK.md sections 3.1 and 3.2).
 *
 * Phase 1 needs exactly two things from the registry:
 *   1. resolve the version to install ("latest RC")
 *   2. fail loudly and readably when the registry does not offer one
 *
 * The ETag/304 caching and 12-hour cadence in section 3.2 belong to Phase 3 and
 * are deliberately NOT implemented here. `UnsupportedResponseError` is the
 * explicit seam for that: if the registry answers 304 to a request we made
 * without an `If-None-Match`, we say so rather than guessing.
 *
 * DIST-TAG REALITY (verified against the registry on 2026-09-10; reported to
 * the project owner, who owns docs/PROJECT_DSH-DOCK.md):
 *
 *   The spec's section 3.1 maps the RC channel to the dist-tag `latest-rc`.
 *   That tag does not exist. The registry publishes only:
 *
 *     { "alpha": "0.1.5-alpha.2", "next": "0.1.5-rc.2", "latest": "0.1.5-rc.1" }
 *
 *   and `latest` itself currently points at an RC build, not a stable release.
 *
 * Per the owner's decision, "latest RC" therefore resolves:
 *
 *   next  ->  latest  ->  hard failure
 *
 * with NO fallback to `alpha`: silently installing an alpha build when RC was
 * asked for is worse than failing. The failure names every tag that was
 * checked, so the error is actionable without reading this file.
 */

import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";

import { HARNESS_PACKAGE } from "./version-manager.js";

/** Registry origin. Overridable for tests and for corporate mirrors. */
export const REGISTRY_URL = "https://registry.npmjs.org";

/**
 * Dist-tags that may satisfy a request for the "latest RC" channel, in
 * preference order (see the note at the top of this file).
 */
export const RC_DIST_TAG_CANDIDATES = Object.freeze(["next", "latest"]);

/**
 * Minimum interval between background update checks, in milliseconds.
 * Section 3.2 / Q9: at most once per 12 hours, regardless of user settings.
 * Unused until Phase 3; declared here so the constant has one home.
 */
export const MIN_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Raised when the registry answered in a way Phase 1 does not implement. */
export class UnsupportedResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedResponseError";
  }
}

/**
 * Builds the registry metadata URL for a package.
 * Scoped names must have their "/" encoded.
 */
export function metadataUrl(packageName, registryUrl = REGISTRY_URL) {
  return `${registryUrl}/${packageName.replace("/", "%2F")}`;
}

/**
 * Transport error codes that are safe to retry on an idempotent GET.
 *
 * Observed in practice: a real `resolveLatestRcVersion()` against the public
 * registry failed with ECONNRESET on one attempt. Without a retry that becomes a
 * failed first launch for a user whose network hiccuped for a moment.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** HTTP statuses worth retrying: server-side or rate-limit, never client error. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Default extra attempts after the first failure. */
export const DEFAULT_REGISTRY_RETRIES = 2;

/** Base backoff in ms; grows linearly so two retries stay well under 2s total. */
const RETRY_BACKOFF_MS = 400;

/** True when an error's code is in the retryable set. */
export function isRetryableError(error) {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return RETRYABLE_CODES.has(code);
}

/**
 * Performs ONE HTTP GET and resolves the parsed JSON packument.
 * Transport concerns only; retry policy lives in [`fetchPackument`].
 */
function fetchPackumentOnce(packageName, url, timeoutMs, allowInsecure) {
  const transport = url.startsWith("https:") ? httpsGet : httpGet;
  const insecure = !url.startsWith("https:");

  return new Promise((resolve, reject) => {
    if (insecure && allowInsecure !== true) {
      reject(
        new Error(
          `Refusing to fetch ${packageName} over an insecure transport: ${url}. ` +
            `Pass allowInsecure only for a loopback test registry.`,
        ),
      );
      return;
    }

    const req = transport(
      url,
      {
        headers: {
          // npm's own Accept header. Asking for the abbreviated document is a
          // deliberate non-goal: we need `versions` for validation, and Phase 1
          // tolerates the larger payload.
          accept: "application/json",
          "user-agent": "dsh-dock-launcher",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Phase 3 owns ETag caching (section 3.2). We never send
        // `If-None-Match`, so a 304 here means something upstream is caching on
        // our behalf; surface it instead of pretending it did not happen.
        if (status === 304) {
          res.resume();
          reject(
            new UnsupportedResponseError(
              `Registry answered 304 Not Modified for ${packageName}, but Phase 1 sends no ` +
                `If-None-Match header. ETag caching arrives in Phase 3 (section 3.2).`,
            ),
          );
          return;
        }

        if (status !== 200) {
          res.resume();
          const error = new Error(`Registry returned HTTP ${status} for ${url}`);
          error.status = status;
          reject(error);
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Registry returned unparseable JSON for ${url}: ${error.message}`));
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      const error = new Error(`Registry request timed out after ${timeoutMs}ms: ${url}`);
      error.code = "ETIMEDOUT";
      req.destroy(error);
    });
    req.on("error", (error) => reject(error));
  });
}

/**
 * Fetches a package's packument (full metadata document), with bounded retries.
 *
 * Uses the `node:http(s)` clients directly rather than `fetch`. Rationale:
 * immune to `HTTP_PROXY`/`fetch` differences across Node versions, no polyfill,
 * and explicit control of the abort path. (This was not theoretical -
 * `Invoke-RestMethod` and `npm view` both failed on this machine with TLS/cache
 * errors while `node:https` succeeded.)
 *
 * HTTPS is REQUIRED by default. Plain HTTP is refused unless `allowInsecure` is
 * set, which exists only so tests can point at a loopback stub server. A
 * registry response decides which harness version gets executed, so accepting it
 * over an unauthenticated transport is not a default we want.
 *
 * Retries only unambiguous, idempotent failures: transport errors and
 * server/rate-limit statuses. A 4xx client error, a 304, or unparseable JSON
 * fails immediately - retrying those would just add latency to a real error.
 *
 * Rejects on: insecure URL, transport error after retries, timeout, non-200
 * status, unparseable JSON, and 304 (see [`UnsupportedResponseError`]).
 *
 * @param {string} packageName
 * @param {{registryUrl?: string, timeoutMs?: number, allowInsecure?: boolean,
 *          retries?: number}} [options]
 */
export function fetchPackument(packageName, options = {}) {
  const registryUrl = options.registryUrl ?? REGISTRY_URL;
  const url = metadataUrl(packageName, registryUrl);
  const timeoutMs = options.timeoutMs ?? 30000;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_REGISTRY_RETRIES;

  const attempt = async (remaining) => {
    try {
      return await fetchPackumentOnce(packageName, url, timeoutMs, options.allowInsecure);
    } catch (error) {
      const retryable = isRetryableError(error) || RETRYABLE_STATUSES.has(error?.status);
      if (!retryable || remaining <= 0) throw error;

      process.stderr.write(
        `[sidecar] registry fetch failed (${error.code ?? error.status ?? error.message}); ` +
          `retrying (${remaining} left)\n`,
      );
      await sleep(RETRY_BACKOFF_MS * (retries - remaining + 1));
      return attempt(remaining - 1);
    }
  };

  return attempt(retries);
}

/**
 * Reads a dist-tag from a packument, tolerating tag-name case.
 *
 * npm dist-tag names are case-insensitive in practice, so `Next` and `next`
 * both satisfy a lookup for `next`. An exact match is preferred when present.
 *
 * Returns null when the tag is absent or does not hold a non-empty string.
 */
export function readDistTag(packument, tag) {
  const tags = packument?.["dist-tags"];
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) return null;

  const direct = tags[tag];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const wanted = String(tag).toLowerCase();
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Resolves a version from a packument using an ordered candidate tag list.
 *
 * The error message is a deliberate part of the contract: it names the package
 * and EVERY tag checked, so an operator can act on it without reading code.
 *
 * @param {object} packument
 * @param {string[]} candidateTags ordered by preference
 */
export function resolveVersionFromTags(packument, candidateTags) {
  const checked = [];

  for (const tag of candidateTags) {
    const version = readDistTag(packument, tag);
    checked.push(tag);
    if (version !== null) return { version, tag, checked };
  }

  const available = Object.keys(packument?.["dist-tags"] ?? {}).sort().join(", ") || "(none)";
  throw new Error(
    `Could not resolve a harness version: none of the dist-tags [${checked.join(", ")}] exist ` +
      `for ${HARNESS_PACKAGE}. Dist-tags present in the registry: ${available}. ` +
      `Refusing to fall back to another channel silently.`,
  );
}

/**
 * Resolves the "latest RC" harness version from a packument.
 *
 * Returns `{ version, tag, checked }` so callers can record WHICH tag satisfied
 * the request - useful in the state file and in diagnostics.
 */
export function resolveLatestRc(packument) {
  return resolveVersionFromTags(packument, RC_DIST_TAG_CANDIDATES);
}

/** Convenience: fetch the packument and resolve the latest RC in one call. */
export async function resolveLatestRcVersion(options = {}) {
  const packument = await fetchPackument(HARNESS_PACKAGE, options);
  return { ...resolveLatestRc(packument), packument };
}
