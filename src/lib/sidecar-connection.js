/**
 * Sidecar connection retry policy, extracted from the Svelte component so the
 * "do not show an error too early" rule is unit-testable.
 *
 * WHY THIS EXISTS: on a cold start, the Rust shell is still parsing the sidecar's
 * stdout handshake when the dashboard mounts. An immediate `harness_status()`
 * therefore fails with "The sidecar has not reported a port yet". Rendering that
 * as a red error panel - even for half a second before the handshake lands -
 * looks like a failure and is a poor first impression.
 *
 * The rule: while the shell is merely NOT READY YET, keep retrying and show a
 * neutral "connecting" state. Only surface an error once the budget is spent.
 *
 * Crucially, a REAL failure is not retried: if the shell reports its own startup
 * error (`shellError`), that is final and shown immediately - the sidecar will
 * never appear, so waiting would only delay the bad news.
 */

/** Total time to keep retrying a not-ready shell before showing an error. */
export const CONNECT_BUDGET_MS = 2000;

/** Delay before each retry. Chosen so the budget covers several attempts. */
export const CONNECT_RETRY_DELAYS_MS = Object.freeze([400, 600, 1000]);

/**
 * Outcomes of one attempt, mirroring the shell's ProxiedResponse.
 *
 * @typedef {object} Attempt
 * @property {object|null} data          Parsed status payload, or null.
 * @property {string|null} error         Per-call transport/symptom message.
 * @property {string|null} shellError    The shell's own startup failure (final).
 */

/**
 * Statuses the UI can be in while connecting.
 *   "connecting" - still waiting for the shell; show a neutral note, no error
 *   "ready"      - a status payload arrived
 *   "error"      - a real, final failure
 */
export const CONNECT_PHASE = Object.freeze({
  CONNECTING: "connecting",
  READY: "ready",
  ERROR: "error",
});

/**
 * Drives the first-load handshake.
 *
 * @param {{
 *   attempt: () => Promise<Attempt>,
 *   sleep?: (ms: number) => Promise<void>,
 *   onPhase?: (phase: string, detail?: string) => void,
 *   budgetMs?: number,
 * }} options
 * @returns {Promise<{phase: string, status: object|null, message: string|null}>}
 */
export async function connectToSidecar(options) {
  const attempt = options.attempt;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const onPhase = options.onPhase ?? (() => {});
  const budgetMs = options.budgetMs ?? CONNECT_BUDGET_MS;

  const startedAt = Date.now();
  let lastSymptom = "The DSH-Dock core has not reported a port yet.";

  onPhase(CONNECT_PHASE.CONNECTING);

  // One immediate attempt, then the retry schedule.
  const delays = [0, ...CONNECT_RETRY_DELAYS_MS];

  const readOnce = async () => {
    let result;
    try {
      result = await attempt();
    } catch (error) {
      // A thrown invoke (IPC failure) is final - there is nothing to retry.
      return { phase: CONNECT_PHASE.ERROR, status: null, message: String(error) };
    }

    if (result?.shellError) {
      // The shell failed to start the sidecar. Waiting cannot help, so this is
      // reported immediately rather than after the budget.
      return { phase: CONNECT_PHASE.ERROR, status: null, message: result.shellError };
    }

    if (result?.data) {
      return { phase: CONNECT_PHASE.READY, status: result.data, message: null };
    }

    // Not ready yet. Record the symptom but do NOT surface it: rendering an
    // error here is exactly the flash this module exists to prevent.
    if (result?.error) lastSymptom = result.error;
    return null;
  };

  for (let index = 0; index < delays.length; index += 1) {
    const delay = delays[index];
    if (delay > 0) await sleep(delay);

    const outcome = await readOnce();
    if (outcome !== null) return outcome;

    // Only report failure once the budget is spent - checked AFTER the attempt,
    // so a slow attempt cannot be cut short before it produced a real symptom.
    if (Date.now() - startedAt >= budgetMs) {
      // One last immediate read. If the budget was consumed by a slow attempt,
      // the previous symptom is stale; this read has the current one.
      const final = await readOnce();
      if (final !== null) return final;
      return { phase: CONNECT_PHASE.ERROR, status: null, message: lastSymptom };
    }

    onPhase(CONNECT_PHASE.CONNECTING);
  }

  // Schedule exhausted without exceeding the budget: one final check decides.
  const final = await readOnce();
  if (final !== null) return final;
  return { phase: CONNECT_PHASE.ERROR, status: null, message: lastSymptom };
}
