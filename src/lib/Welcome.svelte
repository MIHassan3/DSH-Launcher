<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

  // The first-run wizard's frontend (docs/PROJECT_DSH-DOCK.md section 3.9).
  //
  // RENDERING RULE: this component is only ever mounted in the window labeled
  // `welcome`. `capabilities/welcome.json` grants that window exactly ONE command
  // - `welcome_submit` - so this file must never invoke anything else. That is why
  // the window branch lives in `App.svelte`, which returns early from `onMount`
  // when its label is not `main`: no dashboard call can run in this window.
  //
  // NO MENU BAR: the shell clears the app-wide menu from this window at creation
  // and after every menu rebuild (`menu::clear_welcome_menu`). A menu here could
  // only produce "could not deliver" lines.

  /** Mirrors `welcome::WizardOption` in src-tauri/src/welcome.rs. */
  interface WizardOption {
    /** The value sent to `welcome_submit`; a `settings::SELECTABLE_CHANNELS` value. */
    channel: string;
    /** Primary text, as section 3.9 renders it. */
    label: string;
    /** Explanatory tail, after a dash. */
    detail: string;
    /** Visible but unchoosable - Stable has no release yet (Q48). */
    disabled: boolean;
  }

  /**
   * The four options, in section 3.9's order.
   *
   * A Rust test (`the_svelte_component_renders_every_option_value`) reads this file
   * and fails if any option's `channel` value is missing or renamed, because these
   * strings are the values `complete_first_run` will validate - the duplication is
   * deliberate and guarded rather than accidental.
   */
  const OPTIONS: WizardOption[] = [
    { channel: "rc", label: "RC", detail: "release candidates (recommended)", disabled: false },
    { channel: "alpha", label: "Alpha", detail: "bleeding edge, changes often", disabled: false },
    { channel: "all", label: "All channels", detail: "always newest", disabled: false },
    { channel: "stable", label: "Stable", detail: "not available yet", disabled: true },
  ];

  /**
   * The channel selected on open.
   *
   * `rc` is the recommended option AND the value a dismissal records, so the
   * initial state and the dismissal outcome agree (`welcome::PRESELECTED_CHANNEL`).
   * The shell may narrow this via `?preselect=`, which it builds from the settings
   * file - the wizard deliberately has no command that could read settings for
   * itself.
   */
  let selected = $state("rc");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    const requested = new URLSearchParams(window.location.search).get("preselect");
    // Only an option this window can actually submit is accepted. Anything else -
    // including the disabled `stable` - is ignored rather than shown as selected,
    // because a radio button that fails on click is worse than a default.
    const match = OPTIONS.find((option) => option.channel === requested && !option.disabled);
    if (match) selected = match.channel;
  });

  /**
   * Records the channel and hands the user to the dashboard.
   *
   * `channel === null` is the DISMISSAL path: the shell defaults it to `rc` and
   * proceeds anyway (section 3.9). Both paths run the same shell function, so
   * "Skip for now" and a real choice differ only in what is written.
   *
   * A failure leaves the window OPEN with the reason on screen. The shell refuses
   * to close the wizard over a write that did not happen - a wizard that vanished
   * with nothing recorded would simply reappear on the next launch with no
   * explanation.
   */
  async function submit(channel: string | null) {
    if (submitting) return;
    submitting = true;
    error = null;
    try {
      await invoke("welcome_submit", { channel });
      // Success closes this window from the Rust side; there is nothing to do
      // here, and reaching this line at all means the close is already queued.
    } catch (failure) {
      error = String(failure);
      submitting = false;
    }
  }
</script>

<main>
  <h1>Welcome to DSH-Dock</h1>
  <p class="tagline">Your launchpad for the DeepSeek Harness.</p>

  <p class="question">Which harness channel would you like to track?</p>

  <fieldset disabled={submitting}>
    <legend class="sr-only">Harness channel</legend>

    {#each OPTIONS as option (option.channel)}
      <label class:disabled={option.disabled}>
        <input
          type="radio"
          name="channel"
          value={option.channel}
          checked={selected === option.channel}
          disabled={option.disabled}
          onchange={() => (selected = option.channel)}
        />
        <span class="label">{option.label}</span>
        <span class="detail">— {option.detail}</span>
      </label>
    {/each}
  </fieldset>

  {#if error}
    <p class="error" role="alert">
      Could not save your choice: {error}
    </p>
  {/if}

  <div class="actions">
    <button class="primary" onclick={() => submit(selected)} disabled={submitting}>
      {submitting ? "Starting…" : "Install and Open Harness"}
    </button>
    <button class="secondary" onclick={() => submit(null)} disabled={submitting}>
      Skip for now
    </button>
  </div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 1.25rem 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.01em;
  }

  .tagline {
    margin: 0.15rem 0 0;
    color: var(--dsh-accent);
    font-size: 0.85rem;
  }

  .question {
    margin: 1rem 0 0.5rem;
    font-size: 0.9rem;
    color: rgb(240 240 240 / 0.75);
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    border: 0;
  }

  fieldset:disabled label {
    opacity: 0.75;
  }

  label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    font-size: 0.875rem;
    cursor: pointer;
  }

  label:hover:not(.disabled) {
    background: rgb(255 255 255 / 0.04);
  }

  label.disabled {
    cursor: default;
    color: rgb(240 240 240 / 0.4);
  }

  input[type="radio"] {
    accent-color: var(--dsh-accent);
    margin: 0;
  }

  .label {
    font-weight: 600;
  }

  .detail {
    color: rgb(240 240 240 / 0.55);
    font-size: 0.8rem;
  }

  label.disabled .label,
  label.disabled .detail {
    color: rgb(240 240 240 / 0.4);
  }

  .error {
    margin: 0.6rem 0 0;
    padding: 0.4rem 0.6rem;
    border: 1px solid rgb(255 90 90 / 0.4);
    border-radius: 0.4rem;
    background: rgb(255 90 90 / 0.08);
    color: #ff8a8a;
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* Pushed to the bottom of the 500x300 client area, so the button does not
       move when the error message appears above it. */
    margin-top: auto;
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

  button.secondary {
    border-color: transparent;
    background: transparent;
    color: rgb(240 240 240 / 0.6);
  }

  button.secondary:hover:not(:disabled) {
    color: var(--dsh-text, #f0f0f0);
  }

  /* The legend is for screen readers; the question above it is the visible label. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
