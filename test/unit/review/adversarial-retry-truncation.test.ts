/**
 * Unit tests for truncation-aware condensed retry in adversarialReviewOp.
 *
 * US-005c: hopBody removed; retry behavior is now expressed through op.retry
 * (makeParseRetryStrategy). Tests verify prompt selection via shouldRetry()
 * and truncation detection through the RetryContext.lastOutput path.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "@/logger";
import { ParseValidationError } from "@/agents/retry/types";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialReviewConfig } from "@/review/types";
import type { SemanticStory } from "@/review/types";
import { makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

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

// A response whose JSON structure was opened and never closed — what
// looksLikeTruncatedJson() now detects. Long, so it also covers the case the old
// length-based rule conflated with truncation.
const UNFINISHED_JSON = `{"passed": false, "findings": [${'{"severity": "error", "file": "src/a.ts", "issue": "xxxxxxxxxx"},'.repeat(60)}{"severity": "error", "file": "src/b.ts", "issue": "cut off here`;

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
  test("uses condensed retry prompt when the JSON structure is unfinished", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(UNFINISHED_JSON),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text (structurally complete)", () => {
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

  test("fires retry when JSON is unfinished, even before attempting parse", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(UNFINISHED_JSON),
    );

    expect(result.retry).toBe(true);
  });
});

describe("adversarialReviewOp.retry — truncation logging", () => {
  test("logs warn 'JSON parse retry — likely truncated' when the JSON is unfinished", () => {
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
      makeRetryCtx(UNFINISHED_JSON),
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
  test("parseable long response is NOT retried (Bug 4 regression)", () => {
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

  test("unparseable unfinished response still triggers condensed retry", () => {
    const ctx = makeBuildCtx();
    const strategy = (adversarialReviewOp.retry as any)(
      { story: STORY, adversarialConfig: DEFAULT_ADVERSARIAL_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(UNFINISHED_JSON),
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
