import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// DSH-Dock frontend build.
//
// Layout note (see docs/PROJECT_DSH-DOCK.md section 5): frontend SOURCE lives in
// `src/`, but Vite emits BUILD OUTPUT to `dist/` at the repo root. Tauri's
// `frontendDist` must point at built assets, never at source, so this split is
// deliberate: `root: "src"` + `outDir: "../dist"`.
//
// `server.port` is pinned to 1420 to match `build.devUrl` in
// src-tauri/tauri.conf.json. `strictPort` fails loudly instead of silently
// drifting to another port, which would leave the Tauri window pointed at
// nothing.
//
// IMPORTANT: the port and host below must match `build.devUrl` in
// src-tauri/tauri.conf.json exactly.
// Do NOT use "localhost": Vite resolves it as IPv6 [::1] on Windows while
// WebView2 resolves it as IPv4 127.0.0.1, causing a blank window (and a
// confusing "port already in use" on the next start once the IPv6 listener is
// orphaned). Both sides are pinned to the literal IPv4 address 127.0.0.1.
//
// `strictPort` is intentional: drifting to another port would leave the Tauri
// window pointed at nothing, so a port conflict must fail loudly instead.
//
// Note: `Get-NetTCPConnection -LocalPort` does NOT report an IPv6-only
// listener. When checking whether this port is free, use `netstat -ano` or a
// real connect attempt.
export default defineConfig({
  root: "src",
  plugins: [svelte()],
  clearScreen: false,
  server: {
    // IMPORTANT: must match tauri.conf.json devUrl exactly. See note above.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2021",
  },
});
