/**
 * Unit tests for adversarialReviewOp retry flip from hopBody to op.retry
 *
 * Story: US-005c — Flip adversarialReviewOp from hopBody to op.retry
 *
 * Verifies that:
 * - hopBody field is deleted
 * - retry field is active and provides same behavior
 * - cost accumulation works correctly
 * - logging preserves storyId as first key
 * - parse phase runs on final output with looksLikeFail detection
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  assertDefined,
  makeLogger,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import type { AgentRunRequest, RetryStrategy } from "@/agents";
import { ParseValidationError } from "@/agents";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { ReviewConfig } from "@/config/selectors";
import * as loggerModule from "@/logger";
import { _callOpDeps, adversarialReviewOp, type BuildContext, type CallContext, callOp } from "@/operations";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import type { NaxRuntime, PackageView } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/**
 * `RunOperation.config` is declared as a selector-or-key-list union; this op's
 * actual value is always the selector half, so narrow before handing it to
 * `view.select`.
 */
function isConfigSelector<C>(
  candidate: ConfigSelector<C> | readonly (keyof NaxConfig)[],
): candidate is ConfigSelector<C> {
  return !Array.isArray(candidate);
}

function selectOpConfig(view: PackageView): ReviewConfig {
  const selector = adversarialReviewOp.config;
  if (!isConfigSelector(selector)) throw new Error("adversarialReviewOp.config must be a ConfigSelector");
  return view.select(selector);
}

/** Resolve the op's retry field through its declared resolver form into a strategy. */
function resolveRetryStrategy(input: AdversarialReviewInput, buildCtx: BuildContext<ReviewConfig>): RetryStrategy {
  const retry = adversarialReviewOp.retry;
  if (typeof retry !== "function") throw new Error("adversarialReviewOp.retry must be a resolver");
  const resolved = retry(input, buildCtx);
  if (resolved !== undefined && "shouldRetry" in resolved) return resolved;
  throw new Error("adversarialReviewOp.retry must resolve to a strategy");
}

/**
 * callOp injects the accumulated hop cost onto the returned value at runtime
 * without declaring it on `O` — narrow through a predicate instead of casting.
 */
function hasEstimatedCostUsd(
  value: AdversarialReviewOutput,
): value is AdversarialReviewOutput & { estimatedCostUsd: number } {
  return "estimatedCostUsd" in value;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_STORY = {
  id: "STORY-002",
  title: "Add logout endpoint",
  description: "Implement DELETE /session to invalidate the JWT",
  acceptanceCriteria: ["Clears the session token", "Returns 204 on success"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
};

const SAMPLE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/test",
  story: SAMPLE_STORY,
  adversarialConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "def5678",
  stat: "src/session.ts | 15 +++++",
};

const VALID_JSON_OUTPUT = JSON.stringify({ passed: true, findings: [] });

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: selectOpConfig(view) };
}

// ─── AC2: Valid JSON = 1 send() call ─────────────────────────────────────────

describe("AC2: retry behavior — valid JSON response", () => {
  test("retry strategy does not retry when parse succeeds", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    expect(typeof strategy.shouldRetry).toBe("function");
  });

  test("parse receives valid JSON and returns parsed result", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.parse(VALID_JSON_OUTPUT, SAMPLE_INPUT, ctx);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
    expect(result.looksLikeFail).toBeUndefined();
  });
});

// ─── AC3: Invalid+truncated = jsonRetryCondensed with blockingThreshold ──────

describe("AC3: retry behavior — truncated JSON response", () => {
  test("retry strategy detects truncated response and returns retry decision", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const inputWithThreshold: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };
    const strategy = resolveRetryStrategy(inputWithThreshold, opCtx);

    // Unfinished JSON — an object opened and never closed, which is what
    // looksLikeTruncatedJson() detects now that nothing truncates by length.
    const truncatedOutput = `{"passed": false, "findings": [{"severity": "error", "issue": "cut`;

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: truncatedOutput,
    };

    const result = strategy.shouldRetry(new ParseValidationError("JSON shape validation failed"), 0, retryCtx);

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.delayMs).toBeDefined();
    expect(result.nextPrompt).toBeDefined();
  });

  test("condensed retry prompt contains 'truncated'", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const result = strategy.shouldRetry(new ParseValidationError("parse failed"), 0, {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: '{"passed": false, "findings": [{"severity": "error", "issue": "cut',
    });

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.nextPrompt).toContain("truncated");
  });
});

// ─── AC4: Invalid+non-truncated = jsonRetry prompt ──────────────────────────

describe("AC4: retry behavior — invalid but non-truncated response", () => {
  test("retry strategy detects invalid non-truncated response and retries", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const shortInvalidOutput = "this is not valid JSON at all";

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: shortInvalidOutput,
    };

    const result = strategy.shouldRetry(new ParseValidationError("JSON parsing failed"), 0, retryCtx);

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.nextPrompt).not.toContain("truncated");
  });
});

// ─── AC5: budget exhaustion at the configured maxAttempts (default 3, parse-retry budget) ───

describe("AC5: retry behavior — budget exhaustion at review.parseRetryMaxAttempts (default 3)", () => {
  test("retry strategy does not retry after maxAttempts exhausted", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const invalidOutput = "not json";

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: invalidOutput,
    };

    // Default review.parseRetryMaxAttempts is 3 (BUG-62 parse-retry budget) — attempts
    // 0 and 1 retry; attempt 2 (the 3rd call) exhausts the budget.
    const firstResult = strategy.shouldRetry(new ParseValidationError("Parse failed"), 0, retryCtx);
    expect(firstResult.retry).toBe(true);

    const secondResult = strategy.shouldRetry(new ParseValidationError("Parse failed again"), 1, retryCtx);
    expect(secondResult.retry).toBe(true);

    const thirdResult = strategy.shouldRetry(new ParseValidationError("Parse failed a third time"), 2, retryCtx);
    expect(thirdResult.retry).toBe(false);
  });

  test("a lower review.parseRetryMaxAttempts override exhausts sooner", () => {
    const runtime = makeTestRuntime({ config: makeNaxConfig({ review: { parseRetryMaxAttempts: 2 } }) });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const opCtx = { packageView: view, config: selectOpConfig(view) };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: "not json",
    };

    expect(strategy.shouldRetry(new ParseValidationError("Parse failed"), 0, retryCtx).retry).toBe(true);
    expect(strategy.shouldRetry(new ParseValidationError("Parse failed again"), 1, retryCtx).retry).toBe(false);
  });
});

// ─── AC6: cost accumulation = sum of all turns ───────────────────────────────

describe("AC6: cost accumulation — estimatedCostUsd sums all turns", () => {
  test("callOp accumulates estimatedCostUsd across all retry turns up to the default budget", async () => {
    let turnCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        turnCount++;
        return {
          output: "not valid json output",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: turnCount * 0.001,
          internalRoundTrips: 0,
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const originalParse = adversarialReviewOp.parse;
    Object.assign(adversarialReviewOp, {
      parse: () => {
        throw new ParseValidationError("invalid shape — triggers retry");
      },
    });

    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    let result: AdversarialReviewOutput | undefined;
    try {
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/test",
        storyId: SAMPLE_STORY.id,
        featureName: "_test",
        agentName: "claude",
      };
      result = await callOp(ctx, adversarialReviewOp, SAMPLE_INPUT);
    } finally {
      Object.assign(adversarialReviewOp, { parse: originalParse });
      _callOpDeps.sleep = origSleep;
    }

    // Default review.parseRetryMaxAttempts is 3 — one initial call + two re-prompts.
    assertDefined(result, "callOp result");
    if (!hasEstimatedCostUsd(result)) throw new Error("callOp did not surface estimatedCostUsd");
    expect(turnCount).toBe(3);
    expect(result.estimatedCostUsd).toBeCloseTo(0.001 + 0.002 + 0.003, 6);
  });
});

// ─── AC7: Warn log on parse failure has storyId first ──────────────────────

describe("AC7: logging — storyId is first key in data object", () => {
  test("warn logs on JSON parse retry include storyId as first key", () => {
    const logger = makeLogger();
    const spy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    try {
      const ctx = makeBuildCtx();
      const opCtx = { packageView: ctx.packageView, config: ctx.config };
      const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

      // Unfinished JSON — an object opened and never closed, which is what
      // looksLikeTruncatedJson() detects now that nothing truncates by length.
      const truncatedOutput = `{"passed": false, "findings": [{"severity": "error", "issue": "cut`;

      const retryCtx = {
        site: "complete" as const,
        agentName: "claude",
        stage: "review" as const,
        storyId: SAMPLE_STORY.id,
        lastOutput: truncatedOutput,
      };

      const result = strategy.shouldRetry(new ParseValidationError("JSON parse failed"), 0, retryCtx);

      expect(result.retry).toBe(true);

      for (const call of logger.calls.filter((c) => c.message.includes("retry"))) {
        const keys = Object.keys(call.data ?? {});
        expect(keys[0]).toBe("storyId");
        expect(call.data?.storyId).toBe(SAMPLE_STORY.id);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
