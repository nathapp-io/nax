/**
 * Unit tests for truncation-aware condensed retry in adversarialReviewOp.
 * Mirrors semantic-retry-truncation.test.ts to confirm makeReviewRetryHopBody
 * is shape-agnostic and works correctly for adversarial review.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-003",
  title: "Implement adversarial review runner",
  description: "Create adversarialReview() with retry logic",
  acceptanceCriteria: ["adversarialReview() accepts story and adversarialConfig"],
};

const DEFAULT_ADVERSARIAL_CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 1,
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// Unparseable near-cap — still triggers condensed retry.
const AT_CAP_UNPARSEABLE = "x".repeat(4950);

// ─── Logger mock ─────────────────────────────────────────────────────────────

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeLogger() {
  const warnCalls: LogCall[] = [];
  return {
    warnCalls,
    warn: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      warnCalls.push({ stage, message, data });
    }),
    info: mock(() => {}),
    debug: mock(() => {}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("adversarialReviewOp.hopBody — truncation-detected condensed retry", () => {
  test("uses condensed retry prompt when response is unparseable near cap", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: AT_CAP_UNPARSEABLE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return {
          output: "analysis: looks fine overall",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).not.toContain("truncated");
  });
});

describe("adversarialReviewOp.hopBody — Bug 4 regression: parser-first, length is a hint not a veto", () => {
  test("parseable near-cap response is NOT retried", async () => {
    const validNearCap = JSON.stringify({
      passed: false,
      findings: Array.from({ length: 7 }, (_, i) => ({
        severity: "error",
        category: "security",
        file: `src/file${i}.ts`,
        line: 10 + i,
        issue: "x".repeat(500),
        suggestion: "y".repeat(150),
      })),
    });
    expect(validNearCap.length).toBeGreaterThanOrEqual(4900);

    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      return { output: validNearCap, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    expect(sendCalls).toHaveLength(1);
    expect(result.output).toBe(validNearCap);
  });

  test("parseable response with invalid shape triggers standard retry", async () => {
    const wrongShape = JSON.stringify({ passed: true }); // missing findings array
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: wrongShape, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).not.toContain("truncated");
  });
});

describe("adversarialReviewOp.hopBody — truncation logging", () => {
  test("logs warn 'likely truncated' when unparseable response is near cap", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const mockSend = mock(async (_prompt: string) => ({
      output: AT_CAP_UNPARSEABLE,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }));

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("adversarial");

    loggerSpy.mockRestore();
  });

  test("logs 'invalid shape' when parseable response has wrong structure", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const mockSend = mock(async (_prompt: string) => ({
      output: JSON.stringify({ passed: true }),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }));

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
    } as any);

    const shapeLog = logger.warnCalls.find((c) => c.message.includes("invalid shape"));
    expect(shapeLog).toBeDefined();
    expect(shapeLog?.stage).toBe("adversarial");

    loggerSpy.mockRestore();
  });
});
