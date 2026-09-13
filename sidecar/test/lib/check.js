/**
 * Minimal assertion helpers for sidecar tests.
 *
 * Shared so every test file reports in one format. Deliberately tiny: no test
 * framework, no dependencies (the sidecar has none by design), and no
 * `node:test` requirement, so a test can be run with a plain `node <file>`.
 *
 * Usage:
 *   import { createReport } from "./lib/check.js";
 *   const report = createReport("state");
 *   report.check("...", condition, "detail");
 *   process.exit(report.finish());
 */

import process from "node:process";

export function createReport(title) {
  let failures = 0;
  let checks = 0;

  process.stdout.write(`${title}\n`);

  return {
    check(label, ok, detail = "") {
      checks += 1;
      if (!ok) failures += 1;
      const status = ok ? "PASS" : "FAIL";
      process.stdout.write(`  [${status}] ${label}${detail ? ` - ${detail}` : ""}\n`);
      return ok;
    },

    /**
     * Runs an async body, reporting a throw as a single failed check instead
     * of letting an unhandled rejection abort the remaining assertions.
     */
    async section(label, body) {
      process.stdout.write(`\n${label}\n`);
      try {
        await body();
      } catch (error) {
        this.check(`${label} completed without throwing`, false, error.message);
      }
    },

    /** Prints the summary and returns the process exit code. */
    finish() {
      process.stdout.write(
        failures === 0
          ? `\nRESULT: all ${checks} checks passed\n`
          : `\nRESULT: ${failures} of ${checks} checks failed\n`,
      );
      return failures === 0 ? 0 : 1;
    },
  };
}

/** True when a function throws. Returns false when it does not. */
export function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
