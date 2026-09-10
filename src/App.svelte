<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";

  // Phase 0 acceptance: the sidecar's real port replaces this placeholder.
  let port: number | null = null;
  let status = "Waiting for sidecar...";

  const EVENT_SIDECAR_READY = "sidecar:ready";
  const EVENT_SIDECAR_ERROR = "sidecar:error";

  interface ReadyPayload {
    port: number;
  }

  // onMount rather than $effect: this is one-time async subscription setup.
  // Reads and writes of `port`/`status` inside a $effect would be tracked as
  // dependencies and could re-run the effect, re-attaching listeners.
  //
  // The invoke() call is not redundant with the event: the sidecar can report
  // its port BEFORE this listener is registered, in which case the event would
  // be missed. `sidecar_port` blocks until the port is known, so the UI is
  // correct under either ordering.
  onMount(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      try {
        unlisteners.push(
          await listen<ReadyPayload>(EVENT_SIDECAR_READY, (event) => {
            port = event.payload.port;
            status = "Ready";
          }),
        );
        unlisteners.push(
          await listen<string>(EVENT_SIDECAR_ERROR, (event) => {
            status = `Sidecar error: ${event.payload}`;
          }),
        );
      } catch (error) {
        status = `Could not attach to the shell: ${String(error)}`;
        return;
      }

      if (disposed) return;

      try {
        port = await invoke<number>("sidecar_port");
        status = "Ready";
      } catch (error) {
        // The event listener normally reports the detailed reason first; this
        // only catches the case where the command itself failed.
        if (port === null) status = `Sidecar unavailable: ${String(error)}`;
      }
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  });
</script>

<main>
  <header>
    <h1>DSH-Dock</h1>
    <p class="tagline">Your launchpad for the DeepSeek Harness.</p>
  </header>

  <section class="card">
    <h2>Phase 0 &mdash; IPC Proof</h2>
    <dl>
      <dt>Shell</dt>
      <dd>Tauri v2 (Rust)</dd>
      <dt>Core</dt>
      <dd>Node sidecar (plain JS)</dd>
      <dt>Sidecar port</dt>
      <dd class="port">
        {#if port === null}
          <span class="pending">{status}</span>
        {:else}
          <span class="ok">{port}</span>
        {/if}
      </dd>
    </dl>
    {#if port !== null}
      <p class="live">
        Handshake received over stdout. Harness URL will be
        <code>http://127.0.0.1:{port}</code> once Phase 1 wires the spawn.
      </p>
    {/if}
  </section>

  <footer>
    <span class="dot"></span>
    Frontend source in <code>src/</code>, build output in <code>dist/</code>.
  </footer>
</main>

<style>
  main {
    max-width: 40rem;
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

  h2 {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgb(240 240 240 / 0.55);
  }

  dl {
    display: grid;
    grid-template-columns: 10rem 1fr;
    gap: 0.5rem 1rem;
    margin: 0;
  }

  dt {
    color: rgb(240 240 240 / 0.55);
  }

  dd {
    margin: 0;
  }

  .port {
    font-family: ui-monospace, Consolas, monospace;
  }

  .pending {
    color: rgb(240 240 240 / 0.45);
  }

  .ok {
    color: var(--dsh-accent);
    font-weight: 600;
  }

  .live {
    margin: 1.25rem 0 0;
    font-size: 0.85rem;
    color: rgb(240 240 240 / 0.6);
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

  code {
    font-family: ui-monospace, Consolas, monospace;
    color: rgb(240 240 240 / 0.7);
  }
</style>
