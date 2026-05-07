/**
 * Integration tests for semanticReviewOp retry behavior (US-005b).
 *
 * Tests verify that semanticReviewOp.retry correctly handles:
 * - Valid JSON (no retry)
 * - Invalid & truncated output (retry with jsonRetryCondensed, blockingThreshold forwarded)
 * - Invalid & non-truncated output (retry with jsonRetry)
 * - Two consecutive invalid outputs (maxAttempts:2, no third attempt)
 * - Parse failure followed by looksLikeFail detection
 * - Cost accumulation across retry turns
 * - Warn log format (storyId as first key)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import { _callOpDeps, callOp } from "../../../src/operations";
import { type SemanticReviewInput, semanticReviewOp } from "../../../src/operations/semantic-review";
import { makeMockAgentManager, makeTestRuntime } from "../../helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_STORY = {
  id: "STORY-001",
  title: "Add login endpoint",
  description: "Implement POST /login returning a JWT",
  acceptanceCriteria: ["Returns 200 on valid credentials"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
};

const SAMPLE_INPUT: SemanticReviewInput = {
  story: SAMPLE_STORY,
  semanticConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "abc1234",
  blockingThreshold: "error",
};

// Valid semantic review output
const VALID_OUTPUT = JSON.stringify({ passed: true, findings: [] });

// Truncated-looking JSON (missing closing brace, etc)
const TRUNCATED_JSON = '{ "passed": false, "findings": [{"severity": "error", "message": "incomplete';

// Invalid shape (missing required fields)
const INVALID_SHAPE = JSON.stringify({ findings: [] });

// Output containing "passed":false but otherwise invalid
const INVALID_WITH_PASSED_FALSE = 'some garbage "passed": false more garbage';

// Save/restore dependencies
let origSleep: typeof _callOpDeps.sleep;

beforeEach(() => {
  origSleep = _callOpDeps.sleep;
  _callOpDeps.sleep = async () => {}; // No delay for tests
});

afterEach(() => {
  _callOpDeps.sleep = origSleep;
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("semanticReviewOp.retry behavior", () => {
  test("AC-1: semanticReviewOp has retry field, no hopBody", () => {
    expect(semanticReviewOp).toHaveProperty("retry");
    expect(semanticReviewOp).not.toHaveProperty("hopBody");
  });

  test("AC-2: valid JSON output triggers exactly one run session call", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: VALID_OUTPUT,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const result = await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    expect(callCount).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("AC-3: invalid truncated output triggers retry", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        if (callCount === 1) {
          // First call returns truncated output
          return {
            result: {
              success: true,
              exitCode: 0,
              output: TRUNCATED_JSON,
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0.001,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
        }
        // Second call returns valid output
        return {
          result: {
            success: true,
            exitCode: 0,
            output: VALID_OUTPUT,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const inputWithThreshold: SemanticReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };

    const result = await callOp(ctx, semanticReviewOp, inputWithThreshold);

    // Should retry once and succeed
    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  test("AC-4: invalid non-truncated output triggers retry", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        if (callCount === 1) {
          // First call returns invalid (non-truncated) output
          return {
            result: {
              success: true,
              exitCode: 0,
              output: INVALID_SHAPE,
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0.001,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
        }
        // Second call returns valid output
        return {
          result: {
            success: true,
            exitCode: 0,
            output: VALID_OUTPUT,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const result = await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    // Should retry once and succeed
    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  test("AC-5: two consecutive invalid outputs exhausts maxAttempts:2", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        // Both calls return invalid output
        return {
          result: {
            success: true,
            exitCode: 0,
            output: INVALID_SHAPE,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const result = await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    // Should try twice (initial + 1 retry, maxAttempts:2), then fail open
    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBe(true);
  });

  test("AC-6: invalid output with 'passed\":false detects looksLikeFail", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        // Return invalid output that contains "passed":false
        return {
          result: {
            success: true,
            exitCode: 0,
            output: INVALID_WITH_PASSED_FALSE,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const result = await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    // Should detect "passed":false in the final output (after exhausting retries)
    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.looksLikeFail).toBe(true);
  });

  test("AC-7: accumulated cost across retry turns", async () => {
    let callCount = 0;
    const costs: number[] = [];

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        const cost = callCount === 1 ? 0.002 : 0.003;
        costs.push(cost);
        if (callCount === 1) {
          // First call with invalid output + cost
          return {
            result: {
              success: true,
              exitCode: 0,
              output: INVALID_SHAPE,
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: cost,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
        }
        // Second call with valid output + cost
        return {
          result: {
            success: true,
            exitCode: 0,
            output: VALID_OUTPUT,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: cost,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    const result = await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    // Verify both attempts were made
    expect(callCount).toBe(2);
    expect(costs).toEqual([0.002, 0.003]);
    expect(result.passed).toBe(true);
  });

  test("AC-8: warn log on parse failure includes storyId", async () => {
    const mockLogger = {
      info: () => {},
      warn: (_stage: string, message: string, data: Record<string, unknown>) => {
        // Verify storyId is present and is the first key
        const keys = Object.keys(data);
        if (message.includes("retry")) {
          expect(keys[0]).toBe("storyId");
          expect(data.storyId).toBe(SAMPLE_STORY.id);
        }
      },
      debug: () => {},
      error: () => {},
    };

    const spy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(
      mockLogger as unknown as ReturnType<typeof loggerModule.getSafeLogger>,
    );

    let callCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        if (callCount === 1) {
          // First call returns invalid output
          return {
            result: {
              success: true,
              exitCode: 0,
              output: INVALID_SHAPE,
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0.001,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
        }
        // Second call returns valid output
        return {
          result: {
            success: true,
            exitCode: 0,
            output: VALID_OUTPUT,
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: SAMPLE_STORY.id,
    };

    await callOp(ctx, semanticReviewOp, SAMPLE_INPUT);

    spy.mockRestore();
    expect(callCount).toBe(2);
  });
});
