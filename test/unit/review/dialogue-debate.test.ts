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
import type { AgentAdapter, AgentRunOptions, AgentResult } from "../../../src/agents/types";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { NaxError } from "../../../src/errors";

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
  modelTier: "balanced",
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

type RunFn = (opts: AgentRunOptions) => Promise<AgentResult>;

function makeRunFn(response: string, cost = 0.001): RunFn {
  return mock(async (_opts: AgentRunOptions): Promise<AgentResult> => ({
    output: response,
    exitCode: 0,
    success: true,
    rateLimited: false,
    durationMs: 100,
    estimatedCost: cost,
  }));
}

function makeAdapter(runFn: RunFn): AgentAdapter {
  return {
    run: runFn,
    complete: mock(async () => ({ output: "", exitCode: 0 })),
    plan: mock(async () => ({ specContent: "" })),
    decompose: mock(async () => ({ stories: [] })),
  } as unknown as AgentAdapter;
}

const MOCK_CONFIG = {
  autoMode: { defaultAgent: "claude" },
  models: { claude: { fast: { model: "claude-haiku-4-5-20251001" }, balanced: { model: "claude-sonnet-4-6" }, powerful: { model: "claude-opus-4-6" } } },
  execution: { sessionTimeoutSeconds: 3600 },
  review: { dialogue: { enabled: true, maxClarificationsPerAttempt: 3, maxDialogueMessages: 20 } },
} as unknown as import("../../../src/config").NaxConfig;

// ---------------------------------------------------------------------------
// resolveDebate() — core behavior
// ---------------------------------------------------------------------------

describe("ReviewerSession.resolveDebate()", () => {
  test("calls agent.run() with keepSessionOpen: true and sessionRole: reviewer", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAdapter(runFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(runFn).toHaveBeenCalledTimes(1);
    const opts = (runFn as ReturnType<typeof mock>).mock.calls[0][0] as AgentRunOptions;
    expect(opts.keepSessionOpen).toBe(true);
    expect(opts.sessionRole).toBe("reviewer");
    expect(opts.pipelineStage).toBe("review");
  });

  test("parses JSON response into ReviewDialogueResult (passing)", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(result.checkResult.success).toBe(true);
    expect(result.checkResult.findings).toHaveLength(0);
  });

  test("parses JSON response into ReviewDialogueResult (failing with findings)", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(FAILING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(result.checkResult.success).toBe(false);
    expect(result.checkResult.findings).toHaveLength(1);
    expect(result.checkResult.findings[0].ruleId).toBe("ac-gap");
    expect(result.findingReasoning.get("ac-gap")).toBe("The code does not satisfy AC-1");
  });

  test("captures LLM cost", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE, 0.005)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const result = await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(result.cost).toBe(0.005);
  });

  test("appends exactly 2 history entries (implementer prompt + reviewer response)", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    expect(session.history).toHaveLength(2);
    expect(session.history[0].role).toBe("implementer");
    expect(session.history[1].role).toBe("reviewer");
  });

  test("stores lastCheckResult so getVerdict() works", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // getVerdict() should not throw
    const verdict = session.getVerdict();
    expect(verdict.passed).toBe(true);
    expect(verdict.storyId).toBe("story-1");
  });

  test("throws REVIEWER_SESSION_DESTROYED when session is inactive", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
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
    const session = createReviewerSession(makeAdapter(runFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const opts = (runFn as ReturnType<typeof mock>).mock.calls[0][0] as AgentRunOptions;
    expect(opts.prompt.toLowerCase()).toContain("synthes");
  });

  test("custom: prompt contains 'judge'", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAdapter(runFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "custom" };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const opts = (runFn as ReturnType<typeof mock>).mock.calls[0][0] as AgentRunOptions;
    expect(opts.prompt.toLowerCase()).toContain("judge");
  });

  test("majority-fail-closed: prompt contains vote tally", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAdapter(runFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-closed",
      majorityVote: { passed: false, passCount: 1, failCount: 1 },
    };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const opts = (runFn as ReturnType<typeof mock>).mock.calls[0][0] as AgentRunOptions;
    expect(opts.prompt).toContain("1 passed");
    expect(opts.prompt).toContain("1 failed");
  });

  test("majority-fail-open: prompt contains vote tally", async () => {
    const runFn = makeRunFn(PASSING_RESPONSE);
    const session = createReviewerSession(makeAdapter(runFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-open",
      majorityVote: { passed: true, passCount: 2, failCount: 0 },
    };
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);

    const opts = (runFn as ReturnType<typeof mock>).mock.calls[0][0] as AgentRunOptions;
    expect(opts.prompt).toContain("2 passed");
  });
});

// ---------------------------------------------------------------------------
// reReviewDebate()
// ---------------------------------------------------------------------------

describe("ReviewerSession.reReviewDebate()", () => {
  test("throws NO_REVIEW_RESULT when called before any resolveDebate()", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("throws NO_REVIEW_RESULT when called after review() but not resolveDebate() (prevents wrong delta baseline)", async () => {
    // review() sets lastCheckResult/lastSemanticConfig but lastWasDebateResolve stays false —
    // reReviewDebate() must not accept non-debate findings as the delta baseline.
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    await session.review(DIFF, STORY, SEMANTIC_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("throws REVIEWER_SESSION_DESTROYED when session is inactive", async () => {
    const session = createReviewerSession(makeAdapter(makeRunFn(PASSING_RESPONSE)), "story-1", "/workdir", "feature", MOCK_CONFIG);
    await session.destroy();
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await expect(session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx)).rejects.toBeInstanceOf(NaxError);
  });

  test("references previous findings in prompt", async () => {
    // Second call returns passing
    let callCount = 0;
    const multiRunFn: RunFn = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, exitCode: 0, success: true, rateLimited: false, durationMs: 100, estimatedCost: 0.001 };
    });

    const session = createReviewerSession(makeAdapter(multiRunFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    // First: resolveDebate with failing result
    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // Second: reReviewDebate — prompt should reference "ac-gap"
    await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    const secondCallOpts = (multiRunFn as ReturnType<typeof mock>).mock.calls[1][0] as AgentRunOptions;
    expect(secondCallOpts.prompt).toContain("ac-gap");
  });

  test("returns ReviewDialogueResult with deltaSummary", async () => {
    let callCount = 0;
    const multiRunFn: RunFn = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, exitCode: 0, success: true, rateLimited: false, durationMs: 100, estimatedCost: 0.001 };
    });

    const session = createReviewerSession(makeAdapter(multiRunFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    const result = await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    expect(result.checkResult.success).toBe(true);
    expect(result.deltaSummary).toBeDefined();
    expect(result.deltaSummary).toContain("ac-gap");
  });

  test("appends 2 more history entries", async () => {
    let callCount = 0;
    const multiRunFn: RunFn = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, exitCode: 0, success: true, rateLimited: false, durationMs: 100, estimatedCost: 0.001 };
    });

    const session = createReviewerSession(makeAdapter(multiRunFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    await session.reReviewDebate(PROPOSALS, CRITIQUES, DIFF, ctx);

    expect(session.history).toHaveLength(4);
  });

  test("triggers history compaction when history exceeds maxDialogueMessages", async () => {
    const smallMaxConfig = {
      ...MOCK_CONFIG,
      review: { dialogue: { enabled: true, maxClarificationsPerAttempt: 3, maxDialogueMessages: 2 } },
    } as unknown as import("../../../src/config").NaxConfig;

    let callCount = 0;
    const multiRunFn: RunFn = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => {
      callCount++;
      return { output: callCount === 1 ? FAILING_RESPONSE : REREVIEW_RESPONSE, exitCode: 0, success: true, rateLimited: false, durationMs: 100, estimatedCost: 0.001 };
    });

    const session = createReviewerSession(makeAdapter(multiRunFn), "story-1", "/workdir", "feature", smallMaxConfig);
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
    const multiRunFn: RunFn = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => {
      callCount++;
      return {
        output: callCount === 1 ? PASSING_RESPONSE : "The finding means X needs to be implemented.",
        exitCode: 0,
        success: true,
        rateLimited: false,
        durationMs: 100,
        estimatedCost: 0.001,
      };
    });

    const session = createReviewerSession(makeAdapter(multiRunFn), "story-1", "/workdir", "feature", MOCK_CONFIG);
    const ctx: DebateResolverContext = { resolverType: "synthesis" };

    await session.resolveDebate(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    const clarification = await session.clarify("What does finding ac-gap mean?");

    expect(clarification).toContain("X needs to be implemented");
    expect(session.history).toHaveLength(4);
  });
});
