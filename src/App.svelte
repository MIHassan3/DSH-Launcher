<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  // Plain JS on purpose: the retry policy is the part worth testing, and this
  // keeps it runnable under `node` with no browser and no test framework.
  import { CONNECT_PHASE, connectToSidecar } from "./lib/sidecar-connection.js";

  // The launcher dashboard. All launcher logic lives in the Node sidecar; this
  // component only renders what the shell reports and calls commands.
  //
  // WHY invoke() AND NOT fetch(): a direct fetch to
  // http://127.0.0.1:<sidecar-port>/harness/status would require CORS headers on
  // the sidecar and would bypass Tauri's capability system. The three commands
  // proxy that traffic instead (Phase 1 decision).

  /** Mirrors sidecar/lib/control.js's status payload. */
  interface HarnessStatus {
    status: "stopped" | "starting" | "running" | "error";
    version: string | null;
    url: string | null;
    pid: number | null;
    startedAt: string | null;
    instanceId: string | null;
    logFile: string | null;
    launcherLog: string | null;
    lastError: string | null;
    message: string | null;
  }

  /** Mirrors the shell's ProxiedResponse. */
  interface ProxiedResponse {
    code: number;
    data: HarnessStatus | null;
    error: string | null;
    /**
     * The shell's own startup failure, when the sidecar never came up
     * (for example: "Could not find sidecar/index.js. Searched, starting from
     * the running executable: ...").
     *
     * This is the CAUSE; `error` is only the symptom ("no port yet"). Showing
     * the generic message instead of this one is what made a release-build
     * failure take far longer to diagnose than it should have.
     */
    shellError: string | null;
  }

  const POLL_MS = 500;

  let status: HarnessStatus | null = null;
  let shellError: string | null = null;
  let shellErrorDetail: string | null = null;
  let busy = false;
  let harnessWindowOpen = false;
  let elapsed = 0;
  /** True only during the first-load handshake, before any error is warranted. */
  let connecting = true;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Normalizes a shell response into either a status or a visible error.
   *
   * `shellError` wins. When the sidecar never started, every proxied call
   * fails, and the shell's startup error is the only actionable text available
   * - the per-call message is just a symptom of it.
   */
  function readResponse(response: ProxiedResponse): HarnessStatus | null {
    if (response.shellError) {
      shellError = response.error ?? "The DSH-Dock core could not be started.";
      shellErrorDetail = response.shellError;
      return null;
    }
    if (response.error) {
      shellError = response.error;
      shellErrorDetail = null;
      return null;
    }
    shellError = null;
    shellErrorDetail = null;
    return response.data;
  }

  function stopTimers() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /**
   * Polls while a start is in flight.
   *
   * A cold first boot can take minutes, so the UI shows elapsed time rather than
   * an unexplained spinner. Polling stops as soon as the state is terminal.
   */
  function startPolling() {
    if (pollTimer !== null) return;
    const startedAt = Date.now();
    elapsed = 0;
    tickTimer = setInterval(() => {
      elapsed = Math.round((Date.now() - startedAt) / 1000);
    }, 1000);
    pollTimer = setInterval(() => {
      void refresh();
    }, POLL_MS);
  }

  async function refresh() {
    try {
      const response = await invoke<ProxiedResponse>("harness_status");
      const next = readResponse(response);
      if (next === null) return;
      status = next;

      if (next.status === "starting") {
        startPolling();
      } else {
        stopTimers();
        // A stop closes the harness window from the shell side, so mirror that.
        if (next.status !== "running") harnessWindowOpen = false;
      }
    } catch (error) {
      shellError = String(error);
      stopTimers();
    }
  }

  /**
   * First load: the sidecar's stdout handshake is parsed by a Rust thread, so a
   * `harness_status` call can legitimately arrive a moment before the port is
   * known. Rendering an error for that half-second looked like a failure on
   * every cold start.
   *
   * The policy lives in `lib/sidecar-connection.js` so it is unit-testable:
   * retry for up to 2s while showing a neutral "connecting" state, surface an
   * error only once the budget is spent, and never retry a real shell failure.
   */
  async function initialRefresh() {
    connecting = true;
    try {
      const outcome = await connectToSidecar({
        attempt: async () => {
          const response = await invoke<ProxiedResponse>("harness_status");
          return {
            // A response that is not a usable status must not count as ready.
            data: response.shellError || response.error ? null : (response.data ?? null),
            error: response.error,
            shellError: response.shellError,
          };
        },
      });

      if (outcome.phase === CONNECT_PHASE.READY && outcome.status) {
        status = outcome.status as HarnessStatus;
        if (status.status === "starting") startPolling();
        return;
      }

      // Budget spent, or a final failure: now it is a real error.
      shellError = outcome.message;
      shellErrorDetail = null;
    } catch (error) {
      shellError = String(error);
      shellErrorDetail = null;
    } finally {
      connecting = false;
    }
  }

  async function startHarness() {
    if (busy) return;
    busy = true;
    shellError = null;
    shellErrorDetail = null;
    try {
      const response = await invoke<ProxiedResponse>("harness_start");
      const next = readResponse(response);
      if (next !== null) {
        status = next;
        if (next.status === "starting") startPolling();
      }
      // Poll regardless: a 202 may arrive before the first status read.
      startPolling();
    } catch (error) {
      shellError = String(error);
    } finally {
      busy = false;
    }
  }

  async function stopHarness() {
    if (busy) return;
    busy = true;
    try {
      const response = await invoke<ProxiedResponse>("harness_stop");
      const next = readResponse(response);
      if (next !== null) status = next;
      harnessWindowOpen = false;
    } catch (error) {
      shellError = String(error);
    } finally {
      stopTimers();
      busy = false;
      void refresh();
    }
  }

  async function openHarness() {
    const url = status?.url;
    if (!url) return;
    try {
      await invoke("open_harness_window", { url });
      harnessWindowOpen = true;
    } catch (error) {
      shellError = String(error);
    }
  }

  async function closeHarness() {
    try {
      await invoke("close_harness_window");
      harnessWindowOpen = false;
    } catch (error) {
      shellError = String(error);
    }
  }

  onMount(() => {
    void initialRefresh();
    return stopTimers;
  });

  function formatStartedAt(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }
</script>

<main>
  <header>
    <h1>DSH-Dock</h1>
    <p class="tagline">Your launchpad for the DeepSeek Harness.</p>
  </header>

  <section class="card">
    <div class="row">
      <h2>Harness</h2>
      {#if connecting}
        <!-- Neutral while the sidecar's handshake lands. Deliberately NOT an
             error: this state is normal for the first fraction of a second, and
             showing red here is the flash this replaced. -->
        <span class="badge connecting">connecting</span>
      {:else if status}
        <span class="badge {status.status}">{status.status}</span>
      {:else}
        <span class="badge unknown">unknown</span>
      {/if}
    </div>

    {#if connecting}
      <p class="note">Connecting to the DSH-Dock core…</p>
    {/if}

    <dl>
      <dt>Version</dt>
      <dd>{status?.version ?? "—"}</dd>

      <dt>Process</dt>
      <dd class="mono">{status?.pid ?? "—"}</dd>

      <dt>Port URL</dt>
      <dd class="mono url">{status?.url ?? "—"}</dd>

      <dt>Started</dt>
      <dd>{formatStartedAt(status?.startedAt ?? null)}</dd>
    </dl>

    {#if !connecting && status?.message}
      <p class="note">{status.message}</p>
    {/if}

    {#if status?.status === "starting"}
      <p class="note progress">
        Booting… {elapsed}s elapsed. The first run builds the harness plugin tree,
        which can take a few minutes.
      </p>
    {/if}

    {#if status?.status === "error"}
      <!-- Recoverable by design: a transient probe failure should offer Retry,
           not an alarm. The text below is the sidecar's own diagnostic. -->
      <details class="error" open>
        <summary>Harness error — this is usually recoverable</summary>
        <pre>{status.lastError ?? status.message ?? "Unknown error"}</pre>
      </details>
    {/if}

    {#if shellError}
      <details class="error" open>
        <summary>Shell error</summary>
        <p class="error-lead">{shellError}</p>
        {#if shellErrorDetail}
          <!-- The real cause. Without this the panel showed only the generic
               "no port yet" symptom of a startup failure. -->
          <pre>{shellErrorDetail}</pre>
        {/if}
      </details>
    {/if}

    <div class="actions">
      {#if status?.status === "running"}
        <button class="primary" onclick={openHarness}>Open Harness</button>
        {#if harnessWindowOpen}
          <button onclick={closeHarness}>Close Harness Window</button>
        {/if}
        <button class="danger" onclick={stopHarness} disabled={busy}>Stop Harness</button>
      {:else if status?.status === "starting"}
        <button disabled>Starting…</button>
      {:else if status?.status === "error"}
        <button class="primary" onclick={startHarness} disabled={busy}>Retry</button>
        <button class="danger" onclick={stopHarness} disabled={busy}>Stop Harness</button>
      {:else}
        <button class="primary" onclick={startHarness} disabled={busy}>Start Harness</button>
      {/if}
      <button onclick={refresh} disabled={busy}>Refresh</button>
    </div>
  </section>

  <footer>
    <span class="dot"></span>
    Closing this window leaves the harness running.
  </footer>
</main>

<style>
  main {
    max-width: 46rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  .tagline {
    margin: 0.25rem 0 0;
    color: var(--dsh-accent);
    font-size: 0.95rem;
  }

  .card {
    margin-top: 2rem;
    padding: 1.5rem;
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 0.75rem;
    background: rgb(255 255 255 / 0.03);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgb(240 240 240 / 0.55);
  }

  .badge {
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: rgb(255 255 255 / 0.08);
  }

  .badge.connecting {
    background: rgb(255 255 255 / 0.06);
    color: rgb(240 240 240 / 0.7);
  }

  .badge.running {
    background: rgb(0 180 216 / 0.18);
    color: var(--dsh-accent);
  }

  .badge.starting {
    background: rgb(255 200 0 / 0.16);
    color: #ffc800;
  }

  .badge.error {
    background: rgb(255 90 90 / 0.16);
    color: #ff8a8a;
  }

  dl {
    display: grid;
    grid-template-columns: 9rem 1fr;
    gap: 0.5rem 1rem;
    margin: 1rem 0 0;
  }

  dt {
    color: rgb(240 240 240 / 0.55);
  }

  dd {
    margin: 0;
    word-break: break-all;
  }

  .mono {
    font-family: ui-monospace, Consolas, monospace;
  }

  .url {
    font-size: 0.85rem;
    color: rgb(240 240 240 / 0.8);
  }

  .note {
    margin: 1rem 0 0;
    font-size: 0.85rem;
    color: rgb(240 240 240 / 0.6);
  }

  .progress {
    color: var(--dsh-accent);
  }

  .error {
    margin: 1rem 0 0;
    padding: 0.75rem;
    border: 1px solid rgb(255 90 90 / 0.3);
    border-radius: 0.5rem;
    background: rgb(255 90 90 / 0.06);
  }

  .error summary {
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
    color: #ff8a8a;
  }

  .error pre {
    margin: 0.75rem 0 0;
    max-height: 16rem;
    overflow: auto;
    font-size: 0.75rem;
    line-height: 1.45;
    white-space: pre-wrap;
    color: rgb(240 240 240 / 0.8);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  button {
    padding: 0.5rem 1rem;
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 0.5rem;
    background: rgb(255 255 255 / 0.05);
    color: var(--dsh-text, #f0f0f0);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.1);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button.primary {
    border-color: transparent;
    background: var(--dsh-primary);
    font-weight: 600;
  }

  button.primary:hover:not(:disabled) {
    background: #2a4d78;
  }

  button.danger {
    border-color: rgb(255 90 90 / 0.3);
    color: #ff8a8a;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 2rem;
    font-size: 0.8rem;
    color: rgb(240 240 240 / 0.45);
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--dsh-primary);
  }
</style>
