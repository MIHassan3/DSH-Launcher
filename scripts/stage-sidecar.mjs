/**
 * Stages the runtime sidecar files for Tauri's `bundle.resources`.
 *
 * WHAT IS COPIED
 *   Everything under `sidecar/`, recursively - with one deliberate exception
 *   list below. The default is INCLUDE.
 *
 * WHY AN EXCLUSION LIST AND NOT AN INCLUSION LIST
 *   The sidecar's file structure is expected to change (Phase 2 adds runtime
 *   code). An inclusion list ("copy index.js, package.json and lib/") would
 *   silently ship a broken installer the first time a new runtime directory
 *   appeared: the build would succeed, the installer would build, and the app
 *   would fail in the field with "sidecar/index.js not found" - the exact class
 *   of bug this script exists to prevent. An exclusion list fails in the safe
 *   direction: new runtime files are picked up automatically.
 *
 * WHAT IS EXCLUDED, AND WHY
 *   test/              Tests are not runtime code, and shipping them would put
 *                      fixtures and assertions inside every user's install.
 *                      THIS IS THE ONLY PERMANENTLY EXCLUDED DIRECTORY.
 *   node_modules/      The launcher's sidecar has no runtime dependencies; it
 *                      uses Node built-ins only. It is also installed by the
 *                      user's own npm at harness-install time, never by us.
 *   package-lock.json  Build metadata, not needed to execute the sidecar.
 *   *.log              Runtime debris, never a build input.
 *
 * IF PHASE 2 ADDS A NEW *TEST* DIRECTORY, add its name to EXCLUDED_DIRECTORIES.
 * If it adds a new *runtime* directory, nothing needs to change.
 *
 * OUTPUT
 *   src-tauri/target/sidecar-resources/sidecar/...
 *   `src-tauri/target/` is gitignored, so nothing here is ever committed.
 *
 *   tauri.conf.json references it as the RELATIVE path
 *   `target/sidecar-resources/sidecar/` (relative to src-tauri/, which is where
 *   the config lives), mapped to destination `sidecar/`. In the installed app
 *   that yields `<install-dir>/sidecar/index.js`.
 *
 *   Both must be updated together if this location ever moves.
 *
 * Run from the repo root:  node scripts/stage-sidecar.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const SOURCE_DIR = path.join(REPO_ROOT, "sidecar");

/** Must live under `target/`, which is gitignored (see .gitignore). */
const STAGE_ROOT = path.join(REPO_ROOT, "src-tauri", "target", "sidecar-resources");
const STAGE_DIR = path.join(STAGE_ROOT, "sidecar");

/**
 * Directory names never copied. `test` is the only permanent entry - see the
 * header. Matching is by exact directory name at any depth, except at the root
 * of the sidecar, which is where these actually live.
 */
const EXCLUDED_DIRECTORIES = new Set(["test", "node_modules"]);

/** File names never copied. */
const EXCLUDED_FILES = new Set(["package-lock.json"]);

/** File extensions never copied. */
const EXCLUDED_EXTENSIONS = new Set([".log"]);

/** True when a file should be skipped. */
function isExcludedFile(name) {
  if (EXCLUDED_FILES.has(name)) return true;
  return EXCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Recursively collects the relative paths of everything to stage.
 *
 * Returns `{ files, skipped }` so the caller can report exactly what it decided
 * - a packaging script that silently drops files is as dangerous as one that
 * silently ships the wrong ones.
 */
function collect(sourceDir, relative = "") {
  const files = [];
  const skipped = [];

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const relativePath = relative ? path.join(relative, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        skipped.push(`${relativePath}${path.sep} (excluded directory)`);
        continue;
      }
      const nested = collect(path.join(sourceDir, entry.name), relativePath);
      files.push(...nested.files);
      skipped.push(...nested.skipped);
      continue;
    }

    if (entry.isSymbolicLink()) {
      // A symlink could point outside the repo; refuse rather than follow it.
      skipped.push(`${relativePath} (symlink, not followed)`);
      continue;
    }

    if (isExcludedFile(entry.name)) {
      skipped.push(`${relativePath} (excluded file)`);
      continue;
    }

    files.push(relativePath);
  }

  return { files, skipped };
}

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    process.stderr.write(`stage-sidecar: source directory not found: ${SOURCE_DIR}\n`);
    process.exit(1);
  }

  // Start clean so a file deleted from the repo cannot linger in the bundle.
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  const { files, skipped } = collect(SOURCE_DIR);

  if (files.length === 0) {
    process.stderr.write("stage-sidecar: nothing to stage - refusing to build an empty bundle\n");
    process.exit(1);
  }

  for (const relativePath of files) {
    const from = path.join(SOURCE_DIR, relativePath);
    const to = path.join(STAGE_DIR, relativePath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  // A bundler that cannot find index.js would produce an installer that fails at
  // runtime with an unhelpful message, so fail here instead.
  if (!files.includes("index.js")) {
    process.stderr.write("stage-sidecar: sidecar/index.js was not staged - aborting\n");
    process.exit(1);
  }

  const dest = path.relative(REPO_ROOT, STAGE_DIR);
  process.stdout.write(`stage-sidecar: staged ${files.length} file(s) into ${dest}\n`);
  for (const relativePath of files.sort()) {
    process.stdout.write(`  + ${relativePath}\n`);
  }
  for (const entry of skipped.sort()) {
    process.stdout.write(`  - ${entry}\n`);
  }
}

main();
