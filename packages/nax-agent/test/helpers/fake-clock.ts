/**
 * Deterministic virtual clock for timer-driven code.
 *
 * Tests that assert on timer behaviour normally sleep for real and then assert
 * a loose bound ("at least one tick fired"). That is slow — the sleeps are
 * additive across a serially-executed suite — and flaky, because the margin
 * between "long enough" and "too long" shrinks whenever CI stalls.
 *
 * A FakeClock removes both problems: time only moves when the test says so, so
 * assertions become exact ("exactly three ticks") and cost no wall-clock.
 *
 * Inject it into the module under test via that module's `_deps` object:
 *
 * ```ts
 * const clock = makeFakeClock();
 * _heartbeatDeps.setTimeout = clock.setTimeout;
 * _heartbeatDeps.clearTimeout = clock.clearTimeout;
 *
 * startHeartbeat({ intervalMs: 100, ... });
 * await clock.advance(250);
 * expect(ticks).toHaveLength(2);
 * ```
 */

/** A timer scheduled on the virtual timeline. */
interface ScheduledTimer {
  id: number;
  /** Virtual timestamp at which this timer is due. */
  dueAt: number;
  callback: () => void;
  /** Insertion order — breaks ties so same-deadline timers fire FIFO, as real timers do. */
  seq: number;
}

export interface FakeClock {
  /** Current virtual time in ms. Starts at an arbitrary non-zero epoch. */
  now(): number;
  /** Drop-in for `globalThis.setTimeout`. Returns an opaque numeric handle. */
  setTimeout(callback: () => void, delayMs?: number): number;
  /** Drop-in for `globalThis.clearTimeout`. Unknown/undefined ids are ignored. */
  clearTimeout(id?: number): void;
  /**
   * Move virtual time forward by `ms`, firing every timer that comes due — in
   * deadline order — and draining microtasks after each one so `async` callbacks
   * settle before the next fires. Timers armed *during* the advance are honoured
   * if they fall inside the same window, which is what makes self-re-arming
   * loops (heartbeats, poll loops) work.
   */
  advance(ms: number): Promise<void>;
  /** Number of timers currently armed. Use to assert nothing was leaked. */
  pending(): number;
}

/**
 * Ceiling on timers fired within a single `advance()` call. Guards against a
 * callback that re-arms itself at 0ms, which would otherwise spin forever
 * inside the loop and hang the test with no useful diagnostic.
 */
const MAX_TIMERS_PER_ADVANCE = 10_000;

/** Arbitrary non-zero start so tests can't accidentally pass by treating 0 as "unset". */
const EPOCH_MS = 1_700_000_000_000;

/**
 * Let already-queued promise callbacks run. Pure microtask draining — no real
 * timer is involved, so this stays deterministic and costs no wall-clock.
 * Several turns, because an `async` callback that awaits chains microtasks.
 */
const MICROTASK_DRAIN_TURNS = 8;

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_TURNS; i++) {
    await Promise.resolve();
  }
}

export function makeFakeClock(): FakeClock {
  let currentMs = EPOCH_MS;
  let nextId = 1;
  let nextSeq = 0;
  const timers = new Map<number, ScheduledTimer>();

  /** The armed timer with the earliest deadline, or undefined when none is armed. */
  function earliest(): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined;
    for (const timer of timers.values()) {
      if (!best || timer.dueAt < best.dueAt || (timer.dueAt === best.dueAt && timer.seq < best.seq)) {
        best = timer;
      }
    }
    return best;
  }

  return {
    now: () => currentMs,

    setTimeout(callback: () => void, delayMs = 0): number {
      const id = nextId++;
      // Real setTimeout floors negative/NaN delays at 0; match that so code
      // under test behaves identically on either clock.
      const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      timers.set(id, { id, dueAt: currentMs + delay, callback, seq: nextSeq++ });
      return id;
    },

    clearTimeout(id?: number): void {
      if (id !== undefined) timers.delete(id);
    },

    async advance(ms: number): Promise<void> {
      const target = currentMs + ms;
      let fired = 0;

      for (;;) {
        const next = earliest();
        if (!next || next.dueAt > target) break;

        if (++fired > MAX_TIMERS_PER_ADVANCE) {
          throw new Error(
            `FakeClock.advance(${ms}) fired ${MAX_TIMERS_PER_ADVANCE} timers without reaching the target — a callback is almost certainly re-arming itself with a zero/near-zero delay.`,
          );
        }

        // Jump to this timer's deadline before invoking it, so a callback that
        // reads now() sees the time it was scheduled for, not the window's end.
        currentMs = next.dueAt;
        timers.delete(next.id);
        next.callback();
        await drainMicrotasks();
      }

      currentMs = target;
      await drainMicrotasks();
    },

    pending: () => timers.size,
  };
}
