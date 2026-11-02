/**
 * The pieces every memory module races, reports and logs with.
 *
 * They live apart from the modules that use them because the memory modules form a
 * dependency order of their own: sync needs the lock protocol, and the lock protocol needs
 * the timer seam and the never-throwing warn — but not each other. Keeping these three here
 * is what lets `mirror-lock.ts` and `sync.ts` both reach them without the import cycle a
 * shared helper in either one would create.
 *
 * - `GLOBAL_MEMORY_TIMERS` boxes the process timer handles, so a fake clock can stand in for
 *   them through the `MemoryTimers` contract without any caller casting a timer id.
 * - `raceTimeout` bounds an operation nobody can cancel.
 * - `providerAnswers` turns a probe's three failures into the one fact they share.
 * - `warnQuietly` reports a failure without letting the reporting fail its caller.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import type { MemoryProvider } from "./provider-types.ts";
import { MEMORY_PROBE_TIMEOUT_MS, type MemoryTimers } from "./types.ts";

/** The stage every memory-origin log line carries. */
const ERROR_STAGE = "memory";

/** A timer armed on the process clock, boxed so the contract's opaque id stays opaque. */
interface ArmedTimer {
  readonly handle: ReturnType<typeof setTimeout>;
}

function isArmedTimer(id: unknown): id is ArmedTimer {
  return typeof id === "object" && id !== null && "handle" in id;
}

/**
 * The timers an operation races against when the caller injects none: the process
 * globals, read at call time so a substituted global is still observed. The handle
 * is handed back boxed — `MemoryTimers` keeps the timer id opaque precisely so a
 * fake clock can stand in for the real one, and a box clears the handle this race
 * armed without ever casting one.
 */
export const GLOBAL_MEMORY_TIMERS: MemoryTimers = {
  setTimeout: (callback, ms) => ({ handle: globalThis.setTimeout(callback, ms) }),
  clearTimeout: (id) => {
    if (isArmedTimer(id)) globalThis.clearTimeout(id.handle);
  },
};

function timedOut(ms: number): NaxError {
  return new NaxError(`memory operation did not settle within ${ms}ms`, "MEMORY_TIMEOUT", {
    stage: ERROR_STAGE,
    timeoutMs: ms,
  });
}

/**
 * `promise`'s value if it settles within `ms`, and a `MEMORY_TIMEOUT` rejection if it does not.
 *
 * The timer is armed when the race starts and cleared the moment either side
 * settles, so a race that finished leaves nothing armed behind it — the property
 * a fake clock reads as `pending() === 0`. `setTimeout` is the cancellable kind
 * here on purpose (the `forbidden-patterns-source` exception): `Bun.sleep` cannot
 * be cancelled, and a sleep that outlives the answer is exactly the leak this
 * clears.
 *
 * A timer race does not cancel the work it raced: the provider call keeps running
 * after a timeout, because nothing on that side of the seam accepts a signal. Its
 * late rejection is therefore claimed here rather than left to surface as an
 * unhandled rejection in whatever process this library runs in.
 */
export async function raceTimeout<T>(promise: Promise<T>, ms: number, timers: MemoryTimers): Promise<T> {
  promise.catch(() => undefined);
  const deadline = Promise.withResolvers<never>();
  const armed = timers.setTimeout(() => deadline.reject(timedOut(ms)), ms);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    timers.clearTimeout(armed);
  }
}

/** Ask the provider whether it answers within the probe deadline: a throw and a timeout are `false`. */
export async function providerAnswers(provider: MemoryProvider, timers: MemoryTimers): Promise<boolean> {
  try {
    return await raceTimeout(provider.reachable(), MEMORY_PROBE_TIMEOUT_MS, timers);
  } catch {
    // A provider that threw and one that never answered are the same fact here:
    // neither can be delivered to.
    return false;
  }
}

/**
 * Report a failure without letting the reporting fail the caller.
 *
 * The logger is an input, not a guarantee: a host logger that throws would
 * otherwise turn the never-throws contract into a rejection at exactly the
 * moment a result is owed, so a logger failure is discarded on purpose. Shared
 * with the save path, whose rollback is also reported rather than thrown.
 */
export function warnQuietly(logger: AgentLogger, message: string, data: Record<string, unknown>): void {
  try {
    logger.warn(ERROR_STAGE, message, data);
  } catch {
    // Nothing left to report it to: the outcome the caller is owed still returns.
  }
}

/**
 * Run one bookkeeping step whose failure must not become the caller's answer.
 *
 * A provider's refusal is the error the caller is owed, and what follows it — taking the
 * refused write back off the queue, putting back the note the mirror held — is a consequence
 * of that error, not an alternative to it. A step that throws is reported and the rest still
 * runs: a mirror left missing a note it holds, because a queue file could not be removed, is
 * worse than an entry surviving to be refused again.
 */
export async function bookkeeping(
  logger: AgentLogger,
  message: string,
  data: Record<string, unknown>,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    warnQuietly(logger, message, { ...data, error: errorMessage(error) });
  }
}
