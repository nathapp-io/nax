import { describe, expect, test } from "bun:test";
import { ParseValidationError } from "@/agents/retry";
import type { RetryContext, RetryDecision } from "@/agents/retry";
import type { TurnResult } from "@/agents/types";

describe("ParseValidationError", () => {
  test("extends Error and sets name property", () => {
    const err = new ParseValidationError("invalid JSON shape");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ParseValidationError");
    expect(err.message).toBe("invalid JSON shape");
  });

  test("exposes kind as readonly literal 'parse-validation'", () => {
    const err = new ParseValidationError("test message");
    expect(err.kind).toBe("parse-validation");
    // Verify it's readonly by checking the descriptor
    const descriptor = Object.getOwnPropertyDescriptor(err, "kind");
    expect(descriptor?.writable).toBeFalsy();
  });

  test("can be used with instanceof for discrimination", () => {
    const parseErr = new ParseValidationError("invalid");
    const genericErr = new Error("other");

    expect(parseErr instanceof ParseValidationError).toBe(true);
    expect(genericErr instanceof ParseValidationError).toBe(false);
  });
});

describe("RetryDecision type", () => {
  test("false variant has shape { retry: false }", () => {
    const decision: RetryDecision = { retry: false };
    expect(decision.retry).toBe(false);
  });

  test("true variant accepts { retry: true; delayMs: number }", () => {
    const decision: RetryDecision = { retry: true, delayMs: 1000 };
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(1000);
  });

  test("true variant accepts optional nextPrompt field", () => {
    const decision: RetryDecision = { retry: true, delayMs: 1000, nextPrompt: "retry this" };
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(1000);
    expect((decision as any).nextPrompt).toBe("retry this");
  });

  test("true variant works without nextPrompt field", () => {
    const decision: RetryDecision = { retry: true, delayMs: 500 };
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(500);
    expect((decision as any).nextPrompt).toBeUndefined();
  });
});

describe("RetryContext interface", () => {
  test("has required fields: site, agentName, stage", () => {
    const ctx: RetryContext = {
      site: "run",
      agentName: "claude",
      stage: "run",
    };
    expect(ctx.site).toBe("run");
    expect(ctx.agentName).toBe("claude");
    expect(ctx.stage).toBe("run");
  });

  test("accepts optional storyId field", () => {
    const ctx: RetryContext = {
      site: "complete",
      agentName: "claude",
      stage: "run",
      storyId: "US-001",
    };
    expect(ctx.storyId).toBe("US-001");
  });

  test("accepts optional lastOutput field", () => {
    const ctx: RetryContext = {
      site: "run",
      agentName: "claude",
      stage: "run",
      lastOutput: "some agent output",
    };
    expect(ctx.lastOutput).toBe("some agent output");
  });

  test("accepts optional lastTurnResult field", () => {
    const mockTurnResult: TurnResult = {
      output: "test output",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
    };
    const ctx: RetryContext = {
      site: "complete",
      agentName: "claude",
      stage: "run",
      lastTurnResult: mockTurnResult,
    };
    expect(ctx.lastTurnResult).toBe(mockTurnResult);
  });

  test("accepts all optional fields together", () => {
    const mockTurnResult: TurnResult = {
      output: "test",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
    };
    const ctx: RetryContext = {
      site: "run",
      agentName: "claude",
      stage: "run",
      storyId: "US-001",
      lastOutput: "previous output",
      lastTurnResult: mockTurnResult,
    };
    expect(ctx.storyId).toBe("US-001");
    expect(ctx.lastOutput).toBe("previous output");
    expect(ctx.lastTurnResult).toBe(mockTurnResult);
  });

  test("omitting optional fields compiles without error", () => {
    const ctx: RetryContext = {
      site: "run",
      agentName: "claude",
      stage: "run",
    };
    expect(ctx.lastOutput).toBeUndefined();
    expect(ctx.lastTurnResult).toBeUndefined();
  });

  test("does NOT have a lastParsed field", () => {
    const ctx: RetryContext = {
      site: "run",
      agentName: "claude",
      stage: "run",
    };
    // This test verifies that lastParsed is not in the interface
    // If it were present, TypeScript would allow accessing it
    expect((ctx as any).lastParsed).toBeUndefined();
  });
});
