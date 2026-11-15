/** Moved to @nathapp/nax-test-kit by S2-0; nax keeps this path for its own tests. */
import type { FakeClock } from "@nathapp/nax-test-kit/bun/fake-clock";
import type { IdleCompactTimers } from "@/chat";

export * from "@nathapp/nax-test-kit/bun/fake-clock";

/**
 * The fake clock as an injectable timer seam — the shape the chat's armed timers share
 * (`IdleCompactTimers`, `_jobPanelsDeps`, `ask-fallback.ts`), so one adapter serves them all.
 *
 * The seam's handle is `ReturnType<typeof setTimeout> | number` rather than the global's own
 * type, and this is why: three libraries declare the global `setTimeout` (Bun's `Timer`,
 * Node's `Timeout`, lib.dom's `number`), so `typeof setTimeout` is a single overload set
 * returning all three and no fake implementation can satisfy it. The clock's numeric ids pass
 * straight through, and `clearTimeout` accepts whichever kind of handle the production default
 * would have produced.
 */
export function fakeTimers(clock: FakeClock): IdleCompactTimers {
  return {
    setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
    clearTimeout: (handle) => clock.clearTimeout(Number(handle)),
  };
}
