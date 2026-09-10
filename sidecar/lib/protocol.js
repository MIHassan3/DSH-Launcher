/**
 * Handshake contract between the Node sidecar and the Tauri (Rust) shell.
 *
 * Phase 0 transport is stdout ONLY - no socket, no IPC file.
 * (docs/PROJECT_DSH-DOCK.md section 4, and the Phase 0 IPC decision.)
 *
 * Phase 1 adds a local HTTP request/response protocol for command traffic.
 * Stdout is NEVER used for command traffic beyond this initial handshake.
 */

/** Bump only on a breaking change to the handshake. */
export const PROTOCOL_VERSION = 1;

/** Prefix of the single line the sidecar writes to stdout when ready. */
export const READY_PREFIX = "SIDECAR_READY:";

/**
 * Matches the ready line and captures the port.
 * Kept here so the Rust side and the JS side agree on one definition.
 */
export const READY_PATTERN = /^SIDECAR_READY:(\d{1,5})$/;

/** Builds the exact ready line. Always emitted with a trailing newline. */
export function formatReadyLine(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid port for ready line: ${String(port)}`);
  }
  return `${READY_PREFIX}${port}`;
}

/** Parses a ready line. Returns the port, or null if the line is not one. */
export function parseReadyLine(line) {
  if (typeof line !== "string") return null;
  const match = READY_PATTERN.exec(line.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
