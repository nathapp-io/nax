/**
 * Unit tests for resolveDebate() and reReviewDebate() on ReviewerSession
 *
 * Covers US-001 acceptance criteria:
 * - resolveDebate() calls agent.run() with correct prompt for each resolver type
 * - resolveDebate() parses JSON response into ReviewDialogueResult
 * - resolveDebate() appends to history
 * - resolveDebate() stores lastCheckResult (enabling getVerdict + reReviewDebate)
 * - resolveDebate() includes majorityVote in prompt when provided
 * - reReviewDebate() references previous findings
 * - reReviewDebate() triggers history compaction at maxDialogueMessages
 * - resolveDebate() throws REVIEWER_SESSION_DESTROYED when session inactive
 * - reReviewDebate() throws NO_REVIEW_RESULT before any resolveDebate()
 * - clarify() works after resolveDebate()
 * - getVerdict() works after resolveDebate()
 */

import { describe, expect, mock, test } from "bun:test";
import { createReviewerSession } from "../../../src/review/dialogue";
import type { DebateResolverContext } from "../../../src/debate/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { RunAsSessionOpts } from "../../../src/agents/manager-types";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { ReviewConfig } from "../../../src/config/selectors";
import { NaxError } from "../../../src/errors";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Wire debate resolver to ReviewerSession",
  description: "resolveDebate() and reReviewDebate() are called instead of stateless resolvers",
  acceptanceCriteria: ["AC-1: resolveDebate passes", "AC-2: reReviewDebate references prior findings"],
};

const SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [],
};

const DIFF = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}";

const PROPOSALS: Array<{ debater: string; output: string }> = [
  { debater: "claude", output: '{"passed": false, "findings": [{"ruleId":"r1","severity":"error","file":"f","line":1,"message":"m"}]}' },
  { debater: "opencode", output: '{"passed": true, "findings": []}' },
];

const CRITIQUES = ["Proposal 1 missed X"];

const PASSING_RESPONSE = JSON.stringify({
  passed: true,
  findings: [],
  findingReasoning: {},
});

const FAILING_RESPONSE = JSON.stringify({
  passed: false,
  findings: [{ ruleId: "ac-gap", severity: "error", file: "src/foo.ts", line: 1, message: "AC-1 not met" }],
  findingReasoning: { "ac-gap": "The code does not satisfy AC-1" },
});

const REREVIEW_RESPONSE = JSON.stringify({
  passed: true,
  findings: [],
  findingReasoning: {},
  deltaSummary: "ac-gap is now resolved",
});

type RunAsSessionFnType = (agentName: string, handle: SessionHandle, prompt: string, opts: RunAsSessionOpts) => Promise<TurnResult>;

function makeRunFn(response: string, cost = 0.001): RunAsSessionFnType {
  return mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => ({
    output: response,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: cost ,
    internalRoundTrips: 0,
  }));
}

function makeAgentManager(runAsSessionFn: RunAsSessionFnType): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runAsSessionFn,
    completeFn: async () => ({ output: "", costUsd: 0, source: "mock" as const }),
  });
}

const MOCK_CONFIG = {
  models: { claude: { fast: { model: "claude-haiku-4-5-20251001" }, balanced: { model: "claude-sonnet-4-6" }, powerful: { model: "claude-opus-4-6" } } },
  execution: { sessionTimeoutSeconds: 3600 },
  review: { dialogue: { enabled: true, maxClarificationsPerAttempt: 3, maxDialogueMessages: 20 } },
} as unknown as ReviewConfig;

// ---------------------------------------------------------------------------
// resolveDebate() — core behavior
// ---------------------------------------------------------------------------

describe("ReviewerSession.resolveDebate()", () => {
  test("calls agentManager.runAsSession() with pipelineStage: review (ADR-019)", async () => {
    let capturedOpts: RunAsSessionOpts | undefined;
    const runFn = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, opts: RunAsSessionOpts): Promise<TurnResult> => {
      capturedOpts = opts;
      return { output: PASSING_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });
    const session = createReviewerSession(makeAgentManager(runFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(capturedOpts?.pipelineStage).toBe("review");
    await session.destroy();
  });

  test("parses JSON response into ReviewDialogueResult (passing)", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(result.checkResult.success).toBe(true);
    expect(result.checkResult.findings).toHaveLength(0);
  });

  test("parses JSON response into ReviewDialogueResult (failing with findings)", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(FAILING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(result.checkResult.success).toBe(false);
    expect(result.checkResult.findings).toHaveLength(1);
    expect(result.checkResult.findings[0].ruleId).toBe("ac-gap");
    expect(result.findingReasoning.get("ac-gap")).toBe("The code does not satisfy AC-1");
  });

  test("captures LLM cost", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE, 0.005)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(result.cost).toBe(0.005);
  });

  test("appends exactly 2 history entries (implementer prompt + reviewer response)", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(session.history).toHaveLength(2);
    expect(session.history[0].role).toBe("implementer");
    expect(session.history[1].role).toBe("reviewer");
  });

  test("stores lastCheckResult so getVerdict() works", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // getVerdict() should not throw
    const verdict = session.getVerdict();
    expect(verdict.passed).toBe(true);
    expect(verdict.storyId).toBe("story-1");
  });

  test("throws REVIEWER_SESSION_DESTROYED when session is inactive", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    await session.destroy();
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx)).rejects.toBeInstanceOf(NaxError);
  });
});

// ---------------------------------------------------------------------------
// resolveDebate() — resolver type prompt framing
// ---------------------------------------------------------------------------

describe("resolveDebate() prompt framing by resolver type", () => {
  test("synthesis: prompt contains 'synthes'", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAgentManager(runFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const prompt = (runFn as ReturnType<typeof mock>).mock.calls[0][2] as string;
    expect(prompt.toLowerCase()).toContain("synthes");
    await session.destroy();
  });

  test("custom: prompt contains 'judge'", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAgentManager(runFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "custom" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const prompt = (runFn as ReturnType<typeof mock>).mock.calls[0][2] as string;
    expect(prompt.toLowerCase()).toContain("judge");
    await session.destroy();
  });

  test("majority-fail-closed: prompt contains vote tally", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAgentManager(runFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-closed",
      majorityVote: { passed: false, passCount: 1, failCount: 1 },
    };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const prompt = (runFn as ReturnType<typeof mock>).mock.calls[0][2] as string;
    expect(prompt).toContain("1 passed");
    expect(prompt).toContain("1 failed");
    await session.destroy();
  });

  test("majority-fail-open: prompt contains vote tally", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAgentManager(runFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-open",
      majorityVote: { passed: true, passCount: 2, failCount: 0 },
    };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const prompt = (runFn as ReturnType<typeof mock>).mock.calls[0][2] as string;
    expect(prompt).toContain("2 passed");
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// reReviewDebate()
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReviewDebate()", () => {
  test("throws NO_REVIEW_RESULT when called before any resolveDebate()", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("throws NO_REVIEW_RESULT when called after review() but not resolveDebate() (prevents wrong delta baseline)", async () => {
    // review() sets lastCheckResult/lastSemanticConfig but lastWasDebateResolve stays false —
    // reReviewDebate() must not accept non-debate findings as the delta baseline.
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    await session.review(DIFF, STORY, SEMANTIC_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("throws REVIEWER_SESSION_DESTROYED when session is inactive", async () => {
    const session = createReviewerSession(makeAgentManager(makeRunFn(PASSING_RESPONSE)), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    await session.destroy();
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("references previous findings in prompt", async () => {
    // Second call returns passing
    let callCount = 0;
    const multiRunFn: RunAsSessionFnType = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const session = createReviewerSession(makeAgentManager(multiRunFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    // First: resolveDebate with failing result
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // Second: reReviewDebate — prompt should reference "ac-gap"
    await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    const secondCallPrompt = (multiRunFn as ReturnType<typeof mock>).mock.calls[1][2] as string;
    expect(secondCallPrompt).toContain("ac-gap");
  });

  test("returns ReviewDialogueResult with deltaSummary", async () => {
    let callCount = 0;
    const multiRunFn: RunAsSessionFnType = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const session = createReviewerSession(makeAgentManager(multiRunFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    const result = await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    expect(result.checkResult.success).toBe(true);
    expect(result.deltaSummary).toBeDefined();
    expect(result.deltaSummary).toContain("ac-gap");
  });

  test("appends 2 more history entries", async () => {
    let callCount = 0;
    const multiRunFn: RunAsSessionFnType = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const session = createReviewerSession(makeAgentManager(multiRunFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    expect(session.history).toHaveLength(4);
  });

  test("triggers history compaction when history exceeds maxDialogueMessages", async () => {
    const smallMaxConfig = {
      ...MOCK_CONFIG,
      review: { dialogue: { enabled: true, maxClarificationsPerAttempt: 3, maxDialogueMessages: 2 } },
    } as unknown as ReviewConfig;

    let callCount = 0;
    const multiRunFn: RunAsSessionFnType = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const session = createReviewerSession(makeAgentManager(multiRunFn), makeSessionManager(), "story-1", "/workdir", "feature", smallMaxConfig);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // After this call history will be 2; reReviewDebate adds 2 more (>maxDialogueMessages=2)
    // → compaction should fire, reducing history length
    await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    // After compaction, history length should be ≤ 3 (compacted summary + last 2 messages)
    expect(session.history.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// clarify() works after resolveDebate()
// ---------------------------------------------------------------------------

describe("clarify() after resolveDebate()", () => {
  test("can clarify after resolveDebate without error", async () => {
    let callCount = 0;
    const multiRunFn: RunAsSessionFnType = mock(async (_agentName: string, _handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts): Promise<TurnResult> => {
      callCount++;
      return {
        output: callCount === 1 ? PASSING_RESPONSE : "The finding means X needs to be implemented.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      };
    });

    const session = createReviewerSession(makeAgentManager(multiRunFn), makeSessionManager(), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    const clarification = await session.clarify("What does finding ac-gap mean?");

    expect(clarification).toContain("X needs to be implemented");
    expect(session.history).toHaveLength(4);
  });
});
