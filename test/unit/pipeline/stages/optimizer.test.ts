/**
 * Optimizer Stage — issue #369 (Group C)
 *
 * Verifies that a null/falsy ctx.prompt logs at debug level, not warn.
 * The warn demoted to debug because "No prompt to optimize" fires once per
 * story and is a known no-op condition, not an actionable warning.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _optimizerDeps, optimizerStage } from "../../../../src/pipeline/stages/optimizer";
import type { PipelineContext } from "../../../../src/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalCtx(prompt: string | undefined): PipelineContext {
  return {
    prompt,
    config: {},
    plugins: [],
  } as unknown as PipelineContext;
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
    let warnCalled = false;
    let debugCalled = false;

    _optimizerDeps.getLogger = mock(() => ({
      warn: (_stage: string, _msg: string) => { warnCalled = true; },
      debug: (_stage: string, _msg: string) => { debugCalled = true; },
      info: () => {},
      error: () => {},
    })) as unknown as typeof _optimizerDeps.getLogger;

    const result = await optimizerStage.execute(makeMinimalCtx(undefined));

    expect(result.action).toBe("continue");
    expect(warnCalled).toBe(false);
    expect(debugCalled).toBe(true);
  });

  test("does not call logger.warn when ctx.prompt is empty string", async () => {
    let warnCalled = false;
    let debugCalled = false;

    _optimizerDeps.getLogger = mock(() => ({
      warn: (_stage: string, _msg: string) => { warnCalled = true; },
      debug: (_stage: string, _msg: string) => { debugCalled = true; },
      info: () => {},
      error: () => {},
    })) as unknown as typeof _optimizerDeps.getLogger;

    // Empty string is falsy — same early-exit path
    const result = await optimizerStage.execute(makeMinimalCtx(""));

    expect(result.action).toBe("continue");
    expect(warnCalled).toBe(false);
    expect(debugCalled).toBe(true);
  });
});
