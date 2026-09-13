/**
 * Pause point 1 - state directory and runtime-state file.
 *
 * Proves, with no network and no harness involved:
 *   - all three per-OS data-directory branches resolve correctly
 *   - the DSH_DOCK_DATA_DIR override wins, and is READ not written
 *   - directory creation is idempotent and creates nothing spurious
 *   - runtime-state.json round-trips atomically through write/read
 *   - every invalid shape is rejected, and reported as `invalid` not thrown
 *
 * Run from the repo root:  node sidecar/test/state.js
 * Exits 0 on success, 1 on failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createReport, throws } from "./lib/check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, ".test-tmp", "state");

// Recorded before any test touches the environment, so the "unset" assertions
// can be skipped honestly on a machine that already exports the override.
const INHERITED_OVERRIDE = process.env.DSH_DOCK_DATA_DIR;

const report = createReport("DSH-Dock state: data dir + runtime-state.json");

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const state = await import("../lib/state.js");

await report.section("per-OS data directory (section 2.4)", () => {
  // Expected values are built with the path flavour of the TARGET platform, not
  // the host's. On Windows, `path.join` would emit backslashes for the macOS and
  // Linux cases and the assertion would agree with a wrong resolver.
  const winJoin = path.win32.join;
  const posixJoin = path.posix.join;

  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" };
  const win = state.defaultDataDirFor("win32", env, "C:\\Users\\tester");
  report.check(
    "Windows uses %LOCALAPPDATA%\\DSH-Dock",
    win === winJoin(env.LOCALAPPDATA, "DSH-Dock"),
    win,
  );

  const winFallback = state.defaultDataDirFor("win32", {}, "C:\\Users\\tester");
  report.check(
    "Windows falls back to AppData\\Local when LOCALAPPDATA is unset",
    winFallback === winJoin("C:\\Users\\tester", "AppData", "Local", "DSH-Dock"),
    winFallback,
  );

  const mac = state.defaultDataDirFor("darwin", {}, "/Users/tester");
  report.check(
    "macOS uses ~/Library/Application Support/DSH-Dock",
    mac === posixJoin("/Users/tester", "Library", "Application Support", "DSH-Dock"),
    mac,
  );
  report.check(
    "macOS emits POSIX separators even when resolved on Windows",
    !mac.includes("\\"),
    mac,
  );

  const linuxXdg = state.defaultDataDirFor("linux", { XDG_DATA_HOME: "/xdg/data" }, "/home/tester");
  report.check(
    "Linux honours $XDG_DATA_HOME with the lowercase slug",
    linuxXdg === posixJoin("/xdg/data", "dsh-dock"),
    linuxXdg,
  );

  const linuxDefault = state.defaultDataDirFor("linux", {}, "/home/tester");
  report.check(
    "Linux defaults to ~/.local/share/dsh-dock",
    linuxDefault === posixJoin("/home/tester", ".local", "share", "dsh-dock"),
    linuxDefault,
  );
  report.check(
    "Linux emits POSIX separators even when resolved on Windows",
    !linuxDefault.includes("\\"),
    linuxDefault,
  );

  const linuxBlank = state.defaultDataDirFor("linux", { XDG_DATA_HOME: "   " }, "/home/tester");
  report.check("A blank $XDG_DATA_HOME is treated as unset", linuxBlank === linuxDefault, linuxBlank);

  report.check(
    "each OS gets its documented folder name",
    win.endsWith("DSH-Dock") && mac.endsWith("DSH-Dock") && linuxDefault.endsWith("dsh-dock"),
  );
});

await report.section("DSH_DOCK_DATA_DIR override", () => {
  const target = path.join(TMP_ROOT, "override-data");
  process.env.DSH_DOCK_DATA_DIR = target;

  const paths = state.resolveStatePaths();
  report.check("override wins over the OS default", paths.root === path.resolve(target), paths.root);
  report.check(
    "runtime-state.json lives under the override",
    paths.runtimeState === path.join(path.resolve(target), "runtime-state.json"),
    paths.runtimeState,
  );
  report.check(
    "logs/ lives under the override, never in $DSH_HOME",
    paths.logs === path.join(path.resolve(target), "logs"),
    paths.logs,
  );
  report.check(
    "the npm cache lives inside the override",
    paths.npmCache === path.join(path.resolve(target), ".npm-cache"),
    paths.npmCache,
  );

  const userHome = os.homedir();
  report.check(
    "no resolved path falls inside the user's home .dsh directory",
    ![paths.root, paths.logs, paths.cache, paths.versions].some((p) =>
      p.startsWith(path.join(userHome, ".dsh")),
    ),
  );

  // The launcher must never assign to the variable it reads.
  report.check(
    "resolving does not modify the environment variable",
    process.env.DSH_DOCK_DATA_DIR === target,
  );

  process.env.DSH_DOCK_DATA_DIR = "   ";
  report.check(
    "a whitespace-only override counts as unset",
    state.dataDirOverride() === null,
  );

  delete process.env.DSH_DOCK_DATA_DIR;
  if (INHERITED_OVERRIDE === undefined) {
    report.check("unset override returns null", state.dataDirOverride() === null);
    report.check(
      "unset override falls back to the OS-native default",
      state.resolveDataDir() === state.defaultDataDirFor(process.platform, process.env, os.homedir()),
      state.resolveDataDir(),
    );
  } else {
    report.check(
      "unset-override assertions skipped: DSH_DOCK_DATA_DIR was inherited from the shell",
      true,
    );
  }
});

await report.section("directory creation", () => {
  const target = path.join(TMP_ROOT, "created");
  process.env.DSH_DOCK_DATA_DIR = target;

  const paths = state.resolveStatePaths();
  const created = state.ensureDataDirs(paths);
  report.check("ensureDataDirs created the root", fs.existsSync(paths.root));
  report.check("ensureDataDirs created versions/", fs.existsSync(paths.versions));
  report.check("ensureDataDirs created logs/", fs.existsSync(paths.logs));
  report.check("ensureDataDirs created cache/", fs.existsSync(paths.cache));
  report.check("ensureDataDirs reports what it created", created.length === 4);

  const again = state.ensureDataDirs(paths);
  report.check("ensureDataDirs is idempotent", again.length === 4 && fs.existsSync(paths.root));
  report.check(
    "creation does not invent settings.json",
    !fs.existsSync(paths.settings),
  );
  report.check(
    "creation does not invent runtime-state.json",
    !fs.existsSync(paths.runtimeState),
  );
});

await report.section("runtime-state.json round-trip", () => {
  const target = path.join(TMP_ROOT, "roundtrip");
  process.env.DSH_DOCK_DATA_DIR = target;
  const paths = state.resolveStatePaths();
  state.ensureDataDirs(paths);

  report.check(
    "an absent state file reads as `absent`, not an error",
    state.readRuntimeState(paths.runtimeState).status === "absent",
  );

  const value = state.buildRuntimeState({
    instanceId: "20260910T120000-4242",
    pid: 4242,
    port: 53245,
    url: "http://127.0.0.1:53245/?token=abc123",
    harnessVersion: "0.1.5-rc.2",
    installDir: path.join(paths.versions, "0.1.5-rc.2"),
    startedAt: "2026-09-10T12:00:00.000Z",
  });

  state.writeRuntimeState(value, paths.runtimeState);

  report.check("the state file now exists", fs.existsSync(paths.runtimeState));
  report.check(
    "no .tmp sibling is left behind by the atomic write",
    !fs.existsSync(`${paths.runtimeState}.tmp`),
  );

  const readBack = state.readRuntimeState(paths.runtimeState);
  report.check("round-trip reads back as `ok`", readBack.status === "ok", readBack.status);
  report.check("pid survived", readBack.state?.pid === 4242);
  report.check("port survived", readBack.state?.port === 53245);
  report.check("url survived verbatim", readBack.state?.url === value.url);
  report.check("harnessVersion survived", readBack.state?.harnessVersion === "0.1.5-rc.2");
  report.check("recordedAt was stamped", typeof readBack.state?.recordedAt === "string");

  const onDisk = JSON.parse(fs.readFileSync(paths.runtimeState, "utf8"));
  report.check("the file on disk is valid JSON with a version tag", onDisk.version === 1);

  report.check("clearRuntimeState removes it", state.clearRuntimeState(paths.runtimeState) === true);
  report.check("clearing twice reports nothing removed", state.clearRuntimeState(paths.runtimeState) === false);
  report.check(
    "a cleared state reads as `absent` again",
    state.readRuntimeState(paths.runtimeState).status === "absent",
  );
});

await report.section("invalid state is rejected, never thrown", () => {
  const target = path.join(TMP_ROOT, "invalid");
  process.env.DSH_DOCK_DATA_DIR = target;
  const paths = state.resolveStatePaths();
  state.ensureDataDirs(paths);

  const good = {
    version: 1,
    recordedAt: "2026-09-10T12:00:00.000Z",
    instanceId: "i",
    pid: 1,
    port: 1234,
    url: "http://127.0.0.1:1234/?token=fixture",
    harnessVersion: "0.1.5-rc.2",
    installDir: "/somewhere/versions/0.1.5-rc.2",
    startedAt: "2026-09-10T12:00:00.000Z",
  };
  report.check("the baseline fixture is valid", state.validateRuntimeState(good).length === 0);

  const cases = [
    ["pid 0", { ...good, pid: 0 }],
    ["negative pid", { ...good, pid: -5 }],
    ["pid as a string", { ...good, pid: "1234" }],
    ["port 0", { ...good, port: 0 }],
    ["port above 65535", { ...good, port: 70000 }],
    ["non-numeric port", { ...good, port: "1234" }],
    ["url using localhost", { ...good, url: "http://localhost:1234/?token=x" }],
    ["url without the harness token", { ...good, url: "http://127.0.0.1:1234/" }],
    ["url with a non-token query only", { ...good, url: "http://127.0.0.1:1234/?x=1" }],
    ["empty url", { ...good, url: "" }],
    ["missing installDir", { ...good, installDir: undefined }],
    ["missing instanceId", { ...good, instanceId: "" }],
    ["unparseable startedAt", { ...good, startedAt: "yesterday" }],
    ["wrong schema version", { ...good, version: 99 }],
  ];

  for (const [label, value] of cases) {
    report.check(`rejects ${label}`, state.validateRuntimeState(value).length > 0);
  }

  report.check(
    "the writer refuses to persist an invalid state",
    throws(() => state.writeRuntimeState({ ...good, pid: 0 }, paths.runtimeState)),
  );

  fs.writeFileSync(paths.runtimeState, "{ not json", "utf8");
  const corrupt = state.readRuntimeState(paths.runtimeState);
  report.check("corrupt JSON reads as `invalid`, not a throw", corrupt.status === "invalid", corrupt.status);
  report.check("corrupt JSON reports a reason", (corrupt.problems?.[0] ?? "").length > 0);

  fs.writeFileSync(paths.runtimeState, JSON.stringify({ ...good, port: 99999 }), "utf8");
  const wrongShape = state.readRuntimeState(paths.runtimeState);
  report.check("a structurally wrong state reads as `invalid`", wrongShape.status === "invalid");
  report.check("the raw value is preserved for diagnostics", wrongShape.raw?.port === 99999);

  report.check(
    "an array is not a valid state object",
    state.validateRuntimeState([good]).length > 0,
  );
});

await report.section("harness log naming", () => {
  const target = path.join(TMP_ROOT, "logs");
  process.env.DSH_DOCK_DATA_DIR = target;
  const paths = state.resolveStatePaths();

  const one = state.harnessLogFile("20260910T120000-4242");
  const two = state.harnessLogFile("20260910T130000-5150");
  report.check(
    "the log file lives in <data-dir>/logs",
    path.dirname(one) === paths.logs,
    one,
  );
  report.check("distinct instances get distinct files", one !== two);
  report.check(
    "the name is a plain harness-<id>.log",
    path.basename(one) === "harness-20260910T120000-4242.log",
    path.basename(one),
  );
  report.check(
    "path separators in an id cannot escape the logs directory",
    path.dirname(state.harnessLogFile("..\\..\\evil")) === paths.logs,
    state.harnessLogFile("..\\..\\evil"),
  );
  report.check(
    "a missing id falls back to harness.log",
    path.basename(state.harnessLogFile(undefined)) === "harness.log",
  );
});

process.env.DSH_DOCK_DATA_DIR = INHERITED_OVERRIDE;
if (INHERITED_OVERRIDE === undefined) delete process.env.DSH_DOCK_DATA_DIR;

process.exit(report.finish());
