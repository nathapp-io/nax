/**
 * Unit tests for src/review/dialogue.ts — US-002
 *
 * Tests cover:
 * AC1 — reReview() sends follow-up prompt referencing previous findings by AC identifier
 * AC2 — reReview() returns ReviewDialogueResult with non-empty deltaSummary
 * AC3 — reReview() appends exactly two DialogueMessage entries to history
 * AC4 — session compaction when history.length exceeds maxDialogueMessages
 * AC5 — clarify() sends question as follow-up and returns raw response string
 * AC6 — clarify() appends two DialogueMessage entries with correct roles
 * AC7 — getVerdict() returns SemanticVerdict with correct fields from last checkResult
 * AC8 — getVerdict() throws NaxError 'NO_REVIEW_RESULT' before any review()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { NaxConfig } from "../../../src/config";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { RunAsSessionOpts } from "../../../src/agents/manager-types";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import { createReviewerSession } from "../../../src/review/dialogue";
import type { ReviewerSession } from "../../../src/review/dialogue";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/semantic";
import { NaxError } from "../../../src/errors";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Re-review, clarification, and verdict extraction",
  description: "Extend ReviewerSession with reReview(), clarify(), and getVerdict()",
  acceptanceCriteria: [
    "reReview(updatedDiff) sends a follow-up prompt referencing previous findings",
    "reReview() returns deltaSummary describing resolved vs outstanding findings",
    "getVerdict() extracts SemanticVerdict from last checkResult",
  ],
};

const SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const SAMPLE_DIFF = "diff --git a/src/review/dialogue.ts b/src/review/dialogue.ts\n+export function foo() {}";
const UPDATED_DIFF = "diff --git a/src/review/dialogue.ts b/src/review/dialogue.ts\n+export function foo() {}\n+export function bar() {}";

const INITIAL_PASSING_RESPONSE = JSON.stringify({
  passed: true,
  findings: [],
  findingReasoning: {},
});

const INITIAL_FAILING_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      ruleId: "AC-1-not-satisfied",
      severity: "error",
      file: "src/review/dialogue.ts",
      line: 1,
      message: "AC-1 not satisfied: reReview method missing",
    },
    {
      ruleId: "AC-2-not-satisfied",
      severity: "error",
      file: "src/review/dialogue.ts",
      line: 2,
      message: "AC-2 not satisfied: deltaSummary not returned",
    },
  ],
  findingReasoning: {
    "AC-1-not-satisfied": "The reReview() method does not exist in the implementation",
    "AC-2-not-satisfied": "The deltaSummary field is absent from the result",
  },
});

const RE_REVIEW_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      ruleId: "AC-2-not-satisfied",
      severity: "error",
      file: "src/review/dialogue.ts",
      line: 2,
      message: "AC-2 not satisfied: deltaSummary not returned",
    },
  ],
  findingReasoning: {
    "AC-2-not-satisfied": "The deltaSummary field is still absent from the result",
  },
  deltaSummary: "AC-1-not-satisfied is now resolved. AC-2-not-satisfied is still present.",
});

const CLARIFY_RESPONSE = "AC-1 requires that reReview() calls agent.run() with keepOpen: true and includes the previous findings in the prompt.";

type RunAsSessionFnType = (agentName: string, handle: SessionHandle, prompt: string, opts?: RunAsSessionOpts) => Promise<TurnResult>;

function makeAgentManager(runAsSessionFn?: RunAsSessionFnType): IAgentManager {
  const defaultFn = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string): Promise<TurnResult> => ({
    output: INITIAL_PASSING_RESPONSE,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    internalRoundTrips: 0,
  }));
  const effectiveFn = runAsSessionFn ?? defaultFn;

  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runAsSessionFn: async (agentName: string, handle: SessionHandle, prompt: string, opts?: RunAsSessionOpts) => {
      return await effectiveFn(agentName, handle, prompt, opts);
    },
    completeFn: async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
  });
}

function makeConfig() {
  return NaxConfigSchema.parse({}) as unknown as NaxConfig;
}

/**
 * Creates a session and performs an initial review() with failing findings,
 * so that reReview() has a populated checkResult to reference.
 */
async function makeSessionWithReview(runSequence: string[]): Promise<ReviewerSession> {
  let callIndex = 0;
  const runFn: RunAsSessionFnType = async () => {
    const output = runSequence[callIndex] ?? INITIAL_PASSING_RESPONSE;
    callIndex++;
    return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
  };
  const agentManager = makeAgentManager(runFn);
  const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
  await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
  return session;
}

// ---------------------------------------------------------------------------
// AC1 — reReview() sends follow-up referencing previous findings by AC identifier
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReview() — agentManager.runAsSession() call parameters (ADR-019)", () => {
  let capturedPrompt: string | undefined;
  let capturedOpts: RunAsSessionOpts | undefined;
  let session: ReviewerSession;

  beforeEach(async () => {
    capturedPrompt = undefined;
    capturedOpts = undefined;
    let callIndex = 0;
    const responses = [INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE];
    const runFn: RunAsSessionFnType = async (_agentName, _handle, prompt, opts) => {
      capturedPrompt = prompt;
      capturedOpts = opts;
      const output = responses[callIndex] ?? INITIAL_PASSING_RESPONSE;
      callIndex++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    };
    const agentManager = makeAgentManager(runFn);
    session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
    // perform initial review so checkResult is populated
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    // reset captured values so we only capture reReview's call
    capturedPrompt = undefined;
    capturedOpts = undefined;
  });

  afterEach(async () => {
    if (session.active) await session.destroy();
    mock.restore();
  });

  test("calls agentManager.runAsSession() with pipelineStage: 'review'", async () => {
    await session.reReview(UPDATED_DIFF);
    expect(capturedOpts?.pipelineStage).toBe("review");
  });

  test("prompt contains the updated diff", async () => {
    await session.reReview(UPDATED_DIFF);
    expect(capturedPrompt).toContain(UPDATED_DIFF);
  });

  test("prompt references previous finding by ruleId (AC-1-not-satisfied)", async () => {
    await session.reReview(UPDATED_DIFF);
    expect(capturedPrompt).toContain("AC-1-not-satisfied");
  });

  test("prompt references second previous finding by ruleId (AC-2-not-satisfied)", async () => {
    await session.reReview(UPDATED_DIFF);
    expect(capturedPrompt).toContain("AC-2-not-satisfied");
  });
});

// ---------------------------------------------------------------------------
// AC2 — reReview() returns ReviewDialogueResult with non-empty deltaSummary
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReview() — deltaSummary field", () => {
  test("returns ReviewDialogueResult with deltaSummary defined", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const result = await session.reReview(UPDATED_DIFF);
    expect(result.deltaSummary).toBeDefined();
    await session.destroy();
  });

  test("deltaSummary is a non-empty string", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const result = await session.reReview(UPDATED_DIFF);
    expect(typeof result.deltaSummary).toBe("string");
    expect((result.deltaSummary as string).length).toBeGreaterThan(0);
    await session.destroy();
  });

  test("deltaSummary describes resolved findings", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const result = await session.reReview(UPDATED_DIFF);
    // deltaSummary should mention either "resolved" or "still present" or similar language
    const summary = result.deltaSummary as string;
    const lowerSummary = summary.toLowerCase();
    expect(
      lowerSummary.includes("resolved") || lowerSummary.includes("fixed") || lowerSummary.includes("addressed")
      || lowerSummary.includes("still") || lowerSummary.includes("outstanding") || lowerSummary.includes("remaining"),
    ).toBe(true);
    await session.destroy();
  });

  test("returns ReviewDialogueResult with checkResult.success", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const result = await session.reReview(UPDATED_DIFF);
    expect(typeof result.checkResult.success).toBe("boolean");
    await session.destroy();
  });

  test("returns ReviewDialogueResult with checkResult.findings as array", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const result = await session.reReview(UPDATED_DIFF);
    expect(Array.isArray(result.checkResult.findings)).toBe(true);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC3 — reReview() appends exactly two DialogueMessage entries to history
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReview() — history entries", () => {
  test("appends exactly two entries to history per reReview() call", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const historyLenBefore = session.history.length; // 2 after initial review
    await session.reReview(UPDATED_DIFF);
    expect(session.history.length).toBe(historyLenBefore + 2);
    await session.destroy();
  });

  test("reReview appended entry at n has role 'implementer'", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const prevLen = session.history.length;
    await session.reReview(UPDATED_DIFF);
    const entry = session.history[prevLen];
    expect(entry?.role).toBe("implementer");
    await session.destroy();
  });

  test("reReview appended entry at n+1 has role 'reviewer'", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const prevLen = session.history.length;
    await session.reReview(UPDATED_DIFF);
    const entry = session.history[prevLen + 1];
    expect(entry?.role).toBe("reviewer");
    await session.destroy();
  });

  test("implementer entry content contains the updated diff", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const prevLen = session.history.length;
    await session.reReview(UPDATED_DIFF);
    expect(session.history[prevLen]?.content).toContain(UPDATED_DIFF);
    await session.destroy();
  });

  test("reviewer entry content is non-empty", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    const prevLen = session.history.length;
    await session.reReview(UPDATED_DIFF);
    expect((session.history[prevLen + 1]?.content ?? "").length).toBeGreaterThan(0);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC4 — Session compaction when history.length exceeds maxDialogueMessages
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReview() — session compaction", () => {
  /**
   * To trigger compaction we need history to exceed maxDialogueMessages (default: 20).
   * We create a config with maxDialogueMessages: 5 so it's easier to trigger.
   * We perform 2 reviews (4 entries) then 1 reReview — total would be 6, exceeding 5.
   */

  function makeSmallDialogueConfig(): NaxConfig {
    const base = NaxConfigSchema.parse({}) as unknown as { review: Record<string, unknown> };
    return NaxConfigSchema.parse({
      ...base,
      review: {
        ...base.review,
        dialogue: {
          enabled: true,
          maxClarificationsPerAttempt: 2,
          maxDialogueMessages: 5,
        },
      },
    }) as unknown as NaxConfig;
  }

  test("session remains active after compaction", async () => {
    const config = makeSmallDialogueConfig();
    let callIndex = 0;
    const responses = [
      INITIAL_FAILING_RESPONSE, // review #1
      INITIAL_FAILING_RESPONSE, // review #2
      RE_REVIEW_RESPONSE,       // reReview #1 — triggers compaction (would be 6th entry)
    ];
    const runFn: RunAsSessionFnType = async () => ({
      output: responses[callIndex++] ?? INITIAL_PASSING_RESPONSE,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    });
    const agentManager = makeAgentManager(runFn);
    const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", config);

    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    // At this point history.length === 4; adding 2 more via reReview() → 6 > 5 → compaction
    await session.reReview(UPDATED_DIFF);

    expect(session.active).toBe(true);
    await session.destroy();
  });

  test("after compaction, history.length is less than or equal to maxDialogueMessages", async () => {
    const config = makeSmallDialogueConfig();
    let callIndex = 0;
    const responses = [
      INITIAL_FAILING_RESPONSE,
      INITIAL_FAILING_RESPONSE,
      RE_REVIEW_RESPONSE,
    ];
    const runFn: RunAsSessionFnType = async () => ({
      output: responses[callIndex++] ?? INITIAL_PASSING_RESPONSE,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    });
    const agentManager = makeAgentManager(runFn);
    const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", config);

    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.reReview(UPDATED_DIFF);

    // After compaction, history should be reset and repopulated with compact summary + new exchange
    expect(session.history.length).toBeLessThanOrEqual(5);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC5 — clarify() sends question as follow-up and returns raw response string
// ---------------------------------------------------------------------------

describe("ReviewerSession.clarify() — agentManager.runAsSession() call and return value (ADR-019)", () => {
  let capturedPrompt: string | undefined;
  let capturedOpts: RunAsSessionOpts | undefined;
  let session: ReviewerSession;

  beforeEach(async () => {
    capturedPrompt = undefined;
    capturedOpts = undefined;
    let callIndex = 0;
    const responses = [INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE];
    const runFn: RunAsSessionFnType = async (_agentName, _handle, prompt, opts) => {
      capturedPrompt = prompt;
      capturedOpts = opts;
      const output = responses[callIndex] ?? "";
      callIndex++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    };
    const agentManager = makeAgentManager(runFn);
    session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    capturedPrompt = undefined;
    capturedOpts = undefined;
  });

  afterEach(async () => {
    if (session.active) await session.destroy();
    mock.restore();
  });

  test("returns a string", async () => {
    const result = await session.clarify("What does AC-1 require exactly?");
    expect(typeof result).toBe("string");
  });

  test("returns the raw agent response string", async () => {
    const result = await session.clarify("What does AC-1 require exactly?");
    expect(result).toBe(CLARIFY_RESPONSE);
  });

  test("calls agentManager.runAsSession() with pipelineStage: 'review'", async () => {
    await session.clarify("What does AC-1 require exactly?");
    expect(capturedOpts?.pipelineStage).toBe("review");
  });

  test("prompt contains the clarification question", async () => {
    const question = "What does AC-1 require exactly?";
    await session.clarify(question);
    expect(capturedPrompt).toContain(question);
  });
});

// ---------------------------------------------------------------------------
// AC6 — clarify() appends two DialogueMessage entries with correct roles
// ---------------------------------------------------------------------------

describe("ReviewerSession.clarify() — history entries", () => {
  test("appends exactly two entries to history per clarify() call", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE]);
    const prevLen = session.history.length;
    await session.clarify("What does AC-1 require?");
    expect(session.history.length).toBe(prevLen + 2);
    await session.destroy();
  });

  test("first appended entry has role 'implementer'", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE]);
    const prevLen = session.history.length;
    await session.clarify("What does AC-1 require?");
    expect(session.history[prevLen]?.role).toBe("implementer");
    await session.destroy();
  });

  test("second appended entry has role 'reviewer'", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE]);
    const prevLen = session.history.length;
    await session.clarify("What does AC-1 require?");
    expect(session.history[prevLen + 1]?.role).toBe("reviewer");
    await session.destroy();
  });

  test("implementer entry content contains the question", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE]);
    const prevLen = session.history.length;
    const question = "What does AC-1 require?";
    await session.clarify(question);
    expect(session.history[prevLen]?.content).toContain(question);
    await session.destroy();
  });

  test("reviewer entry content equals the raw response", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, CLARIFY_RESPONSE]);
    const prevLen = session.history.length;
    await session.clarify("What does AC-1 require?");
    expect(session.history[prevLen + 1]?.content).toBe(CLARIFY_RESPONSE);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC7 — getVerdict() returns SemanticVerdict with correct fields
// ---------------------------------------------------------------------------

describe("ReviewerSession.getVerdict() — SemanticVerdict fields", () => {
  test("returns an object with storyId matching the session storyId", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(verdict.storyId).toBe("US-002");
    await session.destroy();
  });

  test("passed reflects last checkResult.success (false for failing review)", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(verdict.passed).toBe(false);
    await session.destroy();
  });

  test("passed reflects last checkResult.success (true for passing review)", async () => {
    const session = await makeSessionWithReview([INITIAL_PASSING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(verdict.passed).toBe(true);
    await session.destroy();
  });

  test("timestamp is a valid ISO 8601 string", async () => {
    const session = await makeSessionWithReview([INITIAL_PASSING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(typeof verdict.timestamp).toBe("string");
    expect(() => new Date(verdict.timestamp)).not.toThrow();
    expect(new Date(verdict.timestamp).toISOString()).toBe(verdict.timestamp);
    await session.destroy();
  });

  test("acCount is a non-negative integer", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(typeof verdict.acCount).toBe("number");
    expect(Number.isInteger(verdict.acCount)).toBe(true);
    expect(verdict.acCount).toBeGreaterThanOrEqual(0);
    await session.destroy();
  });

  test("acCount matches the number of acceptance criteria in the story", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(verdict.acCount).toBe(STORY.acceptanceCriteria.length);
    await session.destroy();
  });

  test("findings array matches last checkResult.findings", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(Array.isArray(verdict.findings)).toBe(true);
    expect(verdict.findings.length).toBe(2);
    expect(verdict.findings[0]?.rule).toBe("AC-1-not-satisfied");
    await session.destroy();
  });

  test("findings is empty array for passing review", async () => {
    const session = await makeSessionWithReview([INITIAL_PASSING_RESPONSE]);
    const verdict = session.getVerdict();
    expect(verdict.findings).toEqual([]);
    await session.destroy();
  });

  test("getVerdict() after reReview() reflects the latest checkResult", async () => {
    const session = await makeSessionWithReview([INITIAL_FAILING_RESPONSE, RE_REVIEW_RESPONSE]);
    await session.reReview(UPDATED_DIFF);
    const verdict = session.getVerdict();
    // RE_REVIEW_RESPONSE has 1 finding (AC-2-not-satisfied only)
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.length).toBe(1);
    expect(verdict.findings[0]?.rule).toBe("AC-2-not-satisfied");
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC8 — getVerdict() throws NaxError 'NO_REVIEW_RESULT' before any review()
// ---------------------------------------------------------------------------

describe("ReviewerSession.getVerdict() — NO_REVIEW_RESULT guard", () => {
  test("throws NaxError when called before any review()", () => {
    const agentManager = makeAgentManager();
    const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
    expect(() => session.getVerdict()).toThrow(NaxError);
  });

  test("throws NaxError with code 'NO_REVIEW_RESULT' when called before any review()", () => {
    const agentManager = makeAgentManager();
    const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
    let caught: unknown;
    try {
      session.getVerdict();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("NO_REVIEW_RESULT");
  });

  test("does not throw after a successful review()", async () => {
    const agentManager = makeAgentManager();
    const session = createReviewerSession(agentManager, makeSessionManager(), "US-002", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(() => session.getVerdict()).not.toThrow();
    await session.destroy();
  });
});
