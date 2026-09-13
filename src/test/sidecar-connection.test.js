/**
 * Tests for the sidecar connect-retry policy (src/lib/sidecar-connection.js).
 *
 * This is the frontend module that decides when the dashboard may show an error.
 * It is plain JS with injected timing, so it runs under `node` with no browser,
 * no Svelte and no test framework - the same shape as the sidecar suites.
 *
 * The regression being guarded: "The sidecar has not reported a port yet"
 * flashed on screen for under a second at every cold start. That is a normal
 * part of startup, not a failure.
 *
 * Run from the repo root:  node src/test/sidecar-connection.test.js
 */

import { createReport } from "../../sidecar/test/lib/check.js";
import {
  CONNECT_BUDGET_MS,
  CONNECT_PHASE,
  CONNECT_RETRY_DELAYS_MS,
  connectToSidecar,
} from "../lib/sidecar-connection.js";

const report = createReport("DSH-Dock frontend: sidecar connection policy");

/** A controllable clock: `sleep` advances time instead of waiting. */
function makeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Runs connectToSidecar with an injected clock. */
function run(attempt, options = {}) {
  const clock = makeClock();
  const phases = [];
  const realNow = Date.now;
  // Patch Date.now only for the module's budget maths.
  Date.now = () => clock.now();
  return connectToSidecar({
    attempt,
    sleep: clock.sleep,
    onPhase: (phase) => phases.push(phase),
    budgetMs: options.budgetMs,
  })
    .then((result) => ({ result, phases, clock }))
    .finally(() => {
      Date.now = realNow;
    });
}

await report.section("a not-ready shell never shows an error inside the budget", async () => {
  // The shell is still starting: every attempt fails with the symptom.
  let calls = 0;
  const { result, phases } = await run(async () => {
    calls += 1;
    return { data: null, error: "The sidecar has not reported a port yet.", shellError: null };
  });

  report.check("the outcome is an error once the budget is spent", result.phase === CONNECT_PHASE.ERROR, result.phase);
  report.check("the error carries the real symptom", /has not reported a port/.test(result.message ?? ""), result.message);
  report.check("several attempts were made", calls > 1, `calls=${calls}`);
  report.check(
    "every intermediate phase was `connecting`, never `error`",
    phases.every((phase) => phase === CONNECT_PHASE.CONNECTING),
    phases.join(","),
  );
  report.check("no status was produced", result.status === null);
});

await report.section("a shell that becomes ready mid-budget shows no error at all", async () => {
  const status = { status: "stopped", version: null, url: null, pid: null };
  let calls = 0;
  const { result, phases } = await run(async () => {
    calls += 1;
    // Ready on the third attempt - the common cold-start case.
    if (calls < 3) {
      return { data: null, error: "The sidecar has not reported a port yet.", shellError: null };
    }
    return { data: status, error: null, shellError: null };
  });

  report.check("the outcome is `ready`", result.phase === CONNECT_PHASE.READY, result.phase);
  report.check("the status payload is returned", result.status === status);
  report.check("no error message is produced", result.message === null, String(result.message));
  report.check(
    "no phase was ever `error`",
    !phases.includes(CONNECT_PHASE.ERROR),
    phases.join(","),
  );
  report.check("it took three attempts", calls === 3, `calls=${calls}`);
});

await report.section("a real shell failure is immediate and never retried", async () => {
  const shellError =
    "Could not find sidecar/index.js. Searched, starting from the running executable:\n    C:\\x";
  let calls = 0;
  const { result } = await run(async () => {
    calls += 1;
    return { data: null, error: null, shellError };
  });

  report.check("the outcome is an error", result.phase === CONNECT_PHASE.ERROR, result.phase);
  report.check("the shell's own error is surfaced", result.message === shellError);
  report.check("it did NOT retry a final failure", calls === 1, `calls=${calls}`);
});

await report.section("a thrown invoke is final", async () => {
  let calls = 0;
  const { result } = await run(async () => {
    calls += 1;
    throw new Error("command harness_status not allowed by ACL");
  });

  report.check("the outcome is an error", result.phase === CONNECT_PHASE.ERROR, result.phase);
  report.check("the thrown message is surfaced", /ACL/.test(result.message ?? ""), result.message);
  report.check("it did not retry", calls === 1, `calls=${calls}`);
});

await report.section("the budget is what stops the retries", async () => {
  // A slow attempt that overshoots the budget: the loop must stop and report the
  // CURRENT symptom, not a stale one.
  let calls = 0;
  const clock = makeClock();
  const realNow = Date.now;
  Date.now = () => clock.now();
  let result;
  try {
    result = await connectToSidecar({
      attempt: async () => {
        calls += 1;
        clock.advance(5000); // each attempt is slower than the whole budget
        return {
          data: null,
          error: `attempt ${calls} symptom`,
          shellError: null,
        };
      },
      sleep: clock.sleep,
      budgetMs: 1000,
    });
  } finally {
    Date.now = realNow;
  }

  report.check("it stopped with an error", result.phase === CONNECT_PHASE.ERROR, result.phase);
  report.check("it did not spin past the budget", calls <= 3, `calls=${calls}`);
  // The final immediate read happens AFTER the budget check, so it is attempt 2 -
  // which is the current symptom, exactly what we want. The failure mode being
  // excluded is returning the built-in fallback instead of what the shell said.
  report.check(
    "the message is a real symptom from a recent attempt, not the generic fallback",
    /^attempt \d+ symptom$/.test(result.message ?? ""),
    result.message,
  );
});

await report.section("policy constants", () => {
  report.check("the budget is 2 seconds", CONNECT_BUDGET_MS === 2000, String(CONNECT_BUDGET_MS));
  report.check("there are retry delays", CONNECT_RETRY_DELAYS_MS.length >= 2, String(CONNECT_RETRY_DELAYS_MS.length));
  report.check(
    "the delays fit inside the budget",
    CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= CONNECT_BUDGET_MS,
    `${CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms vs ${CONNECT_BUDGET_MS}ms`,
  );
  report.check("three phases are defined", Object.keys(CONNECT_PHASE).length === 3, Object.keys(CONNECT_PHASE).join(","));
});

process.exit(report.finish());
