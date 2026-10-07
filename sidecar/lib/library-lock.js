/**
 * The version library's advisory lock
 * (docs/PROJECT_DSH-DOCK.md section 3.1, Phase 2 milestone 1).
 *
 * WHY A LOCK AT ALL. `HarnessControl` already serializes starts within one
 * process with a single in-flight promise, and that is the case that matters most.
 * What it does not cover is a SECOND writer: another sidecar left running from an
 * earlier launcher, a developer running the sidecar by hand while the app is open,
 * or an operator running `npm install --prefix` in the same directory. Two npm
 * installs writing into the same library, or two read-modify-write cycles over
 * `catalogue.json`, are how a library gets a version that is two installs mixed
 * together - which validation cannot detect, because every individual file exists.
 *
 * WHAT THIS IS NOT. It is not a distributed lock and it is not a security
 * boundary. It is advisory: it protects against the launcher's own processes and
 * against a cooperative operator. A determined external writer can ignore it
 * entirely, and that is accepted rather than over-engineered.
 *
 * THE PRIMITIVE IS `open(…, "wx")`. Exclusive creation, atomic on NTFS and on
 * POSIX: exactly one caller can create the file, and every other caller gets
 * `EEXIST`. There is no read-then-write race in the acquire path itself.
 *
 * STALENESS IS THE HARD PART. A process killed while holding the lock (which
 * Phase 2's own job-object work will make routine in tests) leaves the file
 * behind, and a lock that can never be acquired is worse than no lock - the user
 * simply cannot install anything again. So an existing lock is examined, not
 * obeyed:
 *
 *   - whose pid, and is that process still alive?
 *   - how old, and is that older than the stale threshold?
 *
 * A lock held by a live process is respected regardless of age (an install
 * legitimately takes up to 10 minutes). A lock whose owner is gone, or that is
 * older than the threshold, is reported as stale and can be taken over - with the
 * takeover recorded in the result so the caller can log why.
 */

import fs from "node:fs";
import path from "node:path";

import { LOCK_FILE_NAME } from "./library.js";
import { isAlive } from "./platform.js";
import { resolveStatePaths } from "./state.js";

/**
 * How long a lock may exist before it is presumed abandoned.
 *
 * The install budget is 10 minutes (`DEFAULT_INSTALL_TIMEOUT_MS`), so the
 * threshold must be at least that or a legitimate slow install would be treated as
 * abandoned and a second npm would start beside it. 15 minutes gives the install
 * timeout room to fire and reap its own process first, which is the intended
 * order of events.
 */
export const STALE_LOCK_MS = 15 * 60 * 1000;

/** Absolute path of the library's lock file. */
export function lockPath(options = {}) {
  const paths = options.paths ?? resolveStatePaths();
  return options.file ?? path.join(paths.versions, LOCK_FILE_NAME);
}

/** Reads the lock file. Returns null when absent or unparseable. */
export function readLock(options = {}) {
  const file = lockPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * How old a lock is, in milliseconds, or null when it cannot be determined.
 *
 * An unparseable `acquiredAt` returns null rather than 0: an unknown age must not
 * be silently treated as "brand new" (which would never go stale) or as "ancient"
 * (which would let anyone steal a live lock).
 */
export function lockAgeMs(lock, options = {}) {
  const stamp = lock?.acquiredAt;
  if (typeof stamp !== "string") return null;
  const acquired = Date.parse(stamp);
  if (Number.isNaN(acquired)) return null;
  return (options.now ?? Date.now()) - acquired;
}

/**
 * Why an existing lock cannot be taken over, or null when it can.
 *
 * Returns a human-readable reason so the refusal message can say which process is
 * holding the library and since when - "the library is locked" on its own is not
 * actionable.
 */
export function describeHolder(lock) {
  if (lock === null) return "the lock file exists but is unreadable";
  const who = Number.isInteger(lock.pid) ? `pid ${lock.pid}` : "an unknown process";
  const when = typeof lock.acquiredAt === "string" ? ` since ${lock.acquiredAt}` : "";
  return `${who}${when}`;
}

/**
 * Whether an existing lock is stale and may be taken over.
 *
 * @returns {{stale: boolean, reason: string}}
 */
export function isLockStale(lock, options = {}) {
  const now = options.now ?? Date.now();
  const threshold = options.staleMs ?? STALE_LOCK_MS;
  const alive = options.isAlive ?? isAlive;

  if (lock === null) {
    return { stale: true, reason: "the lock file is unreadable, so it cannot be a live holder" };
  }

  const age = lockAgeMs(lock, { now });

  if (age !== null && age > threshold) {
    return {
      stale: true,
      reason: `held by ${describeHolder(lock)}, which is ${Math.round(age / 1000)}s old (over the ${Math.round(threshold / 1000)}s threshold)`,
    };
  }

  if (Number.isInteger(lock.pid) && lock.pid > 0) {
    let running = false;
    try {
      running = alive(lock.pid);
    } catch {
      // An unanswerable liveness question must not authorize a takeover.
      running = true;
    }
    if (!running) {
      return { stale: true, reason: `held by ${describeHolder(lock)}, whose process is gone` };
    }
    return { stale: false, reason: `held by ${describeHolder(lock)}, which is still running` };
  }

  if (age === null) {
    // No usable pid AND no usable timestamp. Refusing is the safe direction: a
    // lock we cannot evaluate is one we cannot prove is abandoned.
    return { stale: false, reason: "the lock file records neither a live pid nor a usable timestamp" };
  }

  return { stale: false, reason: `held by ${describeHolder(lock)}` };
}

/**
 * Tries to acquire the library lock.
 *
 * Returns a discriminated result and never throws: an install that cannot take the
 * lock must produce a clear refusal, not an exception from a filesystem call.
 *
 * @param {{paths?: object, now?: number, staleMs?: number, isAlive?: Function,
 *          pid?: number, reason?: string, stolen?: boolean}} [options]
 *   `pid` overrides the recorded owner (used by tests to simulate a foreign
 *   holder, and to prove a second process is refused).
 * @returns {{acquired: boolean, file: string, owner: object|null,
 *            stolen: boolean, holder: string|null, error: string|null}}
 */
export function acquireLock(options = {}) {
  const file = lockPath(options);
  const now = options.now ?? Date.now();

  const owner = {
    pid: options.pid ?? process.pid,
    acquiredAt: new Date(now).toISOString(),
    reason: options.reason ?? "version library operation",
  };

  const attempt = () => {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`, null, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    attempt();
    return { acquired: true, file, owner, stolen: false, holder: null, error: null };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return { acquired: false, file, owner: null, stolen: false, holder: null, error: error.message };
    }
  }

  // Someone holds it. Evaluate, then either refuse or take it over.
  const existing = readLock(options);
  const staleness = isLockStale(existing, { ...options, now });

  if (!staleness.stale) {
    return {
      acquired: false,
      file,
      owner: null,
      stolen: false,
      holder: describeHolder(existing),
      error: null,
    };
  }

  // Takeover: remove the abandoned lock and retry ONCE.
  //
  // The retry can still lose a race against a third process that acquired the
  // lock between the unlink and the open. That is correct: the loser reports a
  // refusal rather than proceeding without a lock.
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { acquired: false, file, owner: null, stolen: false, holder: null, error: error.message };
    }
  }

  try {
    attempt();
    return {
      acquired: true,
      file,
      owner,
      stolen: true,
      holder: describeHolder(existing),
      error: null,
    };
  } catch (error) {
    return {
      acquired: false,
      file,
      owner: null,
      stolen: false,
      holder: describeHolder(readLock(options)),
      error: error?.code === "EEXIST" ? null : error.message,
    };
  }
}

/**
 * Releases the lock, but ONLY if this process still owns it.
 *
 * The ownership check matters: a process whose stale lock was taken over by
 * someone else must not delete the NEW holder's lock on its way out. `pid` is
 * compared rather than assumed, and an unreadable lock is left alone rather than
 * guessed at.
 *
 * @returns {{released: boolean, reason: string}}
 */
export function releaseLock(options = {}) {
  const file = lockPath(options);
  const pid = options.pid ?? process.pid;
  const existing = readLock(options);

  if (existing === null && !fs.existsSync(file)) {
    return { released: false, reason: "there was no lock file" };
  }

  if (existing !== null && Number.isInteger(existing.pid) && existing.pid !== pid) {
    return {
      released: false,
      reason: `the lock is now held by ${describeHolder(existing)}, so it was left alone`,
    };
  }

  try {
    fs.unlinkSync(file);
    return { released: true, reason: "released" };
  } catch (error) {
    if (error?.code === "ENOENT") return { released: false, reason: "the lock file was already gone" };
    return { released: false, reason: error.message };
  }
}

/**
 * Runs `body` while holding the library lock, releasing it in `finally`.
 *
 * ASYNC-AWARE ON PURPOSE. `installVersion` is `async`, so a lock helper that
 * released the lock when `body` returned its *promise* would drop the lock at the
 * start of the install rather than the end - an invisible bug in exactly the case
 * the lock exists for. Awaiting the body keeps the `finally` after the work.
 *
 * The `finally` is the point: every failure path in `installVersion` - a npm
 * non-zero exit, a validation failure, a throw from somewhere unexpected - must
 * release the lock, or a single bad install bricks the library until the lock goes
 * stale.
 *
 * @param {Function} body receives the acquire result; may return a promise
 * @param {object} [options]
 * @throws the error thrown by `body`, unchanged
 */
export async function withLock(body, options = {}) {
  const acquired = acquireLock(options);

  if (!acquired.acquired) {
    const detail = acquired.error
      ? `the lock file could not be created: ${acquired.error}`
      : `it is held by ${acquired.holder}`;
    const error = new Error(
      `Another version library operation is already in progress, so this one was not started: ${detail}. ` +
        `Wait for it to finish, or delete ${acquired.file} if you are certain no install is running.`,
    );
    error.name = "LibraryLockedError";
    error.code = "library-locked";
    error.lockFile = acquired.file;
    error.holder = acquired.holder;
    throw error;
  }

  try {
    return await body(acquired);
  } finally {
    releaseLock(options);
  }
}
