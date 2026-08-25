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
