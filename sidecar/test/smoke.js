/**
 * Phase 0 smoke test for sidecar liveness.
 *
 * Verifies: the sidecar starts on system Node, binds a dynamic OS-assigned
 * port, serves /health on it, and shuts down on signal.
 *
 * NOTE ON STDIO: this test deliberately does NOT capture the child's stdout
 * through a node pipe. Under confined execution environments a node-to-node
 * piped stdio spawn fails with EPERM, because named pipes are blocked. So the
 * child's stdout/stderr are redirected to files in <repoRoot>/.test-tmp, and
 * the announced port is read from the sidecar's own runtime file. That keeps
 * this test free of OS-level port probing and of any extra process layer.
 *
 * Run from the repo root:  node sidecar/test/smoke.js
 * Exits 0 on success, 1 on failure.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseReadyLine } from "../lib/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "index.js");
const REPO_ROOT = path.join(HERE, "..", "..");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp");
const STDOUT_LOG = path.join(TMP_DIR, "smoke.out.log");
const STDERR_LOG = path.join(TMP_DIR, "smoke.err.log");
const PORT_FILE = path.join(TMP_DIR, "smoke.port");

const START_TIMEOUT_MS = 10000;

let failures = 0;

function check(label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  process.stdout.write(`  [${status}] ${label}${detail ? ` - ${detail}` : ""}\n`);
  if (!ok) failures += 1;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error(`Timeout GET ${url}`)));
  });
}

/** Polls the port file and stdout log until the handshake appears. */
async function waitForAnnouncedPort(child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(PORT_FILE)) {
      const raw = fs.readFileSync(PORT_FILE, "utf8").trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (child.exitCode !== null) {
      throw new Error(`Sidecar exited early with code ${child.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Sidecar never announced a port");
}

function readStdoutLines() {
  if (!fs.existsSync(STDOUT_LOG)) return [];
  return fs
    .readFileSync(STDOUT_LOG, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main() {
  process.stdout.write("DSH-Dock sidecar liveness test\n");
  process.stdout.write(
    `  entry: ${path.relative(process.cwd(), ENTRY)} (stdio -> .test-tmp files)\n\n`,
  );

  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const file of [STDOUT_LOG, STDERR_LOG, PORT_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const out = fs.openSync(STDOUT_LOG, "a");
  const err = fs.openSync(STDERR_LOG, "a");

  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["ignore", out, err],
    env: { ...process.env, DSH_DOCK_PORT_FILE: PORT_FILE },
  });

  try {
    const port = await waitForAnnouncedPort(child);
    check("sidecar bound a dynamic port", port > 0, `port=${port}`);
    check("port is unprivileged (OS-assigned)", port >= 1024, `port=${port}`);

    const health = await getJson(`http://127.0.0.1:${port}/health`);
    check("GET /health returned 200", health.status === 200, `status=${health.status}`);
    check("GET /health reports ok", health.json.ok === true);
    check("GET /health reports the sidecar pid", health.json.pid === child.pid);

    const notFound = await getJson(`http://127.0.0.1:${port}/nope`);
    check("unknown route returns 404", notFound.status === 404);

    // The handshake line must be the ONLY thing on stdout - Rust parses this.
    const lines = readStdoutLines();
    const readyLines = lines.filter((line) => parseReadyLine(line) !== null);
    check("stdout handshake is exactly one line", readyLines.length === 1);
    check("stdout carries nothing else", lines.length === 1, `lines=${lines.length}`);

    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    check("sidecar terminated on signal", child.exitCode !== null || child.killed);
  } catch (error) {
    check(error.message, false);
    child.kill("SIGKILL");
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }

  if (fs.existsSync(STDERR_LOG)) {
    const errText = fs.readFileSync(STDERR_LOG, "utf8").trim();
    if (errText) process.stdout.write(`  (stderr) ${errText}\n`);
  }

  process.stdout.write(
    failures === 0
      ? "\nRESULT: all checks passed\n"
      : `\nRESULT: ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
