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

  const server = http.createServer(handleRequest);
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

        /** Graceful shutdown. Idempotent. */
        dispose() {
          if (disposed) return Promise.resolve();
          disposed = true;
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });
}

function handleRequest(req, res) {
  // Phase 0 has exactly one endpoint. Phase 1 adds the control surface.
  if (req.method === "GET" && req.url === "/health") {
    // Logged to stderr, never stdout: stdout must carry only the handshake.
    // This is also a useful Phase 0 proof that the shell can reach the
    // announced port from outside the Node process.
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

  sendJson(res, 404, { ok: false, error: "not_found" });
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
