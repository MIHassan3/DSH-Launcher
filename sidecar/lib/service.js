/**
 * Sidecar HTTP service.
 *
 * Phase 0 scope is deliberately minimal: bind a dynamic port (port 0, letting
 * the OS assign a free one) and expose a liveness endpoint.
 *
 * Why port 0 (docs/PROJECT_DSH-DOCK.md section 2.2): it eliminates port
 * conflicts entirely, including against a user's own `dsh web` instance.
 *
 * Phase 1 mounts the real request/response control surface here. This module
 * is the seam for that; it should not grow launcher logic itself.
 */

import http from "node:http";

import { createHarnessControl } from "./control.js";

export const DEFAULT_HOST = "127.0.0.1";

/**
 * Starts the sidecar HTTP service.
 *
 * Resolves only once the socket is genuinely listening, so the port returned
 * is guaranteed bindable - the handshake must never announce a dead port.
 *
 * @param {{host?: string, port?: number}} [options]
 */
export function startService(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  // 0 => OS assigns a free port. Never hardcode a port.
  const requestedPort = options.port ?? 0;

  // One control instance per server, so the in-flight-start lock is scoped to
  // this sidecar and cannot be shared across servers by accident.
  const control = options.control ?? createHarnessControl(options.controlOptions ?? {});

  const server = http.createServer(createRequestHandler(control));
  // Responses are small JSON payloads; Nagle only adds latency here.
  server.keepAliveTimeout = 5000;

  return new Promise((resolve, reject) => {
    let disposed = false;

    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Sidecar: expected a TCP address after listen()"));
        return;
      }

      resolve({
        host,
        port: address.port,
        server,
        /** The lifecycle control surface, exposed for tests and diagnostics. */
        control,

        /** Graceful shutdown. Idempotent. */
        dispose() {
          if (disposed) return Promise.resolve();
          disposed = true;
          // Wait out any in-flight start FIRST. Closing the server while a
          // spawn is still settling would abandon a harness mid-boot: it would
          // be running with no state file recorded, i.e. an orphan on the next
          // launch. `settled()` never rejects.
          return Promise.resolve()
            .then(() => control?.settled?.())
            .catch(() => {})
            .then(
              () =>
                new Promise((resolveClose) => {
                  server.close(() => resolveClose());
                }),
            );
        },
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });
}

function createRequestHandler(control) {
  return (req, res) => {
    // `/health` is sidecar liveness, not harness status. Keep its shape stable.
    if (req.method === "GET" && req.url === "/health") {
      // Logged to stderr, never stdout: stdout must carry only the handshake.
      // This is also a useful proof that the shell can reach the announced port
      // from outside the Node process.
      process.stderr.write(
        `[sidecar] shell connected from ${req.socket.remoteAddress ?? "unknown"}\n`,
      );
      sendJson(res, 200, {
        ok: true,
        service: "dsh-dock-sidecar",
        pid: process.pid,
        node: process.version,
      });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? "/", `http://${DEFAULT_HOST}`).pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: "bad_request" });
      return;
    }

    if (control === null || control === undefined) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    // Control routes are async (a status reads state and probes a URL; a start
    // spawns in the background). Errors must never escape as an unhandled
    // rejection or a hung socket.
    Promise.resolve()
      .then(() => control.handle(req.method, pathname))
      .then((result) => {
        if (result === null || result === undefined) {
          sendJson(res, 404, { ok: false, error: "not_found", path: pathname });
          return;
        }
        sendJson(res, result.code, result.payload);
      })
      .catch((error) => {
        // A thrown error is a first-class response (no swallowed errors). The
        // control layer already attaches log tails to its own failures; this
        // catch covers anything that escaped it.
        process.stderr.write(`[sidecar] control route ${pathname} threw: ${error.message}\n`);
        sendJson(res, 500, {
          status: "error",
          message: error.message,
          lastError: error.message,
        });
      });
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Local-only service; never cache control responses.
    "cache-control": "no-store",
  });
  res.end(body);
}
