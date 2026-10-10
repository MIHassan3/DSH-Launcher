<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  // Plain JS on purpose: the retry policy is the part worth testing, and this
  // keeps it runnable under `node` with no browser and no test framework.
  import { CONNECT_PHASE, connectToSidecar } from "./lib/sidecar-connection.js";
  // The cadence decisions live in a plain-JS module so they can be tested under
  // `node`: both Phase 2B stale-state bugs were in WHEN to poll, not in the polling.
  import { HARNESS_ACTIVE_POLL_MS, harnessPollMs } from "./lib/version-refresh.js";
  import Welcome from "./lib/Welcome.svelte";
  // The minimal version manager (Phase 2B). It owns its own data fetching, because
  // the version library changes on a different cadence from the harness status: a
  // job's progress is polled at 500ms while work runs and NOT AT ALL when idle, and
  // the registry listing is fetched on mount and after a job finishes. Folding that
  // into this component's status loop would poll the registry forever.
  import VersionManager from "./lib/VersionManager.svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  // The launcher dashboard. All launcher logic lives in the Node sidecar; this
  // component only renders what the shell reports and calls commands.
  //
  // WHY invoke() AND NOT fetch(): a direct fetch to
  // http://127.0.0.1:<sidecar-port>/harness/status would require CORS headers on
  // the sidecar and would bypass Tauri's capability system. The three commands
  // proxy that traffic instead (Phase 1 decision).
  //
  // TWO WINDOWS, ONE BUNDLE. `main.ts` mounts this one component tree for every
  // window, so the label decides what renders. The first-run wizard window is
  // granted exactly ONE command (`capabilities/welcome.json`), so the dashboard's
  // calls must not run there: `onMount` returns before it does anything when the
  // label is not `main`, and the markup below renders `Welcome` instead.
  const WINDOW_LABEL = getCurrentWindow().label;
  const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

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


  let status: HarnessStatus | null = null;
  let shellError: string | null = null;
  let shellErrorDetail: string | null = null;
  let busy = false;
  let harnessWindowOpen = false;
  let elapsed = 0;
  /** True only during the first-load handshake, before any error is warranted. */
  let connecting = true;
  /**
   * True while "Install and Open Harness" is waiting for a boot to finish.
   *
   * Set by `installAndOpen()` and honoured by `refresh()`, which opens the harness
   * window the moment the status reaches `running`. This is what makes the wizard's
   * button OPEN the harness rather than merely start it - a cold first install takes
   * minutes, so a one-shot "start, then open" would open a window at a URL the
   * harness was not serving yet.
   */
  let pendingOpen = false;

  /**
   * A message the shell asked the dashboard to show, from `panel:open`.
   *
   * The switch outcome arrives this way (Q74/Q80). It is rendered beside the version
   * manager rather than in the harness card, because it is a VERSION operation's
   * result and that is where the user was looking.
   */
  let panelMessage: string | null = null;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /** The cadence the current `pollTimer` runs at, so a switch can detect a change. */
  let pollIntervalMs = 0;

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
   * Stops only the elapsed-seconds ticker. The status poll keeps running.
   *
   * The two timers have DIFFERENT lifetimes and were once conflated: the ticker only
   * means anything while a boot is in flight, while the poll is the only way this
   * window can learn the harness changed.
   */
  function stopTicker() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /**
   * Polls the harness status, fast while a boot is in flight and slowly otherwise.
   *
   * THE POLL NEVER STOPS, AND THAT IS THE PHASE 2B FIX. It used to run ONLY while the
   * status was `starting`, and every other path called `stopTimers()` - so once the
   * harness was up, nothing read the status again until the user pressed Refresh or
   * clicked a button. Two things then left this card showing a stale harness:
   *
   *   * the VERSION MANAGER switching versions - it calls `versions_switch` and
   *     tracks the job on its own, so this window was never told;
   *   * the MENU'S Switch/Stop, which deliberately goes straight to the sidecar (Q74).
   *
   * The reported symptom was exactly that: after a switch the card still showed the
   * old version and an "Open Harness" button pointing at the DEAD URL the previous
   * harness had served, so clicking it produced a loading error; pressing Refresh
   * corrected everything at once. A dashboard whose whole job is to report state must
   * poll for state it did not cause.
   *
   * 500 ms while `starting` (so elapsed time and the arrival of a URL are prompt),
   * 5 s otherwise (a cheap loopback read, and the only way to notice a change made
   * anywhere else).
   *
   * The choice itself is `harnessPollMs` in `src/lib/version-refresh.js`, which is
   * unit-tested - the bug was in that decision, not in `setInterval`.
   */
  function startPolling(statusForCadence: string | null = null) {
    const interval = harnessPollMs(statusForCadence);

    // Elapsed seconds only matter during a boot.
    if (interval === HARNESS_ACTIVE_POLL_MS) {
      if (tickTimer === null) {
        const startedAt = Date.now();
        elapsed = 0;
        tickTimer = setInterval(() => {
          elapsed = Math.round((Date.now() - startedAt) / 1000);
        }, 1000);
      }
    } else {
      stopTicker();
      elapsed = 0;
    }

    // Already polling at the right cadence? Nothing to change.
    if (pollTimer !== null && pollIntervalMs === interval) return;

    if (pollTimer !== null) clearInterval(pollTimer);
    pollIntervalMs = interval;
    pollTimer = setInterval(() => {
      void refresh();
    }, interval);
  }

  async function refresh() {
    try {
      const response = await invoke<ProxiedResponse>("harness_status");
      const next = readResponse(response);
      if (next === null) return;
      status = next;

      // Fast while booting, slow otherwise - but NEVER stopped. See `startPolling`.
      startPolling(next.status);

      // A stop closes the harness window from the shell side, so mirror that. A
      // SWITCH also replaces the URL, and the card must follow it: `status` above
      // already carries the new one, which is what makes "Open Harness" correct again
      // without the user pressing Refresh.
      if (next.status !== "running") harnessWindowOpen = false;

      // The wizard's hand-off: "Install and Open Harness" is not finished until
      // the harness window is actually showing, and that cannot happen until the
      // harness reports a URL.
      if (pendingOpen && next.status === "running") {
        pendingOpen = false;
        await openHarness();
      }
    } catch (error) {
      shellError = String(error);
      // Still poll: a transient shell hiccup must not leave the card frozen until a
      // manual Refresh. `initialRefresh` owns the decision to SHOW an error.
      startPolling(status?.status);
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
        // A dashboard whose job is to report state must poll for state it did not
        // cause, so the poll starts here and only changes cadence afterwards.
        startPolling(status.status);
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
      if (next !== null) status = next;
      // Poll fast: a start is in flight, so the card should follow it promptly.
      startPolling("starting");
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
      // The ticker stops (no boot is in flight) but the POLL does not - `refresh`
      // below re-establishes it at the idle cadence.
      stopTicker();
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

  /**
   * Stop, then start.
   *
   * Deliberately the same two calls the buttons make, in the same order, rather
   * than a separate restart route: the sidecar's own `/harness/restart` is
   * literally `stop()` then `start()`, so this keeps ONE implementation of each
   * half and inherits the state handling `stopHarness` and `startHarness` already
   * do (closing the harness window, stopping the timers, resuming polling).
   */
  async function restartHarness() {
    await stopHarness();
    await startHarness();
  }

  /**
   * The native menu's actions arrive here.
   *
   * THE POINT OF THIS LISTENER: the menu used to call the sidecar itself, so a
   * menu "Stop Harness" stopped the harness while this window went on showing it
   * as running. The menu now sends an intent and this function routes it to the
   * very same handlers the buttons call, so there is one implementation of each
   * action with two entry points.
   */
  function runMenuAction(action: string) {
    switch (action) {
      case "start":
        void startHarness();
        break;
      case "stop":
        void stopHarness();
        break;
      case "restart":
        void restartHarness();
        break;
      case "refresh":
        void refresh();
        break;
      case "open-logs":
        // Nothing to do: the shell reveals the folder itself, because there is
        // no dashboard state involved. The event is still sent so that every
        // menu action travels the same channel.
        break;
      default:
        // An unknown action means the shell and this file disagree; the shell
        // logs clicks, so silence here is not the only trace.
        break;
    }
  }

  /**
   * The first-run wizard's hand-off: install the harness, then open it.
   *
   * WHY THIS IS NOT A SECOND IMPLEMENTATION OF "START": it routes to the same
   * `startHarness` the button uses, and the opening is done by `refresh`, which is
   * already the one place that knows the harness's status. The only new fact is
   * `pendingOpen`.
   *
   * THE THREE CASES (approved design, C2):
   *   running  -> open now; there is nothing to install
   *   starting -> wait; `refresh` opens it when the boot finishes
   *   stopped  -> start, then wait
   *
   * The `refresh()` first is deliberate: the shell delivers this event when the
   * dashboard can receive it, which can be several seconds after the harness state
   * last changed. Acting on a stale local `status` could start a harness that is
   * already running.
   */
  async function installAndOpen() {
    await refresh();

    if (status?.status === "running") {
      await openHarness();
      return;
    }

    if (status?.status !== "starting") {
      pendingOpen = true;
      await startHarness();
      return;
    }

    // Already booting - most likely adopted from a previous session, or started by
    // the menu. Just wait for it.
    pendingOpen = true;
    startPolling("starting");
  }

  onMount(() => {
    // THE WIZARD WINDOW MUST NOT RUN ANY OF THIS. `capabilities/welcome.json`
    // grants the `welcome` window exactly one command, so an `invoke` from here
    // would be rejected - and a rejected call on a first run is a bad first
    // impression, not a diagnosable error. Returning before anything is scheduled
    // is what keeps the two windows honest.
    if (!IS_MAIN_WINDOW) return;

    void initialRefresh();

    const menuActions = listen<{ action?: string }>("menu:action", (event) => {
      runMenuAction(event.payload?.action ?? "");
    });

    /**
     * The wizard's hand-off. Delivered by the shell once this page can receive it,
     * with `{ channel, dismissed }`.
     *
     * The payload is currently informational - the channel is already in
     * `settings.json` by the time this arrives, and the install follows the
     * settings, not this event. It is logged through the same channel as every
     * other launcher event so a first run is followable from the console.
     */
    const installAndOpenEvent = listen<{ channel?: string; dismissed?: boolean }>(
      "install-and-open",
      () => {
        void installAndOpen();
      },
    );

    /**
     * The shell's `panel:open` event: which section to reveal, and why.
     *
     * `Show all versions…` (Q78) and the switch outcome both arrive here. The shell
     * keeps NO notion of a version section - it emits a tab name and this dashboard
     * decides what that means - which is why Phase 3 can add real tabs without
     * touching the menu.
     *
     * `message` is shown when present. It carries the switch outcome, including the
     * Q80 error text for a failed switch, so a switch started from the menu reports
     * back even when this window was closed at the time: the shell opens this window
     * and delivers the message with it.
     */
    const panelOpen = listen<{ tab?: string; message?: string | null }>("panel:open", (event) => {
      if (event.payload?.tab === "versions") {
        const target = document.getElementById("versions");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      const message = event.payload?.message;
      if (message) panelMessage = message;
    });

    return () => {
      // Unmount is the ONE place both timers stop. Every other path keeps the poll
      // alive, because a stopped poll is a card that shows a stale harness.
      stopTimers();
      void menuActions.then((unlisten) => unlisten());
      void installAndOpenEvent.then((unlisten) => unlisten());
      void panelOpen.then((unlisten) => unlisten());
    };
  });

  /**
   * The version manager's report that a switch SUCCEEDED.
   *
   * A plain callback prop rather than an event or a store: the child is rendered
   * directly by this component, there is exactly one listener, and the payload is
   * nothing. The steady poll below would correct the Harness card within 5 s anyway;
   * this makes it immediate for a switch the user just clicked and is watching.
   *
   * The MENU's switch does not come through here - it goes straight to the sidecar
   * (Q74) - which is precisely why the steady poll exists as well. Two mechanisms,
   * because they cover two different origins.
   */
  function onSwitchComplete() {
    void refresh();
  }

  function formatStartedAt(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }
</script>

<!-- One bundle, two windows. The wizard's window renders the wizard and nothing
     else; every other window renders the dashboard. -->
{#if !IS_MAIN_WINDOW}
  <Welcome />
{:else}
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

    <!-- Version manager (Phase 2B). Its own card, with its own fetches: see the
         import comment for why its polling is not folded into the status loop. -->
    {#if panelMessage}
      <!-- The shell's message for a version operation it performed itself - today
           only a menu switch (Q74). Dismissible, because it is a report and not a
           state the dashboard can re-derive. -->
      <p class="note panel-message">
        {panelMessage}
        <button class="dismiss" onclick={() => (panelMessage = null)}>Dismiss</button>
      </p>
    {/if}
    <VersionManager onSwitchComplete={onSwitchComplete} />

  <footer>
    <span class="dot"></span>
    Closing this window leaves the harness running.
  </footer>
</main>
{/if}

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

  .panel-message {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-top: 1.5rem;
    padding: 0.75rem;
    border: 1px solid rgb(0 180 216 / 0.3);
    border-radius: 0.5rem;
    background: rgb(0 180 216 / 0.06);
    color: var(--dsh-text, #f0f0f0);
  }

  .dismiss {
    flex: 0 0 auto;
    padding: 0.15rem 0.6rem;
    font-size: 0.75rem;
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
