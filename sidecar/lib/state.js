/**
 * Launcher state directory resolution (docs/PROJECT_DSH-DOCK.md section 2.4).
 *
 * PHASE 0 PLACEHOLDER. Path resolution is implemented here because it is pure
 * and testable, but NO caller uses it yet - Phase 1 owns runtime-state.json.
 *
 * Per-OS launcher data directory:
 *   Windows  %LOCALAPPDATA%\DSH-Dock\
 *   macOS    ~/Library/Application Support/DSH-Dock/
 *   Linux    $XDG_DATA_HOME/dsh-dock/ (default ~/.local/share/dsh-dock/)
 *
 * $DSH_HOME is NOT resolved here. It is the harness's own environment
 * variable, passed through untouched and never read, written, or cached
 * (section 2.4 and Q8).
 */

import os from "node:os";
import path from "node:path";

/** Directory name used on Windows and macOS. */
export const APP_DIR_NAME = "DSH-Dock";

/** Directory name used on Linux, where lowercase is conventional. */
export const APP_DIR_SLUG = "dsh-dock";

/**
 * Absolute path of the launcher data directory for the current platform.
 *
 * Note: this is the launcher's OWN state directory, not a project file path.
 * It is resolved at runtime and never persisted into a config file.
 */
export function resolveStateDir() {
  const platform = process.platform;

  if (platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
  }

  const base =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, APP_DIR_SLUG);
}

/**
 * Entries that live inside the launcher data directory (section 2.4).
 * Provided as a map so callers do not hand-build path fragments.
 */
export function resolveStatePaths() {
  const root = resolveStateDir();
  return Object.freeze({
    root,
    settings: path.join(root, "settings.json"),
    runtimeState: path.join(root, "runtime-state.json"),
    versions: path.join(root, "versions"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
  });
}
