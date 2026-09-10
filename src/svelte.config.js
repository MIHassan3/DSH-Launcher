import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Minimal Svelte config. Deliberately no `extensions`, no adapter, and no
// SvelteKit - DSH-Dock is a plain Svelte + Vite app embedded in a Tauri
// webview. The preprocess hook exists so TypeScript inside <script lang="ts">
// is handled explicitly rather than by plugin default.
//
// This file MUST live in `src/`, not at the repo root. vite-plugin-svelte
// locates the config relative to Vite's `root`, which is `src/`
// (see vite.config.ts), so a root-level config is silently ignored and the
// plugin logs "no Svelte config found". The import above is a module
// resolution, not a relative path, so its location does not affect the import.
export default {
  preprocess: vitePreprocess(),
};
