/**
 * Shared spy helpers for the `[verbatim]` spec-AC drift warning emitted by
 * `warnOnDroppedVerbatimAcs` (src/operations/verbatim-warn.ts). All three plan
 * modes (single / refine / debate) emit the same `logger.warn("plan", "[verbatim] …")`
 * signal, so their tests assert against it identically.
 *
 * Usage:
 *
 * ```ts
 * import { withWarnSpy, verbatimWarn } from "../../helpers";
 *
 * await withWarnSpy(async (warnSpy) => {
 *   await runThePlanPath();
 *   const warn = verbatimWarn(warnSpy);
 *   expect(warn).toBeDefined();
 *   expect((warn?.[2] as { missingCount: number }).missingCount).toBe(1);
 * });
 * ```
 */

import { spyOn } from "bun:test";

type WarnSpy = ReturnType<typeof spyOn>;

/**
 * Install a spy on the logger's `warn` method for the duration of `fn`, then
 * restore it. Resets the logger before and after so the spied instance is the
 * one the code under test resolves via `getSafeLogger()`.
 */
export async function withWarnSpy<T>(fn: (warnSpy: WarnSpy) => Promise<T>): Promise<T> {
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const warnSpy = spyOn(initLogger({ level: "silent" }), "warn");
  try {
    return await fn(warnSpy);
  } finally {
    warnSpy.mockRestore();
    resetLogger();
  }
}

/**
 * The first `logger.warn` call on the `"plan"` channel whose message mentions
 * `[verbatim]`, or `undefined` if none fired. The returned tuple is
 * `[channel, message, data]`.
 */
export function verbatimWarn(warnSpy: WarnSpy) {
  return warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("[verbatim]"));
}
