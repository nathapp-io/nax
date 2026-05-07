/**
 * Adversarial-review bug regression tests: semanticReviewOp retry through callOp
 *
 * These tests document spec-correct behavior found by adversarial review.
 * They FAIL with the current (buggy) implementation and PASS once the bug is fixed.
 *
 * Bug: semanticReviewOp.parse returns FAIL_OPEN for invalid JSON without
 * "passed":false, preventing the op.retry strategy from ever firing. callOp
 * short-circuits after the first turn instead of issuing the second send() with
 * the jsonRetryCondensed / jsonRetry prompt.
 *
 * Spec (AC3/AC4): on invalid JSON without "passed":false, parse MUST throw
 * ParseValidationError so the retry loop fires and issues a second send() call
 * with the appropriate retry prompt.
 *
 * AC3: truncated output → second send() uses jsonRetryCondensed + blockingThreshold
 * AC4: non-truncated invalid output → second send() uses jsonRetry
 */

/* biome-ignore lint/suspicious/noExplicitAny: test mocking and type compatibility */

import { describe, expect, test } from "bun:test";
import { ParseValidationError } from "../../../src/agents/retry/types";
import { _callOpDeps, callOp, type CallContext } from "../../../src/operations";
import type { SemanticReviewInput } from "../../../src/operations/semantic-review";
import { semanticReviewOp } from "../../../src/operations/semantic-review";
import { MAX_AGENT_OUTPUT_CHARS } from "../../../src/review/truncation";
import { makeMockAgentManager, makeMockRuntime, makeTestRuntime } from "../../helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_STORY = {
  id: "BUG-STORY-001",
  title: "Bug regression story",
  description: "Verify retry fires on invalid JSON",
  acceptanceCriteria: ["parse retry fires"],
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
  stat: "src/auth.ts | 20 +++++",
};

const VALID_JSON_OUTPUT = JSON.stringify({ passed: true, findings: [] });

// Near-cap length so looksLikeTruncatedJson() returns true
const TRUNCATED_INVALID_OUTPUT = "x".repeat(MAX_AGENT_OUTPUT_CHARS - 50);

// Short invalid output — not truncated, no "passed":false
const SHORT_INVALID_OUTPUT = "this is not valid json at all";

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(semanticReviewOp.config as any) };
}

function makeCallCtx(runtime: ReturnType<typeof makeMockRuntime>): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/test",
    storyId: SAMPLE_STORY.id,
    featureName: "_test",
    agentName: "claude",
  };
}

// ─── Bug: op.parse should throw ParseValidationError ────────────────────────
//
// spec-correct behavior: parse MUST throw ParseValidationError for invalid JSON
// that does not contain "passed":false, so the op.retry strategy fires.
// current behavior: returns FAIL_OPEN (a valid pass-through result), bypassing retry.

describe("Bug: semanticReviewOp.parse must throw ParseValidationError for invalid JSON without passed:false", () => {
  test("parse throws ParseValidationError for non-JSON string (no 'passed':false)", () => {
    const ctx = makeBuildCtx();
    expect(() =>
      semanticReviewOp.parse(SHORT_INVALID_OUTPUT, SAMPLE_INPUT, ctx as any),
    ).toThrow(ParseValidationError);
  });

  test("parse throws ParseValidationError for truncated JSON without 'passed':false indicator", () => {
    const ctx = makeBuildCtx();
    // Truncated mid-stream — no "passed":false in the partial text
    const truncatedPassTrue = '{"passed": true, "findings": [{"severity": "error", "file": "src/';
    expect(() =>
      semanticReviewOp.parse(truncatedPassTrue, SAMPLE_INPUT, ctx as any),
    ).toThrow(ParseValidationError);
  });

  test("parse does NOT throw when output clearly contains 'passed':false (looksLikeFail path)", () => {
    const ctx = makeBuildCtx();
    const truncatedFailOutput = '{"passed": false, "findings": ';
    // This should return { looksLikeFail: true } — no throw
    const result = semanticReviewOp.parse(truncatedFailOutput, SAMPLE_INPUT, ctx as any);
    expect(result.passed).toBe(false);
    expect(result.looksLikeFail).toBe(true);
  });
});

// ─── AC3: truncated invalid JSON → callOp issues 2 sends ────────────────────

describe("AC3: truncated invalid JSON triggers retry — callOp issues 2 send() calls", () => {
  test("callOp issues exactly 2 sends when first output is truncated invalid JSON", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: callCount === 1 ? TRUNCATED_INVALID_OUTPUT : VALID_JSON_OUTPUT,
            rateLimited: false,
            durationMs: 10,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeMockRuntime({ agentManager });
    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    try {
      await callOp(makeCallCtx(runtime), semanticReviewOp, SAMPLE_INPUT);
    } finally {
      _callOpDeps.sleep = origSleep;
    }

    // Spec: the retry fires, so send() is called twice
    expect(callCount).toBe(2);
  });

  test("AC3: retry prompt uses jsonRetryCondensed (contains 'truncated')", async () => {
    let callCount = 0;
    const capturedPrompts: string[] = [];

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        callCount++;
        capturedPrompts.push(req.runOptions.prompt);
        return {
          result: {
            success: true,
            exitCode: 0,
            output: callCount === 1 ? TRUNCATED_INVALID_OUTPUT : VALID_JSON_OUTPUT,
            rateLimited: false,
            durationMs: 10,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeMockRuntime({ agentManager });
    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    try {
      await callOp(makeCallCtx(runtime), semanticReviewOp, SAMPLE_INPUT);
    } finally {
      _callOpDeps.sleep = origSleep;
    }

    expect(callCount).toBe(2);
    const retryPrompt = capturedPrompts[1]!;
    // jsonRetryCondensed uniquely starts with "was truncated and could not be parsed"
    expect(retryPrompt).toContain("truncated");
    // Not the plain jsonRetry variant
    expect(retryPrompt).not.toMatch(/^Your previous response could not be parsed/);
  });

  test("AC3: blockingThreshold is forwarded into jsonRetryCondensed prompt text", async () => {
    let callCount = 0;
    const capturedPrompts: string[] = [];

    const inputWithWarning: SemanticReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        callCount++;
        capturedPrompts.push(req.runOptions.prompt);
        return {
          result: {
            success: true,
            exitCode: 0,
            output: callCount === 1 ? TRUNCATED_INVALID_OUTPUT : VALID_JSON_OUTPUT,
            rateLimited: false,
            durationMs: 10,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeMockRuntime({ agentManager });
    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    try {
      await callOp(makeCallCtx(runtime), semanticReviewOp, inputWithWarning);
    } finally {
      _callOpDeps.sleep = origSleep;
    }

    expect(callCount).toBe(2);
    const retryPrompt = capturedPrompts[1]!;
    // blockingThreshold:"warning" → blockingList is '"error" and "warning"'
    expect(retryPrompt).toContain('"error" and "warning"');
  });
});

// ─── AC4: non-truncated invalid JSON → callOp issues 2 sends ────────────────

describe("AC4: non-truncated invalid JSON triggers retry — callOp issues 2 send() calls", () => {
  test("callOp issues exactly 2 sends when first output is short invalid JSON", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => {
        callCount++;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: callCount === 1 ? SHORT_INVALID_OUTPUT : VALID_JSON_OUTPUT,
            rateLimited: false,
            durationMs: 10,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeMockRuntime({ agentManager });
    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    try {
      await callOp(makeCallCtx(runtime), semanticReviewOp, SAMPLE_INPUT);
    } finally {
      _callOpDeps.sleep = origSleep;
    }

    // Spec: the retry fires, so send() is called twice
    expect(callCount).toBe(2);
  });

  test("AC4: retry prompt uses jsonRetry — plain 'could not be parsed' without 'truncated'", async () => {
    let callCount = 0;
    const capturedPrompts: string[] = [];

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        callCount++;
        capturedPrompts.push(req.runOptions.prompt);
        return {
          result: {
            success: true,
            exitCode: 0,
            output: callCount === 1 ? SHORT_INVALID_OUTPUT : VALID_JSON_OUTPUT,
            rateLimited: false,
            durationMs: 10,
            estimatedCostUsd: 0.001,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });

    const runtime = makeMockRuntime({ agentManager });
    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    try {
      await callOp(makeCallCtx(runtime), semanticReviewOp, SAMPLE_INPUT);
    } finally {
      _callOpDeps.sleep = origSleep;
    }

    expect(callCount).toBe(2);
    const retryPrompt = capturedPrompts[1]!;
    // jsonRetry: "Your previous response could not be parsed as valid JSON."
    expect(retryPrompt).toContain("could not be parsed as valid JSON");
    // Must NOT use the condensed/truncated variant
    expect(retryPrompt).not.toContain("truncated");
  });
});
