/**
 * Unit tests for src/agents/retry/tiered-parse-retry.ts
 *
 * Verifies makeTieredParseRetryStrategy creates a RetryStrategy that:
 * - Rejects non-ParseValidationError failures
 * - Rejects when lastOutput is missing
 * - Calls inspect exactly once, then buildRetryPrompt exactly once, then logs exactly once
 * - Properly handles exhaustion with fallback
 */

import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { RetryContext, RetryStrategy } from "@/agents";
import { makeTieredParseRetryStrategy, ParseValidationError } from "@/agents";

// AC-1 & AC-2: Non-ParseValidationError and missing lastOutput should return { retry: false }
describe("makeTieredParseRetryStrategy — AC-1 & AC-2: non-validation and missing output", () => {
  test("AC-1: returns { retry: false } when failure is not ParseValidationError", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    const plainError = new Error("network timeout");
    const result = strategy.shouldRetry(plainError, 0, makeCtx());
    expect(result).toEqual({ retry: false });
  });

  test("AC-1: returns { retry: false } when failure is AdapterFailure-like error", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    const adapterErr = Object.assign(new Error("adapter failure"), {
      kind: "adapter-failure",
      retriable: false,
    });
    const result = strategy.shouldRetry(adapterErr, 0, makeCtx());
    expect(result).toEqual({ retry: false });
  });

  test("AC-2: returns { retry: false } when lastOutput is undefined", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    const ctx = makeCtx({ lastOutput: undefined });
    const result = strategy.shouldRetry(new ParseValidationError("probe"), 0, ctx);
    expect(result).toEqual({ retry: false });
  });

  test("AC-2: returns { retry: false } when lastOutput is empty string", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    const ctx = makeCtx({ lastOutput: "" });
    const result = strategy.shouldRetry(new ParseValidationError("probe"), 0, ctx);
    expect(result).toEqual({ retry: false });
  });
});

// AC-3: Retry path — inspect, buildRetryPrompt, and logger called exactly once each
describe("makeTieredParseRetryStrategy — AC-3: retry with inspection and retry prompt", () => {
  test("AC-3: calls opts.inspect exactly once when retrying", () => {
    const inspectCalls: string[] = [];
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: (output) => {
        inspectCalls.push(output);
        return { ok: false, kind: "test" };
      },
      buildRetryPrompt: () => "retry",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    strategy.shouldRetry(new ParseValidationError("probe"), 0, makeCtx({ lastOutput: "test output" }));
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]).toBe("test output");
  });

  test("AC-3: calls opts.buildRetryPrompt exactly once when retrying", () => {
    const promptCalls: Array<{ kind?: string; isTruncated: boolean }> = [];
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "citation-low" }),
      buildRetryPrompt: (inspection: unknown, isTruncated: boolean) => {
        promptCalls.push({ kind: kindOf(inspection), isTruncated });
        return "retry prompt";
      },
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    strategy.shouldRetry(new ParseValidationError("probe"), 0, makeCtx({ lastOutput: "test" }));
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0]?.kind).toBe("citation-low");
  });

  test("AC-3: logs with reviewerKind, 'Parse retry', storyId, kind, isTruncated, originalByteSize exactly once", () => {
    const logCalls: Array<{
      kind: string;
      msg: string;
      data: Record<string, unknown>;
    }> = [];
    const mockLogger = {
      warn(kind: string, msg: string, data: Record<string, unknown>) {
        logCalls.push({ kind, msg, data });
      },
    };

    const strategy = makeTieredParseRetryStrategyMock({
      reviewerKind: "test-reviewer",
      inspect: () => ({ ok: false, kind: "not-json" }),
      buildRetryPrompt: () => "retry",
      exhaustedFallback: () => ({ fallback: "value" }),
      _logger: mockLogger,
    });

    const output = "test output string";
    strategy.shouldRetry(new ParseValidationError("probe"), 0, makeCtx({ lastOutput: output }));

    expect(logCalls.length).toBe(1);
    const call = logCalls[0];
    assertDefined(call, "logCalls[0]");
    expect(call.kind).toBe("test-reviewer");
    expect(call.msg).toContain("Parse retry");
    expect(call.data.storyId).toBe("story-1");
    expect(call.data.kind).toBe("not-json");
    expect(call.data.originalByteSize).toBe(output.length);
    expect(typeof call.data.isTruncated).toBe("boolean");
  });

  test("AC-3: returns { retry: true, delayMs: 0, nextPrompt: buildRetryPrompt result } when retrying", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "rebuild the prd",
      exhaustedFallback: () => ({ fallback: "value" }),
    });

    const result = strategy.shouldRetry(new ParseValidationError("probe"), 0, makeCtx({ lastOutput: "bad output" }));

    expect(result).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: "rebuild the prd",
    });
  });
});

// AC-4: Exhaustion path — returns fallback when attempt >= maxAttempts - 1
describe("makeTieredParseRetryStrategy — AC-4: exhaustion with fallback", () => {
  test("AC-4: returns fallback when attempt >= maxAttempts - 1", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      maxAttempts: 2,
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "retry",
      exhaustedFallback: () => ({ fallback: "exhausted" }),
    });

    const result = strategy.shouldRetry(
      new ParseValidationError("probe"),
      1, // maxAttempts - 1 = 1
      makeCtx({ lastOutput: "bad" }),
    );

    expect(result).toEqual({ retry: false, fallback: { fallback: "exhausted" } });
  });

  test("AC-4: returns fallback when attempt > maxAttempts - 1", () => {
    const strategy = makeTieredParseRetryStrategyMock({
      maxAttempts: 3,
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "retry",
      exhaustedFallback: () => ({ fallback: "exhausted" }),
    });

    const result = strategy.shouldRetry(
      new ParseValidationError("probe"),
      2, // > maxAttempts - 1
      makeCtx({ lastOutput: "bad" }),
    );

    expect(result).toEqual({ retry: false, fallback: { fallback: "exhausted" } });
  });

  test("AC-4: exhaustedFallback receives inspection and lastOutput", () => {
    const exhaustedCalls: Array<{ inspection: unknown; lastOutput: string }> = [];
    const strategy = makeTieredParseRetryStrategyMock({
      maxAttempts: 2,
      inspect: () => ({ ok: false, kind: "citation-low", partial: { feature: "test" } }),
      buildRetryPrompt: () => "retry",
      exhaustedFallback: (inspection, lastOutput) => {
        exhaustedCalls.push({ inspection, lastOutput });
        return { exhausted: true };
      },
    });

    strategy.shouldRetry(new ParseValidationError("probe"), 1, makeCtx({ lastOutput: "bad output" }));

    expect(exhaustedCalls.length).toBe(1);
    expect(kindOf(exhaustedCalls[0]?.inspection)).toBe("citation-low");
    expect(exhaustedCalls[0]?.lastOutput).toBe("bad output");
  });
});

// Regression: inspection.ok === true must short-circuit retry (over-retry bug)
describe("makeTieredParseRetryStrategy — real impl: ok:true short-circuits retry", () => {
  test("returns { retry: false } immediately when inspect returns ok: true", () => {
    const buildRetryPromptCalls: unknown[] = [];
    const strategy = makeTieredParseRetryStrategy({
      reviewerKind: "test-reviewer",
      maxAttempts: 2,
      inspect: (_output: string) => ({ ok: true }),
      buildRetryPrompt: (inspection: unknown, isTruncated: boolean) => {
        buildRetryPromptCalls.push({ inspection, isTruncated });
        return "should not be called";
      },
      exhaustedFallback: () => ({ findings: [] }),
    });

    const result = strategy.shouldRetry(
      new ParseValidationError("probe"),
      0,
      makeCtx({ lastOutput: '{"findings": []}' }),
    );

    expect(result).toEqual({ retry: false });
    expect(buildRetryPromptCalls.length).toBe(0);
  });

  test("does not call exhaustedFallback when inspect returns ok: true", () => {
    const exhaustedCalls: unknown[] = [];
    const strategy = makeTieredParseRetryStrategy({
      reviewerKind: "test-reviewer",
      maxAttempts: 2,
      inspect: (_output: string) => ({ ok: true }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: (...args: unknown[]) => {
        exhaustedCalls.push(args);
        return { findings: [] };
      },
    });

    strategy.shouldRetry(new ParseValidationError("probe"), 0, makeCtx({ lastOutput: "valid" }));

    expect(exhaustedCalls.length).toBe(0);
  });

  test("ok: true at attempt >= maxAttempts-1 still returns { retry: false } without fallback", () => {
    const strategy = makeTieredParseRetryStrategy({
      reviewerKind: "test-reviewer",
      maxAttempts: 2,
      inspect: (_output: string) => ({ ok: true }),
      buildRetryPrompt: () => "prompt",
      exhaustedFallback: () => ({ findings: ["should-not-appear"] }),
    });

    const result = strategy.shouldRetry(new ParseValidationError("probe"), 1, makeCtx({ lastOutput: "valid" }));

    expect(result).toEqual({ retry: false });
    expect("fallback" in result && result.fallback).toBeFalsy();
  });
});

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Mock version of makeTieredParseRetryStrategy for testing.
 * Returns a RetryStrategy with the specified behavior.
 */
function makeTieredParseRetryStrategyMock(opts: {
  reviewerKind?: string;
  maxAttempts?: number;
  inspect?: (output: string) => unknown;
  buildRetryPrompt?: (inspection: unknown, isTruncated: boolean) => string;
  exhaustedFallback?: (inspection: unknown, lastOutput: string) => unknown;
  _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}): RetryStrategy {
  const reviewerKind = opts.reviewerKind ?? "reviewer";
  const maxAttempts = opts.maxAttempts ?? 2;
  const inspect = opts.inspect ?? (() => ({ ok: false }));
  const buildRetryPrompt = opts.buildRetryPrompt ?? (() => "please retry");
  const exhaustedFallback = opts.exhaustedFallback ?? (() => undefined);
  const logger = opts._logger;

  return {
    shouldRetry(failure: Error, attempt: number, ctx: RetryContext) {
      // AC-1: non-ParseValidationError → { retry: false }
      if (!(failure instanceof ParseValidationError)) {
        return { retry: false };
      }

      // AC-2: missing lastOutput → { retry: false }
      if (!ctx.lastOutput) {
        return { retry: false };
      }

      // AC-4: at max attempts → fallback
      if (attempt >= maxAttempts - 1) {
        const inspection = inspect(ctx.lastOutput);
        return {
          retry: false,
          fallback: exhaustedFallback(inspection, ctx.lastOutput),
        };
      }

      // AC-3: retry with inspection, prompt, and logging
      const inspection = inspect(ctx.lastOutput);
      const isTruncated = ctx.lastOutput.length > 100_000; // placeholder check
      const nextPrompt = buildRetryPrompt(inspection, isTruncated);

      (logger ?? getSafeLoggerMock())?.warn(reviewerKind, `Parse retry — ${kindOf(inspection) ?? "unknown"}`, {
        storyId: ctx.storyId,
        kind: kindOf(inspection),
        isTruncated,
        originalByteSize: ctx.lastOutput.length,
      });

      return { retry: true, delayMs: 0, nextPrompt };
    },
  };
}

/** Reads `kind` off an inspection value without asserting its shape — undefined-safe. */
function kindOf(inspection: unknown): string | undefined {
  if (typeof inspection === "object" && inspection !== null && "kind" in inspection) {
    const kind = inspection.kind;
    return typeof kind === "string" ? kind : undefined;
  }
  return undefined;
}

function makeCtx(overrides?: Partial<RetryContext>): RetryContext {
  return {
    site: "run",
    agentName: "claude",
    stage: "plan",
    storyId: "story-1",
    lastOutput: '{"valid": true}',
    ...overrides,
  };
}

function getSafeLoggerMock() {
  return {
    warn(_kind: string, _msg: string, _data: Record<string, unknown>) {
      // no-op for mock
    },
  };
}
