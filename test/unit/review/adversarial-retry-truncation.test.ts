/**
 * Unit tests for truncation-aware condensed retry in adversarialReviewOp.
 *
 * US-005c: hopBody removed; retry behavior is now expressed through op.retry
 * (makeParseRetryStrategy). Tests verify prompt selection via shouldRetry()
 * and truncation detection through the RetryContext.lastOutput path.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import { ParseValidationError } from "../../../src/agents/retry/types";
import { adversarialReviewOp } from "../../../src/operations/adversarial-review";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import { makeTestRuntime } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

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

// A response at 4950 chars is within 100 of the cap, so looksLikeTruncatedJson() returns true.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(adversarialReviewOp.config as any) };
}

function makeRetryCtx(lastOutput: string, storyId = STORY.id) {
  return {
    site: "complete" as const,
    agentName: "claude",
    stage: "review" as const,
    storyId,
    lastOutput,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("adversarialReviewOp.retry — truncation-detected condensed retry", () => {
  test("uses condensed retry prompt when response length is at the ACP output cap", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text (not at cap)", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx("here is my analysis: the code looks fine overall"),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).not.toContain("truncated");
  });

  test("fires retry when response is at cap even before attempting parse", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    expect(result.retry).toBe(true);
  });
});

describe("adversarialReviewOp.retry — truncation logging", () => {
  test("logs warn 'JSON parse retry — likely truncated' when response is at cap", () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("adversarial");

    loggerSpy.mockRestore();
  });

  test("logs 'invalid shape' when parseable response has wrong structure", () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    strategy.shouldRetry(
      new ParseValidationError("shape invalid"),
      0,
      makeRetryCtx(JSON.stringify({ passed: true })), // parseable but wrong shape
    );

    const shapeLog = logger.warnCalls.find((c) => c.message.includes("invalid shape"));
    expect(shapeLog).toBeDefined();
    expect(shapeLog?.stage).toBe("adversarial");

    loggerSpy.mockRestore();
  });
});

describe("adversarialReviewOp.retry — Bug 4 regression: parser-first, length is a hint not a veto", () => {
  test("parseable near-cap response is NOT retried (Bug 4 regression)", () => {
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

    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("shape invalid"),
      0,
      makeRetryCtx(validNearCap),
    );

    // The strategy parses the output internally — since it's valid, no retry
    expect(result.retry).toBe(false);
  });

  test("unparseable near-cap response still triggers condensed retry", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).toContain("truncated");
  });

  test("parseable response with invalid shape triggers standard (non-condensed) retry", () => {
    const wrongShape = JSON.stringify({ passed: true }); // missing findings array

    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("shape invalid"),
      0,
      makeRetryCtx(wrongShape),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).not.toContain("truncated");
  });
});
