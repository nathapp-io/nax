/**
 * Arming-origin fixture for the `withTimerSpy` origin-filter case (AC-5).
 *
 * `withTimerSpy(fn, { origin })` records a timer only when the stack captured at
 * arm time contains the origin string, so the filter needs a timer armed from a
 * module the test file does not contain — this one, whose path carries
 * `timer-spy-origin-fixture`.
 *
 * The `try`/`finally` is load-bearing, not decoration. JavaScriptCore inlines a
 * one-expression body away, and an inlined frame disappears from
 * `new Error().stack` — the origin would then never match. Measured on Bun
 * 1.4.3: every other shape tried (a bare `return`, a guard clause, a closure, a
 * spread call, an object method) lost this module's frame on 50 of 50 calls,
 * while this one kept it on 50 of 50.
 */
export function armFixtureTimer(handler: () => void, delayMs: number): unknown {
  try {
    return setTimeout(handler, delayMs);
  } finally {
    // Nothing to release: the caller owns the handle this returns.
  }
}
