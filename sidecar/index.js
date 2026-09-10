/**
 * DSH-Dock sidecar - entry point.
 *
 * Runs as: bundled-node(.exe) <path>/sidecar/index.js
 * During development it runs on system Node via `npm run sidecar`.
 *
 * Phase 0 responsibility (docs/PROJECT_DSH-DOCK.md section 4):
 *   Bind a dynamic port and announce it on stdout as a single line,
 *   `SIDECAR_READY:<port>`, which the Rust shell parses. See
 *   lib/protocol.js for the exact contract.
 *
 * This file is intentionally thin. Version management, registry polling,
 * settings I/O and harness spawning arrive in later phases.
 */

import fs from "node:fs";

import { startService } from "./lib/service.js";
import { formatReadyLine, PROTOCOL_VERSION } from "./lib/protocol.js";
import { MIN_SUPPORTED_DSH } from "./lib/version-manager.js";

// Phase 1 will replace this with the real minimum supported harness version,
// resolved from the registry rather than guessed.
void MIN_SUPPORTED_DSH;

const service = await startService();

// TEST-ONLY ESCAPE HATCH - NOT PART OF THE PRODUCT CONTRACT.
//
// When and only when the DSH_DOCK_PORT_FILE environment variable is set, the
// chosen port is mirrored to that file. It is never written unconditionally.
//
// The Rust shell in src-tauri/src/lib.rs MUST learn the port from the stdout
// handshake below and MUST NOT read this file. The only permitted reader is
// sidecar/test/smoke.js, which needs it because confined execution
// environments block a node-to-node piped stdout capture.
const portFile = process.env.DSH_DOCK_PORT_FILE;
if (portFile) {
  try {
    fs.writeFileSync(portFile, String(service.port), "utf8");
  } catch (error) {
    process.stderr.write(`[sidecar] could not write port file: ${error.message}\n`);
  }
}

// The handshake. This MUST be exactly one line on stdout and must be written
// only after the port is known and the socket is actually listening.
process.stdout.write(`${formatReadyLine(service.port)}\n`);

// Deliberately not wired to `exit`: on a hard `exit` the process would die
// while an async close is still in flight, which is not a clean shutdown.
// SIGINT/SIGTERM are forwarded so a dev-run sidecar can be stopped with Ctrl+C.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    service
      .dispose()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

process.stderr.write(
  `[sidecar] DSH-Dock core listening on http://${service.host}:${service.port} ` +
    `(protocol v${PROTOCOL_VERSION})\n`,
);
