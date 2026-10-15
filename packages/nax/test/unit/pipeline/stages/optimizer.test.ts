/**
 * Optimizer Stage — issue #369 (Group C)
 *
 * Verifies that a null/falsy ctx.prompt logs at debug level, not warn.
 * The warn demoted to debug because "No prompt to optimize" fires once per
 * story and is a known no-op condition, not an actionable warning.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeLogger, makeTestContext } from "@test/helpers";
import { _optimizerDeps, optimizerStage } from "@/pipeline/stages/optimizer";
import type { PipelineContext } from "@/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalCtx(prompt: string | undefined): PipelineContext {
  return { ...makeTestContext(), prompt } as PipelineContext;
}

const originalGetLogger = _optimizerDeps.getLogger;

afterEach(() => {
  _optimizerDeps.getLogger = originalGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 10 — optimizer no-op: warn → debug
// ─────────────────────────────────────────────────────────────────────────────

describe("optimizerStage — no-prompt path logs at debug not warn", () => {
  test("does not call logger.warn when ctx.prompt is undefined", async () => {
    const logger = makeLogger();
    _optimizerDeps.getLogger = () => logger;

    const result = await optimizerStage.execute(makeMinimalCtx(undefined));

    expect(result.action).toBe("continue");
    expect(logger.calls.some((c) => c.level === "warn")).toBe(false);
    expect(logger.calls.some((c) => c.level === "debug")).toBe(true);
  });

  test("does not call logger.warn when ctx.prompt is empty string", async () => {
    const logger = makeLogger();
    _optimizerDeps.getLogger = () => logger;

    // Empty string is falsy — same early-exit path
    const result = await optimizerStage.execute(makeMinimalCtx(""));

    expect(result.action).toBe("continue");
    expect(logger.calls.some((c) => c.level === "warn")).toBe(false);
    expect(logger.calls.some((c) => c.level === "debug")).toBe(true);
  });
});

describe("optimizerStage — prompt present", () => {
  test("runs the noop optimizer: prompt unchanged, one info line reporting 0% savings", async () => {
    const logger = makeLogger();
    _optimizerDeps.getLogger = () => logger;
    const ctx = makeMinimalCtx("implement the story");

    const result = await optimizerStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prompt).toBe("implement the story");
    const info = logger.calls.filter((c) => c.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]?.message).toBe("noop: 0% savings");
  });

  test("is always enabled", () => {
    expect(optimizerStage.enabled(makeMinimalCtx(undefined))).toBe(true);
  });
});
