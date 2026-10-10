<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  // The cadence decisions live in plain JS so they can be tested under `node`: the
  // stale-"Running"-badge bug was in WHEN to poll, not in the polling.
  import {
    VERSIONS_ACTIVE_POLL_MS,
    VERSIONS_IDLE_POLL_MS,
    jobCompletion,
    versionsPollMs,
  } from "./version-refresh.js";

  /**
   * Told when a switch SUCCEEDS, so the dashboard's Harness card can refresh at once.
   *
   * The steady poll would catch it within 5 s; a user who just clicked Switch is
   * watching, so 5 s reads as "it did not work".
   */
  interface Props {
    onSwitchComplete?: () => void;
  }
  let { onSwitchComplete }: Props = $props();

  // The minimal Version Manager (docs/PROJECT_DSH-DOCK.md section 3.4's Phase 3
  // table is NOT this; section 8.1's "moved to 2B" list is).
  //
  // WHAT IT DOES: browse installed and available versions, download, switch, delete.
  // Four actions, nothing else - no channel pinning, no update preferences, no
  // storage policy. Those are Phase 3 and 2C.
  //
  // HOW IT TALKS TO THE SIDECAR: through Tauri commands, never HTTP. A direct fetch
  // would need CORS on the sidecar and would bypass the capability system, which is
  // why the shell proxies every call (Q73). Six commands are used:
  //
  //   versions_list       GET  /versions/status          the installed list + job
  //   versions_progress   GET  /versions/progress        the job, while one runs
  //   versions_download   POST /registry/download/<v>    install a version
  //   versions_switch     POST /versions/switch?version= start a version
  //   versions_delete     POST /library/delete?version=  remove a version
  //   versions_available  GET  /registry/versions        what could be installed
  //
  // The sixth is a DEVIATION, reported at PAUSE 6: the phase brief asks this section
  // to list AVAILABLE versions, and the five commands from 7a cannot reach the
  // registry listing. It is read-only and additive.

  /** Mirrors one entry of `recentVersions` in `control.js`'s status payload. */
  interface LibraryEntry {
    version: string;
    state: "installed" | "partial" | "absent";
    installedAt: string | null;
  }

  /** Mirrors `version-jobs.js`'s `progress()` shape. */
  interface JobProgress {
    busy: boolean;
    id: string | null;
    kind: "download" | "switch" | null;
    version: string | null;
    phase: "resolving" | "downloading" | "linking" | "validating" | null;
    message: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    elapsedMs: number | null;
    job: {
      ok: boolean | null;
      reason: string | null;
      error: string | null;
      finishedAt: string | null;
    };
  }

  /** One entry of `version-jobs.js`'s `available()` listing. */
  interface AvailableEntry {
    version: string;
    channel: string;
    distTag: string | null;
    installed: boolean;
    state: string;
    hasIncompleteMarker: boolean;
    belowMinimum: boolean;
    publishedAt: string | null;
  }

  /** The `/versions/status` projection, as `versions_list` returns it. */
  interface VersionsStatus {
    progress: JobProgress;
    library: LibraryEntry[];
    running: string | null;
    minimumSupported: string;
  }

  interface AvailablePayload {
    versions: AvailableEntry[];
    total: number;
    truncated: boolean;
    limit: number;
    minimumSupported: string;
    channelTags: { stable: string | null; rc: string | null; alpha: string | null };
    fromCache: boolean;
  }

  /** Mirrors the shell's `ProxiedResponse`. */
  interface ProxiedResponse {
    code: number;
    data: unknown;
    error: string | null;
    shellError: string | null;
  }

  /**
   * How often the progress route is polled WHILE A JOB IS RUNNING.
   *
   * 500 ms, matching the dashboard's existing harness poll, because the two run
   * side by side and a different cadence would only make the screen update in two
   * visible rhythms. A job's phases are minutes apart, so this is far more often
   * than strictly needed - it is chosen so the phase change appears promptly rather
   * than up to a second late.
   *
   * THE POLL STOPS THE MOMENT NOTHING IS BUSY, and that is the part that matters:
   * `versions_progress` is a loopback HTTP call through the shell, so polling it
   * forever would be a permanent cost for a screen that is usually idle. Idle cost
   * is one `versions_list` per mount, plus the dashboard's own 5s harness tick.
   */
  const PROGRESS_POLL_MS = VERSIONS_ACTIVE_POLL_MS;

  /**
   * How often the version state is re-read when nothing is running, in ms.
   *
   * THIS IS THE PHASE 2B FIX FOR THE STALE "Running" BADGE, AND ITS ABSENCE WAS A
   * REAL BUG. The poll used to start only when this component set `busy` - from its
   * OWN click, or from a `busy: true` it happened to see. A switch started from the
   * MENU (Q74) never touches either, so the component never polled, never saw the
   * job, and never re-read the library: the Running badge stayed on the previous
   * version until the user pressed Refresh. The claim that "a component that only
   * polled after its own clicks would show nothing for a menu-initiated switch" was
   * correct about the DESIRED behaviour and wrong about the implementation.
   *
   * 5 s, matching the dashboard's idle harness poll: `/versions/status` is a cheap
   * loopback read of an in-memory job plus a memoized (1 s) library enumeration.
   */
  const IDLE_POLL_MS = VERSIONS_IDLE_POLL_MS;

  /**
   * The four phases, in order, for the indicator.
   *
   * The names come from the sidecar; the ORDER is presentation and lives here. The
   * sidecar never reports a phase it does not mean, so this is a progress bar over a
   * known sequence, not a guess about how far along something is.
   */
  const PHASES = ["resolving", "downloading", "linking", "validating"] as const;

  /** Human labels for the phases, so the UI does not invent wording. */
  const PHASE_LABELS: Record<string, string> = {
    resolving: "Resolving",
    downloading: "Downloading",
    linking: "Linking",
    validating: "Validating",
  };

  /** A short badge for a library state. */
  function stateLabel(state: string): string {
    return state === "installed" ? "installed" : state === "partial" ? "partial" : "absent";
  }

  function formatWhen(value: string | null): string {
    if (!value) return "unknown date";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  function formatElapsed(ms: number | null): string {
    if (ms === null) return "";
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  /**
   * The same version comparison the sidecar uses, kept tiny and local.
   *
   * It exists for ONE badge (`belowMinimum` on an installed row) and is deliberately
   * not a dependency: `sidecar/lib/version-jobs.js` owns the authoritative
   * `compareVersions`, and this copy only has to agree with it on real version
   * strings. Numeric components compare as numbers, and a pre-release sorts below
   * its own release - the two rules that matter for a minimum-version check.
   */
  function compare(left: string, right: string): number {
    const parse = (value: string) => {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value);
      return match
        ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
        : null;
    };
    const a = parse(left);
    const b = parse(right);
    // Unparseable returns 0 ("equal"), matching the sidecar: the consequence is "not
    // below the minimum", and badging an unrecognised version as unsupported would be
    // a claim made without evidence.
    if (a === null || b === null) return 0;
    for (let index = 0; index < 3; index += 1) {
      if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
    }
    if (a.pre === b.pre) return 0;
    if (a.pre === null) return 1;
    if (b.pre === null) return -1;
    return a.pre < b.pre ? -1 : 1;
  }

  let status = $state<VersionsStatus | null>(null);
  let available = $state<AvailablePayload | null>(null);
  let loadError = $state<string | null>(null);
  let availableError = $state<string | null>(null);
  let loadingAvailable = $state(false);
  /** Version currently being acted on, so each row can show its own busy state. */
  let busyVersion = $state<string | null>(null);
  /** The last completed job, so its outcome survives a reload of the list. */
  let lastOutcome = $state<JobProgress["job"] | null>(null);
  /**
   * `finishedAt` of the last job outcome already ACTED on.
   *
   * The sidecar RETAINS the last finished job, so every poll after a completion
   * reports the same outcome. Without a stamp to compare against, each poll would look
   * like a fresh completion: the library would be re-read forever and a switch would
   * notify the dashboard repeatedly. `finishedAt` is the sidecar's own identity for a
   * job, so two different jobs cannot share it. Kept as a plain variable rather than
   * read off `lastOutcome` so the decision stays a pure function of two strings.
   */
  let lastOutcomeAt: string | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The slow poll, running for the component's whole life.
   *
   * It exists so a job this component did not start is still SEEN. Once seen, the
   * fast poll above takes over and reports its phases.
   */
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  /** The cadence `progressTimer` runs at, so a cadence change is detectable. */
  let progressIntervalMs = 0;

  /**
   * Whether a version is below the minimum the sidecar reports.
   *
   * `"0.0.0"` is the sidecar's own placeholder meaning "no floor has been derived
   * yet", so it must not badge anything - otherwise every version would appear
   * unsupported until Step 11 sets the real value.
   */
  function belowMinimum(version: string): boolean {
    const minimum = status?.minimumSupported;
    if (!minimum || minimum === "0.0.0") return false;
    return compare(version, minimum) < 0;
  }

  /**
   * The version the harness was running BEFORE the most recent switch, for Q80's way
   * back.
   *
   * Derived rather than remembered from the request, because the switch may have been
   * started from the MENU (Q74), in which case this component never saw the request.
   * The offer is only made when the failure was a SWITCH and an installed version
   * exists that is not the one now running - so the button always names a version
   * that is actually installable. Ordered by the library's own newest-first list, so
   * the suggestion is deterministic.
   */
  let previousVersion = $derived.by(() => {
    if (!status) return null;
    if (lastOutcome?.ok !== false) return null;
    if (status.progress.kind !== "switch") return null;
    const candidates = status.library.filter(
      (entry) => entry.state === "installed" && entry.version !== status?.running,
    );
    return candidates.length > 0 ? candidates[0].version : null;
  });

  /**
   * Unwraps a proxied response, surfacing the shell's own failure when there is one.
   *
   * `shellError` wins because it is the CAUSE: when the sidecar never started, every
   * call fails and the per-call message is only a symptom ("no port yet"). This is
   * the same precedence `App.svelte` applies to the harness status.
   */
  function read<T>(response: ProxiedResponse): T | null {
    if (response.shellError) {
      loadError = response.error ?? response.shellError;
      return null;
    }
    if (response.error) {
      loadError = response.error;
      return null;
    }
    loadError = null;
    return response.data as T;
  }

  /** Reads the installed list and the current job. */
  async function refresh(): Promise<void> {
    try {
      const response = await invoke<ProxiedResponse>("versions_list");
      const next = read<VersionsStatus>(response);
      if (next === null) return;
      status = next;
      // A finished job is remembered so its outcome is not lost when the next poll
      // clears `busy` (Q80's error card depends on this surviving).
      const completion = jobCompletion(next.progress, lastOutcomeAt);
      if (completion.completed) {
        lastOutcome = next.progress.job;
        lastOutcomeAt = completion.finishedAt;
      }
      syncProgressPoll(next.progress.busy);
    } catch (error) {
      loadError = String(error);
    }
  }

  /**
   * The SLOW poll: re-reads the job, and on a completion re-reads everything.
   *
   * This is what makes a MENU-initiated switch visible. It also covers the case the
   * fast poll cannot: a job that started and finished between two fast ticks.
   */
  async function pollIdle(): Promise<void> {
    try {
      const response = await invoke<ProxiedResponse>("versions_progress");
      const next = read<JobProgress>(response);
      if (next === null) return;

      const wasBusy = status?.progress.busy === true;
      if (status) status = { ...status, progress: next };

      // The completion decision is `jobCompletion` in `version-refresh.js`, unit-tested:
      // it exists so a RETAINED job is not mistaken for a fresh one on every poll.
      const completion = jobCompletion(next, lastOutcomeAt);
      if (completion.completed) {
        lastOutcome = next.job;
        lastOutcomeAt = completion.finishedAt;
        if (next.job?.ok === true && next.kind === "switch") {
          // The Running badge and the dashboard's Harness card both need this.
          onSwitchComplete?.();
        }
      }

      if (next.busy) {
        // A job is running that this component may not have started. Speed up.
        syncProgressPoll(true);
      } else if (wasBusy) {
        // It finished since the last look: the library changed.
        await refresh();
      }
    } catch (error) {
      // A slow poll failing is not worth a visible error: the next one will report
      // it, and the fast path has its own reporting.
    }
  }

  /** Reads only the job, on the fast cadence, while one is running. */
  async function pollProgress(): Promise<void> {
    try {
      const response = await invoke<ProxiedResponse>("versions_progress");
      const next = read<JobProgress>(response);
      if (next === null) return;
      if (status) status = { ...status, progress: next };

      const completion = jobCompletion(next, lastOutcomeAt);
      if (completion.completed) {
        lastOutcome = next.job;
        lastOutcomeAt = completion.finishedAt;
        if (next.job?.ok === true && next.kind === "switch") {
          onSwitchComplete?.();
        }
      }

      if (!next.busy) {
        syncProgressPoll(false);
        // The library changed, so re-read the list rather than showing a stale one.
        await refresh();
        await loadAvailable(true);
      }
    } catch (error) {
      loadError = String(error);
      syncProgressPoll(false);
    }
  }

  /**
   * Starts or stops the FAST progress poll to match whether a job is running.
   *
   * Driven by the SIDECAR's `busy`, never by whether this component started the job:
   * a job can be running because the MENU started it (Q74).
   *
   * THE IDLE POLL IS WHAT MAKES THAT TRUE. This function only reacts to a `busy` it
   * has already SEEN, so on its own it cannot discover a menu-initiated job - which is
   * exactly the bug that shipped. `pollIdle` runs for the component's whole life and
   * calls this the moment it sees `busy`, which is what turns "the sidecar's busy flag
   * drives the poll" from an intention into a mechanism.
   */
  function syncProgressPoll(busy: boolean): void {
    if (busy) {
      if (progressTimer !== null && progressIntervalMs === PROGRESS_POLL_MS) return;
      if (progressTimer !== null) clearInterval(progressTimer);
      progressIntervalMs = versionsPollMs(true);
      progressTimer = setInterval(() => {
        void pollProgress();
      }, PROGRESS_POLL_MS);
      return;
    }

    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
      progressIntervalMs = 0;
    }
  }

  /**
   * Reads the registry listing.
   *
   * `force` re-reads after a job finishes, because an install changes which rows are
   * already installed. The route has its own 60s cache, and the command passes
   * `?refresh=1` only when forced, so an idle UI cannot hammer the registry.
   */
  async function loadAvailable(force = false): Promise<void> {
    loadingAvailable = true;
    try {
      const response = await invoke<ProxiedResponse>("versions_available", { refresh: force });
      if (response.shellError) {
        availableError = response.error ?? response.shellError;
        return;
      }
      if (response.error) {
        availableError = response.error;
        return;
      }
      const next = response.data as AvailablePayload;
      // A 503 from the registry comes back as DATA with ok:false rather than as a
      // transport error, because the shell passes non-2xx bodies through verbatim.
      // It must not be mistaken for a listing.
      if (next && (next as unknown as { ok?: boolean }).ok === false) {
        availableError = (next as unknown as { message?: string }).message ?? "The registry could not be read.";
        return;
      }
      availableError = null;
      available = next;
    } catch (error) {
      availableError = String(error);
    } finally {
      loadingAvailable = false;
    }
  }

  /** Installs one version. A download installs; it does not start (Q86). */
  async function download(version: string): Promise<void> {
    if (status?.progress.busy) return;
    busyVersion = version;
    try {
      const response = await invoke<ProxiedResponse>("versions_download", { version });
      const payload = read<JobProgress>(response);
      if (payload === null) return;
      // 202 means accepted; a 409 means another operation is already running. Both
      // are normal results with a body, and the body is what the user should see.
      if (status) status = { ...status, progress: payload };
      // `payload.busy` is the authority on whether a poll is needed: a 409 refusal is
      // NOT busy (nothing started), so it must not spin up a poll loop.
      syncProgressPoll(payload.busy);
    } catch (error) {
      loadError = String(error);
    } finally {
      busyVersion = null;
    }
  }

  /** Switches the running harness to one version. */
  async function switchTo(version: string): Promise<void> {
    if (status?.progress.busy) return;
    busyVersion = version;
    try {
      const response = await invoke<ProxiedResponse>("versions_switch", { version });
      const payload = read<JobProgress>(response);
      if (payload === null) return;
      if (status) status = { ...status, progress: payload };
      syncProgressPoll(payload.busy);
      // A refusal (409) carries the sidecar's own explanation in `message`, which is
      // already on the payload, so there is nothing extra to report here.
    } catch (error) {
      loadError = String(error);
    } finally {
      busyVersion = null;
    }
  }

  /**
   * Removes one version.
   *
   * `partial` routes to the sidecar's `deletePartialVersion`: a tree left behind by
   * an interrupted install is a different intent from a version the user installed,
   * and the two have different guards and different wording (2A's decision). The
   * sidecar refuses the RUNNING version regardless of what is asked here.
   */
  async function remove(version: string, partial: boolean): Promise<void> {
    busyVersion = version;
    try {
      const response = await invoke<ProxiedResponse>("versions_delete", { version, partial });
      const payload = read<{ ok: boolean; reason: string; message: string }>(response);
      if (payload === null) return;
      if (!payload.ok) loadError = payload.message;
      await refresh();
      await loadAvailable(true);
    } catch (error) {
      loadError = String(error);
    } finally {
      busyVersion = null;
    }
  }

  // `onMount`, NOT `$effect`, and the distinction is not stylistic.
  //
  // `$effect` re-runs whenever a reactive value it READ during its last run changes.
  // This component's refresh path writes `status` and `lastOutcome`, so an effect that
  // read either of them could re-enter itself on every job update - at best a redundant
  // request per poll, at worst a loop. `onMount` runs exactly once and its returned
  // closure runs exactly once on destroy, which is what a poll's start/stop wants.
  //
  // THE FIRST READ IS ALSO HOW A JOB STARTED ELSEWHERE IS DISCOVERED: a switch begun
  // from the MENU (Q74) is reported by the sidecar's `busy`, so the component starts
  // its poll for a job it never issued.
  onMount(() => {
    void refresh();
    void loadAvailable();

    // THE SLOW POLL, FOR THE COMPONENT'S WHOLE LIFE. Without it a switch started from
    // the MENU is invisible to this component (Q74), which is the bug the user found:
    // the Installed list kept its "Running" badge on the previous version until a
    // manual Refresh. The sidecar retains the last finished job, so this also reports
    // an outcome that happened while this window was closed.
    idleTimer = setInterval(() => {
      void pollIdle();
    }, IDLE_POLL_MS);

    return () => {
      if (progressTimer !== null) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (idleTimer !== null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };
  });
</script>

<section class="card versions" id="versions">
  <div class="row">
    <h2>Versions</h2>
    <button onclick={() => { void refresh(); void loadAvailable(true); }}>Refresh</button>
  </div>

  {#if loadError}
    <details class="error" open>
      <summary>Version library error</summary>
      <p class="error-lead">{loadError}</p>
    </details>
  {/if}

  <!-- THE JOB, WHILE OR AFTER IT RUNS. The sidecar retains the last finished job, so
       this panel also shows the outcome of a job this component never started - a
       switch begun from the menu, or an install that finished while the dashboard
       was closed. -->
  {#if status?.progress.busy}
    <div class="job busy">
      <p class="progress">
        {status.progress.message ?? "Working..."}
        {#if status.progress.elapsedMs !== null}
          <span class="muted">· {formatElapsed(status.progress.elapsedMs)}</span>
        {/if}
      </p>
      {#if status.progress.kind === "download" && status.progress.phase}
        <!-- The four-phase indicator. Coarse on purpose: the sidecar reports a phase
             it means, never a percentage it guessed. -->
        <ol class="phases">
          {#each PHASES as phase, index (phase)}
            {@const current = PHASES.indexOf(status.progress.phase as (typeof PHASES)[number])}
            <li class:done={index < current} class:active={index === current}>
              {PHASE_LABELS[phase]}
            </li>
          {/each}
        </ol>
      {/if}
      <p class="muted small">
        {status.progress.kind === "switch"
          ? "A switch stops the harness and starts the new version, so the harness is unavailable until it finishes. Closing this window does not cancel it."
          : "Downloading can take several minutes on a first run. Closing this window does not cancel it."}
      </p>
    </div>
  {:else if lastOutcome}
    <!-- Q80: a failed SWITCH leaves the harness stopped and the previous version
         installed. Naming both is what makes the way back discoverable, and the
         button below is a CLICK - not an automatic rollback, which would undo the
         user's own instruction and double the failure surface. -->
    <div class="job" class:failed={lastOutcome.ok === false}>
      {#if lastOutcome.ok === false}
        <p class="error-lead">
          {status?.progress.message ?? "The last version operation failed."}
        </p>
        {#if lastOutcome.error}
          <pre class="detail">{lastOutcome.error}</pre>
        {/if}
        {#if previousVersion && status?.running !== previousVersion}
          <p class="muted small">
            The version that was running before is <strong>v{previousVersion}</strong> and is still
            installed.
          </p>
          <button class="primary" onclick={() => void switchTo(previousVersion as string)} disabled={busyVersion !== null}>
            Switch back to v{previousVersion}
          </button>
        {/if}
      {:else}
        <p class="muted small">{status?.progress.message ?? "The last operation finished."}</p>
      {/if}
    </div>
  {/if}

  <!-- INSTALLED -->
  <h3>Installed</h3>
  {#if status === null}
    <p class="muted small">Reading the version library…</p>
  {:else if status.library.length === 0}
    <p class="muted small">
      No versions are installed yet. Download one below, or use the first-run wizard.
    </p>
  {:else}
    <table>
      <thead>
        <tr><th>Version</th><th>Status</th><th>Installed</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {#each status.library as entry (entry.version)}
          <tr class:running={entry.version === status.running}>
            <td class="mono">
              v{entry.version}
              {#if entry.version === status.running}<span class="badge running">running</span>{/if}
              {#if belowMinimum(entry.version)}<span class="badge warn" title="Older than the oldest version DSH-Dock has verified">below {status.minimumSupported}</span>{/if}
            </td>
            <td>
              <span class="badge {entry.state}">{stateLabel(entry.state)}</span>
            </td>
            <td class="muted small">{formatWhen(entry.installedAt)}</td>
            <td class="actions">
              <button
                class="primary"
                onclick={() => void switchTo(entry.version)}
                disabled={busyVersion !== null || status.progress.busy || entry.version === status.running}
              >
                {entry.version === status.running ? "Running" : "Switch"}
              </button>
              {#if entry.state === "partial"}
                <!-- PARTIAL: offered as a CLEANUP, not a repair, because a repair IS a
                     switch - which reinstalls the tree and then starts it. Two buttons
                     for one outcome would be two names for the same thing, so the
                     honest pair is "Switch" (which repairs) and "Clean up" (which
                     removes). -->
                <button class="danger" onclick={() => void remove(entry.version, true)} disabled={busyVersion !== null}>
                  Clean up
                </button>
              {:else}
                <button class="danger" onclick={() => void remove(entry.version, false)} disabled={busyVersion !== null || entry.version === status.running}>
                  Delete
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted small">
      A <span class="badge partial">partial</span> tree is an install that did not finish. Switching to it
      repairs it (the tree is reinstalled, then started); <em>Clean up</em> removes it instead.
    </p>
  {/if}

  <!-- AVAILABLE -->
  <h3>Available</h3>
  {#if availableError}
    <p class="muted small">{availableError}</p>
    <button onclick={() => void loadAvailable(true)} disabled={loadingAvailable}>Try again</button>
  {:else if available === null}
    <p class="muted small">{loadingAvailable ? "Reading the npm registry…" : "Not read yet."}</p>
  {:else}
    <p class="muted small">
      {available.total} version{available.total === 1 ? "" : "s"} published
      {#if available.truncated}(showing the newest {available.limit}){/if}
      {#if available.fromCache}· from cache{/if}
    </p>
    <table>
      <thead>
        <tr><th>Version</th><th>Channel</th><th>Published</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {#each available.versions.slice(0, 15) as entry (entry.version)}
          <tr>
            <td class="mono">
              v{entry.version}
              {#if entry.belowMinimum}
                <!-- Q77: MARKED, never omitted. The user is sovereign, so an older
                     version stays installable; they are told, and the tool does not
                     decide for them. -->
                <span class="badge warn" title="Older than {available.minimumSupported}, the oldest version DSH-Dock has verified — it may not work">below {available.minimumSupported}</span>
              {/if}
            </td>
            <td><span class="badge channel">{entry.channel}</span></td>
            <td class="muted small">{formatWhen(entry.publishedAt)}</td>
            <td class="actions">
              {#if entry.state === "installed"}
                <button onclick={() => void switchTo(entry.version)} disabled={busyVersion !== null || status?.progress.busy || entry.version === status?.running}>
                  {entry.version === status?.running ? "Running" : "Switch"}
                </button>
              {:else}
                <button
                  class="primary"
                  onclick={() => void download(entry.version)}
                  disabled={busyVersion !== null || status?.progress.busy}
                >
                  {busyVersion === entry.version ? "Starting…" : "Download"}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted small">
      Newest first, by publish date. <em>Download</em> adds a version to the library and does not
      start it; <em>Switch</em> stops the running harness and starts the version you pick.
    </p>
  {/if}
</section>

<style>
  .versions {
    margin-top: 1.5rem;
  }

  h3 {
    margin: 1.5rem 0 0.5rem;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgb(240 240 240 / 0.55);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  th {
    text-align: left;
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgb(240 240 240 / 0.5);
    padding: 0.35rem 0.5rem 0.35rem 0;
  }

  td {
    padding: 0.35rem 0.5rem 0.35rem 0;
    border-top: 1px solid rgb(255 255 255 / 0.06);
    vertical-align: middle;
  }

  tr.running td {
    background: rgb(0 180 216 / 0.06);
  }

  .mono {
    font-family: ui-monospace, Consolas, monospace;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .badge {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: rgb(255 255 255 / 0.08);
  }

  .badge.installed {
    background: rgb(0 180 216 / 0.18);
    color: var(--dsh-accent);
  }

  .badge.partial {
    background: rgb(255 200 0 / 0.16);
    color: #ffc800;
  }

  .badge.running {
    background: rgb(0 180 216 / 0.28);
    color: var(--dsh-accent);
  }

  .badge.channel {
    background: rgb(255 255 255 / 0.06);
  }

  .badge.warn {
    background: rgb(255 200 0 / 0.16);
    color: #ffc800;
    text-transform: none;
  }

  .job {
    margin-top: 1rem;
    padding: 0.75rem;
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 0.5rem;
    background: rgb(255 255 255 / 0.03);
  }

  .job.busy {
    border-color: rgb(0 180 216 / 0.3);
  }

  .job.failed {
    border-color: rgb(255 90 90 / 0.3);
    background: rgb(255 90 90 / 0.06);
  }

  .phases {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.7rem;
  }

  .phases li {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.05);
    color: rgb(240 240 240 / 0.45);
  }

  .phases li.done {
    background: rgb(0 180 216 / 0.15);
    color: rgb(240 240 240 / 0.7);
  }

  .phases li.active {
    background: rgb(0 180 216 / 0.3);
    color: var(--dsh-accent);
    font-weight: 600;
  }

  .progress {
    margin: 0;
    font-size: 0.85rem;
    color: var(--dsh-accent);
  }

  .error-lead {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: #ff8a8a;
  }

  .detail {
    margin: 0.5rem 0 0;
    max-height: 12rem;
    overflow: auto;
    font-size: 0.72rem;
    line-height: 1.45;
    white-space: pre-wrap;
    color: rgb(240 240 240 / 0.8);
  }

  .muted {
    color: rgb(240 240 240 / 0.55);
  }

  .small {
    font-size: 0.75rem;
  }

  .error {
    margin-top: 1rem;
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
</style>
