/**
 * Version library management - the heart of the product
 * (docs/PROJECT_DSH-DOCK.md section 3.1).
 *
 * PHASE 0 PLACEHOLDER. Nothing here performs I/O yet. These constants and
 * signatures exist so later phases have a settled seam, and so Phase 0 can
 * prove the sidecar handshake without pulling in the registry.
 *
 * Decided in section 8 of the project document:
 *   Q1 - bundle Node, sidecar stays plain JS
 *   Q3 - three channels: latest / latest-rc / alpha
 *   Q5 - populate the library with `npm install --prefix`, never `npm pack`
 *   Q14 - define a minimum supported version, warn below it, never block
 */

/**
 * Minimum harness version DSH-Dock supports.
 *
 * PLACEHOLDER "0.0.0". The real value is set in Phase 1 once we query the npm
 * registry and can choose it from actual published versions. Do not guess it.
 *
 * Behaviour when a user selects a version below this (section 3.2): allow it,
 * warn once, never block. The user is sovereign.
 */
export const MIN_SUPPORTED_DSH = "0.0.0";

/** npm dist-tag per channel. */
export const CHANNELS = Object.freeze({
  STABLE: "latest",
  RC: "latest-rc",
  ALPHA: "alpha",
});

/** Package name of the official harness. */
export const HARNESS_PACKAGE = "@deepseek-ai/dsh";

/**
 * Path of the harness entry point inside a version directory, relative to the
 * launcher data directory (section 3.1):
 *   versions/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js
 */
export const HARNESS_BIN_RELATIVE =
  "node_modules/@deepseek-ai/dsh/lib/bin.js";

/** Default cap on retained versions; exceeding it prompts, never auto-evicts. */
export const DEFAULT_VERSION_LIMIT = 10;
