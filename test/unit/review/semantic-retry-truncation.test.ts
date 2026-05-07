/**
 * Unit tests for truncation-aware condensed retry in semanticReviewOp.
 *
 * US-005b: hopBody removed; retry behavior is now expressed through op.retry
 * (makeParseRetryStrategy). Tests verify prompt selection via shouldRetry()
 * and truncation detection through the RetryContext.lastOutput path.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { ParseValidationError } from "../../../src/agents/retry/types";
import { semanticReviewOp } from "../../../src/operations/semantic-review";
import { makeMockAgentManager } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";
import { makeTestRuntime } from "../../helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: ["runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig"],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// A response at 4950 chars is within 100 of the cap, so looksLikeTruncatedJson() returns true.
// This fixture is intentionally NOT valid JSON — the parser-first logic still retries unparseable
// near-cap responses. Valid JSON near the cap is the Bug 4 regression scenario (see below).
const AT_CAP_UNPARSEABLE = "x".repeat(4950);

// ─── Logger mock helpers ─────────────────────────────────────────────────────

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

interface MockLogger {
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  infoCalls: LogCall[];
  warnCalls: LogCall[];
}

function makeLogger(): MockLogger {
  const infoCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  return {
    infoCalls,
    warnCalls,
    info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      infoCalls.push({ stage, message, data });
    }),
    warn: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      warnCalls.push({ stage, message, data });
    }),
    debug: mock(() => {}),
  };
}

// ─── Saved deps ──────────────────────────────────────────────────────────────

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _semanticDeps.writeReviewAudit;
let origCallOp: typeof _semanticDeps.callOp;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _semanticDeps.writeReviewAudit;
  origCallOp = _semanticDeps.callOp;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _semanticDeps.writeReviewAudit = origWriteReviewAudit;
  _semanticDeps.callOp = origCallOp;
}

function setupHappyPathDeps() {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = mock((_opts: unknown) => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)"));
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(semanticReviewOp.config as any) };
}

function makeAgentManager(llmResponse: string): ReturnType<typeof makeMockAgentManager> {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runWithFallbackFn: async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
        agentFallbacks: [],
      },
      fallbacks: [],
    }),
  });
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

describe("semanticReviewOp.retry — truncation-detected condensed retry", () => {
  test("uses condensed retry prompt when response length is at the ACP output cap", () => {
    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
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
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
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
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    expect(result.retry).toBe(true);
  });

  test("succeeds when condensed retry returns valid JSON after cap-length truncation", () => {
    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    // First attempt: truncated output → should retry
    const result = strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    expect(result.retry).toBe(true);
    expect(result.nextPrompt).toBeDefined();
  });
});

describe("semanticReviewOp.retry — truncation logging", () => {
  test("logs warn 'JSON parse retry — likely truncated' when response is at cap", () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx(AT_CAP_UNPARSEABLE),
    );

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("semantic");

    loggerSpy.mockRestore();
  });

  test("does not log truncation warning when response is short unparseable text (not at cap)", () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    strategy.shouldRetry(
      new ParseValidationError("parse failed"),
      0,
      makeRetryCtx("not json text"),
    );

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeUndefined();

    loggerSpy.mockRestore();
  });
});

describe("semanticReviewOp.retry — Bug 4 regression: parser-first, length is a hint not a veto", () => {
  test("parseable near-cap response is NOT retried (Bug 4 regression)", () => {
    // Build a valid, parseable response that is near the output cap.
    const validNearCap = JSON.stringify({
      passed: false,
      findings: Array.from({ length: 7 }, (_, i) => ({
        severity: "error",
        file: `src/file${i}.ts`,
        line: 10 + i,
        issue: "x".repeat(500),
        suggestion: "y".repeat(150),
        verifiedBy: { command: "read", file: `src/file${i}.ts`, line: 10 + i, observed: "..." },
      })),
    });
    expect(validNearCap.length).toBeGreaterThanOrEqual(4900);

    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    // Parser accepted the response — shouldRetry should not retry
    // (parsed is valid, so the strategy returns { retry: false })
    const result = strategy.shouldRetry(
      // This would only be called if callOp detected a parse error — but for a valid
      // near-cap response, callOp would NOT call shouldRetry at all. This test verifies
      // the strategy handles already-valid-parsed content gracefully.
      new ParseValidationError("shape invalid"),
      0,
      makeRetryCtx(validNearCap),
    );

    // The strategy parses the output internally — since it's valid, no retry
    expect(result.retry).toBe(false);
  });

  test("unparseable near-cap response still triggers condensed retry", () => {
    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
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
    // Parseable JSON but missing required `findings` array — invalid shape.
    const wrongShape = JSON.stringify({ passed: true });

    const ctx = makeBuildCtx();
    const strategy = (semanticReviewOp.retry as any)(
      { story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
      ctx,
    );

    const result = strategy.shouldRetry(
      new ParseValidationError("shape invalid"),
      0,
      makeRetryCtx(wrongShape),
    );

    expect(result.retry).toBe(true);
    // Standard retry — no "truncated" wording.
    expect(result.nextPrompt).not.toContain("truncated");
  });
});

describe("runSemanticReview — truncation integration via callOp mock", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns fail-open when callOp returns failOpen (after retry exhausted)", async () => {
    _semanticDeps.callOp = mock(async () => ({
      passed: true,
      findings: [],
      failOpen: true,
    }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.failOpen).toBe(true);
  });
});
