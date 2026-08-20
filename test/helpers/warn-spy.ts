/**
 * Shared spy helpers for assertions against a single logger level.
 *
 * `withWarnSpy` was written for the drift warnings emitted by the plan ops
 * (src/operations/plan-fidelity.ts) — all three plan modes (single / refine /
 * debate) emit theirs through `logger.warn("plan", …)`, so their tests assert
 * against it identically. `withInfoSpy` is the same contract one level down, for
 * records the code under test emits via `logger.info`.
 *
 * Usage:
 *
 * ```ts
 * import { withWarnSpy } from "@test/helpers";
 *
 * await withWarnSpy(async (warnSpy) => {
 *   await runThePlanPath();
 *   const warn = warnSpy.mock.calls.find((c) => c[0] === "plan");
 *   expect(warn).toBeDefined();
 *   expect((warn?.[2] as { missingCount: number }).missingCount).toBe(1);
 * });
 * ```
 */

import { spyOn } from "bun:test";

type LogSpy = ReturnType<typeof spyOn>;

/**
 * Install a spy on one logger level for the duration of `fn`, then restore it.
 * Resets the logger before and after so the spied instance is the one the code
 * under test resolves via `getSafeLogger()`.
 */
async function withLogSpy<T>(level: "warn" | "info", fn: (spy: LogSpy) => Promise<T>): Promise<T> {
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const spy = spyOn(initLogger({ level: "silent" }), level);
  try {
    return await fn(spy);
  } finally {
    spy.mockRestore();
    resetLogger();
  }
}

/** Spy on `logger.warn` for the duration of `fn`. */
export async function withWarnSpy<T>(fn: (warnSpy: LogSpy) => Promise<T>): Promise<T> {
  return withLogSpy("warn", fn);
}

/**
 * Spy on `logger.info` for the duration of `fn`. Same contract as
 * `withWarnSpy` — used where the assertion targets an info-level record
 * (e.g. the ADR-024 nbf rollback log, #1382).
 */
export async function withInfoSpy<T>(fn: (infoSpy: LogSpy) => Promise<T>): Promise<T> {
  return withLogSpy("info", fn);
}

