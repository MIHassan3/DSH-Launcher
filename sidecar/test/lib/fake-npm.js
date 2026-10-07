/**
 * Stub npm used by sidecar/test/harness-install.js.
 *
 * Simulates an npm process deterministically, so the install module's exit-code,
 * timeout and validation branches can be exercised WITHOUT performing a real
 * install. Behavior is chosen by environment variables:
 *
 *   FAKE_NPM_MODE=ok|fail|hang     (default: ok)
 *   FAKE_NPM_MAKE_BIN=1            create the entry point under --prefix
 *   FAKE_NPM_MAKE_WEB_APP=1        also create @deepseek-ai/dsh-web-app (so the
 *                                  tree passes Phase 2 validation)
 *   FAKE_NPM_MAKE_MANIFEST=1       also create @deepseek-ai/dsh/package.json
 *   FAKE_NPM_MAKE_NODE_MODULES=1   create node_modules even with nothing in it
 *                                  (used to prove the staged path's content check)
 *   FAKE_NPM_TOUCH=<relative path> create an arbitrary file/tree under --prefix
 *   FAKE_NPM_EXIT=<n>              exit code to use for `fail`
 *   FAKE_NPM_DELAY_MS=<n>          sleep before acting (for the timeout test)
 *
 * It also echoes the arguments it received, so the test can assert the exact
 * flag set the launcher passes to npm.
 *
 * Note on the three MAKE_* flags: `FAKE_NPM_MAKE_BIN=1` alone produces a tree
 * that Phase 2 validation REJECTS (no web-app, no manifest), which is exactly
 * what the validation tests need. Producing a tree that PASSES takes all three.
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

// Optional invocation counter. When set, one line is appended per run, which is
// how a test proves that npm was invoked MORE THAN ONCE - i.e. that the in-place
// fallback really ran, rather than the staged attempt merely failing.
if (process.env.FAKE_NPM_COUNTER_FILE) {
  const fs = await import("node:fs");
  fs.appendFileSync(
    process.env.FAKE_NPM_COUNTER_FILE,
    `${JSON.stringify({ argv })}\n`,
    "utf8",
  );
}

const flagValue = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
};

const mode = process.env.FAKE_NPM_MODE ?? "ok";
const delayMs = Number(process.env.FAKE_NPM_DELAY_MS ?? "0");
const prefix = flagValue("--prefix");

/**
 * Model the environmental failure the fallback exists for: npm treats the prefix
 * as "the project directory" and writes into `<prefix>/<something>` instead of
 * `<prefix>` itself, so no `node_modules` appears where the launcher expects it.
 *
 * This is what a `--prefix` + trailing-separator disagreement looks like from the
 * launcher's side, and it is the ONLY way to exercise the staged-install fallback
 * deterministically without real npm (which the live tier in Step 5 uses).
 *
 *   FAKE_NPM_BREAK_STAGED=1   do nothing at all when --prefix names a staging dir
 */
const isStagingPrefix = typeof prefix === "string" && prefix.includes(".staging-");

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
} else if (prefix) {
  const fs = await import("node:fs");
  const path = await import("node:path");

  // The staging-failure model: leave the staging prefix untouched, so the
  // launcher's content check finds no node_modules there and falls back.
  if (process.env.FAKE_NPM_BREAK_STAGED === "1" && isStagingPrefix) {
    process.stdout.write("fake npm: staging prefix deliberately not populated\n");
  } else {
    const scope = path.join(prefix, "node_modules", "@deepseek-ai");
    const packageName = flagValue("--package-name") ?? "@deepseek-ai/dsh";
    const versionFromArgv =
      argv.find((arg) => arg.startsWith("@deepseek-ai/dsh@"))?.split("@").pop() ?? "0.0.0";

    if (process.env.FAKE_NPM_MAKE_NODE_MODULES === "1") {
      fs.mkdirSync(path.join(prefix, "node_modules"), { recursive: true });
    }

    if (process.env.FAKE_NPM_MAKE_BIN === "1") {
      const dir = path.join(scope, "dsh", "lib");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "bin.js"),
        "// fake harness entry point\nprocess.exit(0);\n",
        "utf8",
      );
    }

    if (process.env.FAKE_NPM_MAKE_MANIFEST === "1") {
      const dir = path.join(scope, "dsh");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name: packageName, version: versionFromArgv }, null, 2)}\n`,
        "utf8",
      );
    }

    if (process.env.FAKE_NPM_MAKE_WEB_APP === "1") {
      const dir = path.join(scope, "dsh-web-app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name: "@deepseek-ai/dsh-web-app" }, null, 2)}\n`,
        "utf8",
      );
    }

    if (process.env.FAKE_NPM_TOUCH) {
      const target = path.join(prefix, process.env.FAKE_NPM_TOUCH);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "touched by fake npm\n", "utf8");
    }
  }
}

if (mode !== "hang") {
  process.stdout.write(`fake npm: done (${version ? "version-present" : "no-version"})\n`);
  process.exit(0);
}
