/**
 * Stub npm used by sidecar/test/harness-install.js.
 *
 * Simulates an npm process deterministically, so the install module's exit-code,
 * timeout and missing-entry-point branches can be exercised WITHOUT performing a
 * real install. Behavior is chosen by environment variables:
 *
 *   FAKE_NPM_MODE=ok|fail|hang     (default: ok)
 *   FAKE_NPM_MAKE_BIN=1            create the real bin.js layout under --prefix
 *   FAKE_NPM_EXIT=<n>              exit code to use for `fail`
 *   FAKE_NPM_DELAY_MS=<n>          sleep before acting (for the timeout test)
 *
 * It also echoes the arguments it received, so the test can assert the exact
 * flag set the launcher passes to npm.
 *
 * Not part of the product. Safe to delete if the test stops using it.
 */

const version = (
  process.env.npm_package_version_placeholder ??
  process.env.npm_config_user_agent ??
  ""
).trim();

const argv = process.argv.slice(2);
process.stdout.write(`FAKE_NPM_ARGV ${JSON.stringify(argv)}\n`);

const flagValue = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
};

const mode = process.env.FAKE_NPM_MODE ?? "ok";
const delayMs = Number(process.env.FAKE_NPM_DELAY_MS ?? "0");
const prefix = flagValue("--prefix");

if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (mode === "hang") {
  // Never exits, so the install timeout path is exercised.
  //
  // NB: this must NOT be a bare `await new Promise(() => {})`. That is an
  // UNSETTLED top-level await, which Node reports by exiting 13 on its own -
  // the stub would die before the timeout fired and the test would silently be
  // exercising the wrong branch. A repeating timer keeps the loop alive.
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("fake npm: simulated failure\n");
  process.exit(Number(process.env.FAKE_NPM_EXIT ?? "1"));
} else if (process.env.FAKE_NPM_MAKE_BIN === "1" && prefix) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "bin.js"),
    "// fake harness entry point\nprocess.exit(0);\n",
    "utf8",
  );
}

if (mode !== "hang") {
  process.stdout.write(`fake npm: done (${version ? "version-present" : "no-version"})\n`);
  process.exit(0);
}
