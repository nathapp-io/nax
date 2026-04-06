/**
 * Unit tests for src/review/dialogue.ts
 *
 * Tests cover (US-001):
 * AC1 — ReviewDialogueConfigSchema fields and defaults
 * AC2 — ReviewConfigSchema includes dialogue; DEFAULT_CONFIG.review.dialogue.enabled === false
 * AC3 — ReviewConfig interface includes dialogue? (compile-time check)
 * AC4 — createReviewerSession returns active session with empty history
 * AC5 — review() calls agent.run() with sessionRole='reviewer', keepSessionOpen=true, pipelineStage='review'
 * AC6 — review() parses JSON into ReviewDialogueResult (checkResult + findingReasoning Map)
 * AC7 — review() appends exactly two DialogueMessage entries to history
 * AC8 — destroy() deactivates session; subsequent review() throws NaxError REVIEWER_SESSION_DESTROYED
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ReviewDialogueConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { createReviewerSession } from "../../../src/review/dialogue";
import type { DialogueMessage, ReviewDialogueResult, ReviewerSession } from "../../../src/review/dialogue";
import type { ReviewConfig } from "../../../src/review/types";
import type { AgentAdapter, AgentRunOptions, AgentResult } from "../../../src/agents/types";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/semantic";
import { NaxError } from "../../../src/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-001",
  title: "Config schema + ReviewerSession core",
  description: "Add ReviewDialogueConfig and implement ReviewerSession",
  acceptanceCriteria: [
    "createReviewerSession returns active session",
    "review() calls agent.run() with keepSessionOpen: true",
  ],
};

const SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const SAMPLE_DIFF = "diff --git a/src/review/dialogue.ts b/src/review/dialogue.ts\n+export function foo() {}";

/**
 * JSON output that agent.run() returns for a passing review.
 * findingReasoning is an object mapping finding identifiers to reasoning.
 */
const PASSING_RUN_RESPONSE = JSON.stringify({
  passed: true,
  findings: [],
  findingReasoning: {},
});

/**
 * JSON output that agent.run() returns for a failing review with findings.
 */
const FAILING_RUN_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      ruleId: "missing-ac-coverage",
      severity: "error",
      file: "src/review/dialogue.ts",
      line: 1,
      message: "AC1 not satisfied",
    },
  ],
  findingReasoning: {
    "missing-ac-coverage": "The implementation does not cover acceptance criteria 1",
  },
});

type RunFn = (opts: AgentRunOptions) => Promise<AgentResult>;

function makeMockAgent(runFn?: RunFn): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: mock(async () => true),
    run:
      runFn ??
      mock(async () => ({
        success: true,
        exitCode: 0,
        output: PASSING_RUN_RESPONSE,
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0.001,
      })),
    buildCommand: mock(() => []),
    plan: mock(async () => ({ specContent: "" })),
    decompose: mock(async () => ({ stories: [] })),
    complete: mock(async () => ({ output: "", costUsd: 0, source: "fallback" as const })),
  } as unknown as AgentAdapter;
}

function makeConfig() {
  return NaxConfigSchema.parse({}) as ReturnType<typeof NaxConfigSchema.parse>;
}

// ---------------------------------------------------------------------------
// AC1 — ReviewDialogueConfigSchema fields and defaults
// ---------------------------------------------------------------------------

describe("ReviewDialogueConfigSchema — field definitions and defaults", () => {
  test("is exported from src/config/schemas.ts", () => {
    expect(ReviewDialogueConfigSchema).toBeDefined();
  });

  test("default parse produces enabled: false", () => {
    const result = ReviewDialogueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).enabled).toBe(false);
  });

  test("default parse produces maxClarificationsPerAttempt: 2", () => {
    const result = ReviewDialogueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxClarificationsPerAttempt).toBe(2);
  });

  test("default parse produces maxDialogueMessages: 20", () => {
    const result = ReviewDialogueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxDialogueMessages).toBe(20);
  });

  test("enabled accepts boolean true", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).enabled).toBe(true);
  });

  test("maxClarificationsPerAttempt rejects value below 0", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: -1 });
    expect(result.success).toBe(false);
  });

  test("maxClarificationsPerAttempt rejects value above 10", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: 11 });
    expect(result.success).toBe(false);
  });

  test("maxClarificationsPerAttempt accepts boundary value 0", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: 0 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxClarificationsPerAttempt).toBe(0);
  });

  test("maxClarificationsPerAttempt accepts boundary value 10", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: 10 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxClarificationsPerAttempt).toBe(10);
  });

  test("maxDialogueMessages rejects value below 5", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 4 });
    expect(result.success).toBe(false);
  });

  test("maxDialogueMessages rejects value above 100", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 101 });
    expect(result.success).toBe(false);
  });

  test("maxDialogueMessages accepts boundary value 5", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 5 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxDialogueMessages).toBe(5);
  });

  test("maxDialogueMessages accepts boundary value 100", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 100 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).maxDialogueMessages).toBe(100);
  });

  test("maxClarificationsPerAttempt rejects non-integer float", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: 1.5 });
    expect(result.success).toBe(false);
  });

  test("maxDialogueMessages rejects non-integer float", () => {
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 10.5 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — ReviewConfigSchema includes dialogue; DEFAULT_CONFIG resolved correctly
// ---------------------------------------------------------------------------

describe("ReviewConfigSchema — dialogue field integration", () => {
  test("DEFAULT_CONFIG.review.dialogue exists", () => {
    const review = (DEFAULT_CONFIG as unknown as { review: Record<string, unknown> }).review;
    expect(review.dialogue).toBeDefined();
  });

  test("DEFAULT_CONFIG.review.dialogue.enabled resolves to false", () => {
    const review = (DEFAULT_CONFIG as unknown as { review: Record<string, unknown> }).review;
    const dialogue = review.dialogue as Record<string, unknown>;
    expect(dialogue.enabled).toBe(false);
  });

  test("DEFAULT_CONFIG.review.dialogue.maxClarificationsPerAttempt resolves to 2", () => {
    const review = (DEFAULT_CONFIG as unknown as { review: Record<string, unknown> }).review;
    const dialogue = review.dialogue as Record<string, unknown>;
    expect(dialogue.maxClarificationsPerAttempt).toBe(2);
  });

  test("DEFAULT_CONFIG.review.dialogue.maxDialogueMessages resolves to 20", () => {
    const review = (DEFAULT_CONFIG as unknown as { review: Record<string, unknown> }).review;
    const dialogue = review.dialogue as Record<string, unknown>;
    expect(dialogue.maxDialogueMessages).toBe(20);
  });

  test("NaxConfigSchema.safeParse accepts dialogue override", () => {
    const base = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const input = {
      ...base,
      review: {
        ...(base.review as Record<string, unknown>),
        dialogue: { enabled: true, maxClarificationsPerAttempt: 3, maxDialogueMessages: 30 },
      },
    };
    const result = NaxConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const dialogue = (result.data as unknown as { review: { dialogue: Record<string, unknown> } }).review.dialogue;
    expect(dialogue.enabled).toBe(true);
    expect(dialogue.maxClarificationsPerAttempt).toBe(3);
    expect(dialogue.maxDialogueMessages).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// AC3 — ReviewConfig interface includes dialogue? (compile-time check)
// ---------------------------------------------------------------------------

describe("ReviewConfig — dialogue field type compatibility", () => {
  test("ReviewConfig accepts object with dialogue field (compile check)", () => {
    // If this compiles, the interface is correctly extended.
    const config: ReviewConfig = {
      enabled: true,
      checks: ["semantic"],
      commands: {},
      dialogue: {
        enabled: false,
        maxClarificationsPerAttempt: 2,
        maxDialogueMessages: 20,
      },
    };
    expect(config.dialogue).toBeDefined();
    expect(config.dialogue?.enabled).toBe(false);
  });

  test("ReviewConfig.dialogue is optional — omitting it is valid", () => {
    const config: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };
    expect(config.dialogue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 — createReviewerSession returns active session with empty history
// ---------------------------------------------------------------------------

describe("createReviewerSession — initial state", () => {
  test("returns a ReviewerSession object", () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    expect(session).toBeDefined();
  });

  test("session.active is true after creation", () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    expect(session.active).toBe(true);
  });

  test("session.history is empty after creation", () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    expect(session.history.length).toBe(0);
  });

  test("session exposes review() method", () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    expect(typeof session.review).toBe("function");
  });

  test("session exposes destroy() method", () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    expect(typeof session.destroy).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC5 — review() calls agent.run() with sessionRole='reviewer', keepSessionOpen=true, pipelineStage='review'
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — agent.run() call parameters", () => {
  let capturedOpts: AgentRunOptions | undefined;
  let session: ReviewerSession;

  beforeEach(() => {
    capturedOpts = undefined;
    const runFn: RunFn = async (opts) => {
      capturedOpts = opts;
      return {
        success: true,
        exitCode: 0,
        output: PASSING_RUN_RESPONSE,
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0.001,
      };
    };
    session = createReviewerSession(makeMockAgent(runFn), "US-001", "/work", "my-feature", makeConfig());
  });

  afterEach(async () => {
    if (session.active) await session.destroy();
    mock.restore();
  });

  test("calls agent.run() exactly once per review() call", async () => {
    const runMock = mock(async (_opts: AgentRunOptions): Promise<AgentResult> => ({
      success: true,
      exitCode: 0,
      output: PASSING_RUN_RESPONSE,
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    }));
    const agent = makeMockAgent(runMock as RunFn);
    const s = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await s.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect((runMock as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    await s.destroy();
  });

  test("passes sessionRole: 'reviewer' to agent.run()", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.sessionRole).toBe("reviewer");
  });

  test("passes keepSessionOpen: true to agent.run()", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.keepSessionOpen).toBe(true);
  });

  test("passes pipelineStage: 'review' to agent.run()", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.pipelineStage).toBe("review");
  });

  test("prompt passed to agent.run() contains the diff", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.prompt).toContain(SAMPLE_DIFF);
  });

  test("prompt passed to agent.run() contains the story id", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.prompt).toContain(STORY.id);
  });

  test("prompt passed to agent.run() contains at least one acceptance criterion", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.prompt).toContain(STORY.acceptanceCriteria[0]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — review() parses JSON into ReviewDialogueResult (checkResult + findingReasoning Map)
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — result parsing", () => {
  test("returns ReviewDialogueResult with checkResult.success === true for passing response", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.checkResult.success).toBe(true);
    await session.destroy();
  });

  test("returns ReviewDialogueResult with checkResult.findings as array for passing response", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(Array.isArray(result.checkResult.findings)).toBe(true);
    expect(result.checkResult.findings.length).toBe(0);
    await session.destroy();
  });

  test("returns ReviewDialogueResult with findingReasoning as Map for passing response", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.findingReasoning instanceof Map).toBe(true);
    await session.destroy();
  });

  test("parses failing response: checkResult.success === false", async () => {
    const runFn: RunFn = async () => ({
      success: true,
      exitCode: 0,
      output: FAILING_RUN_RESPONSE,
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    });
    const session = createReviewerSession(makeMockAgent(runFn), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.checkResult.success).toBe(false);
    await session.destroy();
  });

  test("parses failing response: checkResult.findings contains expected finding", async () => {
    const runFn: RunFn = async () => ({
      success: true,
      exitCode: 0,
      output: FAILING_RUN_RESPONSE,
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    });
    const session = createReviewerSession(makeMockAgent(runFn), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.checkResult.findings.length).toBe(1);
    expect(result.checkResult.findings[0]?.ruleId).toBe("missing-ac-coverage");
    await session.destroy();
  });

  test("parses failing response: findingReasoning Map contains entry for finding id", async () => {
    const runFn: RunFn = async () => ({
      success: true,
      exitCode: 0,
      output: FAILING_RUN_RESPONSE,
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    });
    const session = createReviewerSession(makeMockAgent(runFn), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.findingReasoning.has("missing-ac-coverage")).toBe(true);
    expect(result.findingReasoning.get("missing-ac-coverage")).toContain("acceptance criteria");
    await session.destroy();
  });

  test("findingReasoning Map size matches number of reasoning entries in response", async () => {
    const runFn: RunFn = async () => ({
      success: true,
      exitCode: 0,
      output: FAILING_RUN_RESPONSE,
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    });
    const session = createReviewerSession(makeMockAgent(runFn), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.findingReasoning.size).toBe(1);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC7 — review() appends exactly two DialogueMessage entries to history
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — history entries", () => {
  test("appends exactly two entries to history per review() call", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(2);
    await session.destroy();
  });

  test("first history entry has role 'implementer'", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[0]?.role).toBe("implementer");
    await session.destroy();
  });

  test("second history entry has role 'reviewer'", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[1]?.role).toBe("reviewer");
    await session.destroy();
  });

  test("implementer history entry content contains the diff", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[0]?.content).toContain(SAMPLE_DIFF);
    await session.destroy();
  });

  test("reviewer history entry content contains the agent response", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[1]?.content).toBeTruthy();
    await session.destroy();
  });

  test("second review() call appends two more entries (total 4)", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(4);
    await session.destroy();
  });

  test("history entries are DialogueMessage shaped (role + content)", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    for (const msg of session.history) {
      expect(typeof msg.role).toBe("string");
      expect(typeof msg.content).toBe("string");
    }
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC8 — destroy() deactivates session; subsequent review() throws NaxError
// ---------------------------------------------------------------------------

describe("ReviewerSession.destroy() — deactivation and guard", () => {
  test("destroy() sets session.active to false", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.destroy();
    expect(session.active).toBe(false);
  });

  test("destroy() clears history to empty array", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(2);
    await session.destroy();
    expect(session.history.length).toBe(0);
  });

  test("review() after destroy() throws NaxError", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.destroy();
    await expect(session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG)).rejects.toBeInstanceOf(NaxError);
  });

  test("review() after destroy() throws NaxError with code REVIEWER_SESSION_DESTROYED", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.destroy();
    let caught: unknown;
    try {
      await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("REVIEWER_SESSION_DESTROYED");
  });

  test("destroy() is idempotent — calling twice does not throw", async () => {
    const agent = makeMockAgent();
    const session = createReviewerSession(agent, "US-001", "/work", "my-feature", makeConfig());
    await session.destroy();
    await expect(session.destroy()).resolves.toBeUndefined();
  });
});
