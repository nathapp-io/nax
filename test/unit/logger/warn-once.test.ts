/**
 * Unit tests for Logger.warnOnce.
 *
 * Some warnings describe a standing condition rather than an event — the
 * canonical rules exceeding the static-rules budget, or floor chunks pushing a
 * context bundle past its stage budget. They are re-evaluated on every agent
 * call, so they re-emit on every agent call: one observed run carried 40 such
 * lines whose text never changed, against ~100 lines of real signal.
 *
 * warnOnce reports the first occurrence and demotes the rest to debug, so the
 * JSONL keeps the full tally (with an occurrence ordinal) while the console
 * spends the operator's attention once.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { initLogger, type Logger, resetLogger } from "@/logger";

describe("Logger.warnOnce", () => {
  let logger: Logger;
  let warnSpy: Mock<Logger["warn"]>;
  let debugSpy: Mock<Logger["debug"]>;

  beforeEach(() => {
    resetLogger();
    logger = initLogger({ level: "silent" });
    warnSpy = spyOn(logger, "warn");
    debugSpy = spyOn(logger, "debug");
  });

  afterEach(() => {
    warnSpy.mockRestore();
    debugSpy.mockRestore();
    resetLogger();
  });

  test("the first occurrence is a real warning", () => {
    logger.warnOnce("static-rules", "budget exceeded", { droppedCount: 3 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toBe("budget exceeded");
    const data = warnSpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(data?.droppedCount).toBe(3);
  });

  test("repeats are demoted to debug, not dropped", () => {
    for (let i = 0; i < 5; i++) logger.warnOnce("static-rules", "budget exceeded");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(4);
  });

  test("a demoted repeat records which occurrence it was", () => {
    logger.warnOnce("static-rules", "budget exceeded");
    logger.warnOnce("static-rules", "budget exceeded");
    logger.warnOnce("static-rules", "budget exceeded");

    const ordinals = debugSpy.mock.calls.map((c) => (c[2] as Record<string, unknown> | undefined)?.occurrence);
    expect(ordinals).toEqual([2, 3]);
  });

  test("a different message on the same stage warns on its own", () => {
    logger.warnOnce("static-rules", "budget exceeded");
    logger.warnOnce("static-rules", "sections truncated");

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("the same message on a different stage warns on its own", () => {
    logger.warnOnce("static-rules", "budget exceeded");
    logger.warnOnce("context-v2", "budget exceeded");

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("the ledger is per logger instance, so a new run warns again", () => {
    logger.warnOnce("static-rules", "budget exceeded");
    warnSpy.mockRestore();

    resetLogger();
    const next = initLogger({ level: "silent" });
    const nextWarn = spyOn(next, "warn");
    try {
      next.warnOnce("static-rules", "budget exceeded");
      expect(nextWarn).toHaveBeenCalledTimes(1);
    } finally {
      nextWarn.mockRestore();
    }
  });

  test("data on the first occurrence is passed through untouched", () => {
    logger.warnOnce("context-v2", "floor overage", { storyId: "US-001", overageTokens: 900 });

    expect(warnSpy.mock.calls[0]?.[2]).toEqual({ storyId: "US-001", overageTokens: 900 });
  });
});
