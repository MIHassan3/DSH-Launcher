/**
 * npm registry client (docs/PROJECT_DSH-DOCK.md sections 3.1 and 3.2).
 *
 * PHASE 0 PLACEHOLDER. No network calls happen in Phase 0 - as a matter of
 * principle the network is never on the startup critical path (section 3.3),
 * and Phase 0 does not need it at all.
 *
 * Phase 1+ implements:
 *   - dist-tag resolution for latest / latest-rc / alpha
 *   - `npm install --prefix <version-dir>` for populating the library
 *   - ETag caching with `If-None-Match`, honouring 304 Not Modified
 *   - the 12-hour polling cadence recorded as `lastUpdateCheck`
 */

/** Registry origin. Overridable for tests and for corporate mirrors. */
export const REGISTRY_URL = "https://registry.npmjs.org";

/**
 * Minimum interval between background update checks, in milliseconds.
 * Section 3.2 / Q9: at most once per 12 hours, regardless of user settings.
 */
export const MIN_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Builds the registry metadata URL for a package.
 * Scoped names must have their "/" encoded.
 */
export function metadataUrl(packageName, registryUrl = REGISTRY_URL) {
  return `${registryUrl}/${packageName.replace("/", "%2F")}`;
}
