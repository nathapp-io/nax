/**
 * Unit tests for src/review/dialogue.ts
 *
 * Tests cover (US-001):
 * AC1 — ReviewDialogueConfigSchema fields and defaults
 * AC2 — ReviewConfigSchema includes dialogue; DEFAULT_CONFIG.review.dialogue.enabled === false
 * AC3 — ReviewConfig interface includes dialogue? (compile-time check)
 * AC4 — createReviewerSession returns active session with empty history
 * AC5 — review() calls agent.run() with sessionRole='reviewer', keepOpen=true, pipelineStage='review'
 * AC6 — review() parses JSON into ReviewDialogueResult (checkResult + findingReasoning Map)
 * AC7 — review() appends exactly two DialogueMessage entries to history
 * AC8 — destroy() deactivates session; subsequent review() throws NaxError REVIEWER_SESSION_DESTROYED
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ReviewDialogueConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { NaxConfig } from "../../../src/config";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { RunAsSessionOpts } from "../../../src/agents/manager-types";
import { createReviewerSession } from "../../../src/review/dialogue";
import type { ReviewerSession } from "../../../src/review/dialogue";
import type { ReviewConfig } from "../../../src/review/types";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/semantic";
import { NaxError } from "../../../src/errors";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-001",
  title: "Config schema + ReviewerSession core",
  description: "Add ReviewDialogueConfig and implement ReviewerSession",
  acceptanceCriteria: [
    "createReviewerSession returns active session",
    "review() calls agent.run() with keepOpen: true",
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

type RunAsSessionFnType = (agentName: string, handle: SessionHandle, prompt: string, opts: RunAsSessionOpts) => Promise<TurnResult>;

function makeAgentManager(runAsSessionFn?: RunAsSessionFnType): IAgentManager {
  const defaultFn: RunAsSessionFnType = async () => ({
    output: PASSING_RUN_RESPONSE,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0.001 ,
    internalRoundTrips: 0,
  });
  const effectiveFn = runAsSessionFn ?? defaultFn;

  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runAsSessionFn: effectiveFn,
    completeFn: async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
  });
}

function makeConfig(): NaxConfig {
  return NaxConfigSchema.parse({}) as unknown as NaxConfig;
}

// ---------------------------------------------------------------------------
// AC1 — ReviewDialogueConfigSchema fields and defaults
// ---------------------------------------------------------------------------

describe("ReviewDialogueConfigSchema — field definitions and defaults", () => {
  test("is exported from src/config/schemas.ts", () => {
    expect(ReviewDialogueConfigSchema).toBeDefined();
  });

  test.each([
    ["enabled: false by default", { enabled: false }, "enabled", false],
    ["maxClarificationsPerAttempt: 2 by default", {}, "maxClarificationsPerAttempt", 2],
    ["maxDialogueMessages: 20 by default", {}, "maxDialogueMessages", 20],
    ["enabled accepts boolean true", { enabled: true }, "enabled", true],
    ["maxClarificationsPerAttempt accepts boundary 0", { maxClarificationsPerAttempt: 0 }, "maxClarificationsPerAttempt", 0],
    ["maxClarificationsPerAttempt accepts boundary 10", { maxClarificationsPerAttempt: 10 }, "maxClarificationsPerAttempt", 10],
    ["maxDialogueMessages accepts boundary 5", { maxDialogueMessages: 5 }, "maxDialogueMessages", 5],
    ["maxDialogueMessages accepts boundary 100", { maxDialogueMessages: 100 }, "maxDialogueMessages", 100],
  ])("%s", (_label, input, field, expected) => {
    const result = ReviewDialogueConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>)[field]).toBe(expected);
  });

  test.each([
    ["maxClarificationsPerAttempt rejects below 0", { maxClarificationsPerAttempt: -1 }],
    ["maxClarificationsPerAttempt rejects above 10", { maxClarificationsPerAttempt: 11 }],
    ["maxDialogueMessages rejects below 5", { maxDialogueMessages: 4 }],
    ["maxDialogueMessages rejects above 100", { maxDialogueMessages: 101 }],
    ["maxClarificationsPerAttempt rejects non-integer float", { maxClarificationsPerAttempt: 1.5 }],
    ["maxDialogueMessages rejects non-integer float", { maxDialogueMessages: 10.5 }],
  ])("%s", (_label, input) => {
    const result = ReviewDialogueConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — ReviewConfigSchema includes dialogue; DEFAULT_CONFIG resolved correctly
// ---------------------------------------------------------------------------

describe("ReviewConfigSchema — dialogue field integration", () => {
  test.each([
    ["dialogue exists", "dialogue", (v: unknown) => expect(v).toBeDefined()],
    ["dialogue.enabled is false", "dialogue.enabled", (v: unknown) => expect(v).toBe(false)],
    ["dialogue.maxClarificationsPerAttempt is 2", "dialogue.maxClarificationsPerAttempt", (v: unknown) => expect(v).toBe(2)],
    ["dialogue.maxDialogueMessages is 20", "dialogue.maxDialogueMessages", (v: unknown) => expect(v).toBe(20)],
  ])("DEFAULT_CONFIG.review.%s", (_label, path, assertFn) => {
    const review = (DEFAULT_CONFIG as unknown as { review: Record<string, unknown> }).review;
    const value = path.split(".").reduce((obj: unknown, k) => (obj as Record<string, unknown>)?.[k], review);
    assertFn(value);
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
  test("accepts object with dialogue field (optional); omitting dialogue is also valid", () => {
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

    const config2: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };
    expect(config2.dialogue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 — createReviewerSession returns active session with empty history
// ---------------------------------------------------------------------------

describe("createReviewerSession — initial state", () => {
  test("returns a defined ReviewerSession with active=true and empty history", () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    expect(session).toBeDefined();
    expect(session.active).toBe(true);
    expect(session.history.length).toBe(0);
  });

  test.each(["review", "destroy"])("session exposes %s() method", (method) => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    expect(typeof (session as any)[method]).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC5 — review() calls agentManager.runAsSession() with pipelineStage='review' (ADR-019)
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — agentManager.runAsSession() call parameters (ADR-019)", () => {
  let capturedPrompt: string | undefined;
  let capturedOpts: RunAsSessionOpts | undefined;
  let session: ReviewerSession;

  beforeEach(() => {
    capturedPrompt = undefined;
    capturedOpts = undefined;
    const runAsSessionFn: RunAsSessionFnType = async (_agentName, _handle, prompt, opts) => {
      capturedPrompt = prompt;
      capturedOpts = opts;
      return { output: PASSING_RUN_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    };
    session = createReviewerSession(makeAgentManager(runAsSessionFn), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
  });

  afterEach(async () => {
    if (session.active) await session.destroy();
    mock.restore();
  });

  test("calls agentManager.runAsSession() exactly once per review() call", async () => {
    let callCount = 0;
    const countingFn: RunAsSessionFnType = async () => {
      callCount++;
      return { output: PASSING_RUN_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    };
    const s = createReviewerSession(makeAgentManager(countingFn), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await s.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(callCount).toBe(1);
    await s.destroy();
  });

  test("passes pipelineStage: 'review' to agentManager.runAsSession()", async () => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedOpts?.pipelineStage).toBe("review");
  });

  test.each([
    ["diff", SAMPLE_DIFF],
    ["story id", STORY.id],
    ["acceptance criterion", STORY.acceptanceCriteria[0]],
  ])("prompt passed to agentManager.runAsSession() contains the %s", async (_label, value) => {
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(capturedPrompt).toContain(value);
  });
});

// ---------------------------------------------------------------------------
// AC6 — review() parses JSON into ReviewDialogueResult (checkResult + findingReasoning Map)
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — result parsing", () => {
  test("passing response: checkResult.success=true, empty findings array, Map for findingReasoning", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.checkResult.success).toBe(true);
    expect(Array.isArray(result.checkResult.findings)).toBe(true);
    expect(result.checkResult.findings.length).toBe(0);
    expect(result.findingReasoning instanceof Map).toBe(true);
    await session.destroy();
  });

  test("failing response: success=false, findings[0].rule='missing-ac-coverage', findingReasoning populated", async () => {
    const runAsSessionFn: RunAsSessionFnType = async () => ({
      output: FAILING_RUN_RESPONSE,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    });
    const session = createReviewerSession(makeAgentManager(runAsSessionFn), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    const result = await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(result.checkResult.success).toBe(false);
    expect(result.checkResult.findings.length).toBe(1);
    expect(result.checkResult.findings[0]?.rule).toBe("missing-ac-coverage");
    expect(result.findingReasoning.has("missing-ac-coverage")).toBe(true);
    expect(result.findingReasoning.get("missing-ac-coverage")).toContain("acceptance criteria");
    expect(result.findingReasoning.size).toBe(1);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC7 — review() appends exactly two DialogueMessage entries to history
// ---------------------------------------------------------------------------

describe("ReviewerSession.review() — history entries", () => {
  test("appends exactly two entries to history per review() call", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(2);
    await session.destroy();
  });

  test.each<[string, number, string]>([
    ["first", 0, "implementer"],
    ["second", 1, "reviewer"],
  ])("%s history entry has role '%s'", async (_label, index, expectedRole) => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[index]?.role).toBe(expectedRole as any);
    await session.destroy();
  });

  test("implementer entry contains diff; reviewer entry is truthy; both have string role+content", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history[0]?.content).toContain(SAMPLE_DIFF);
    expect(session.history[1]?.content).toBeTruthy();
    for (const msg of session.history) {
      expect(typeof msg.role).toBe("string");
      expect(typeof msg.content).toBe("string");
    }
    await session.destroy();
  });

  test("second review() call appends two more entries (total 4)", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(4);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC8 — destroy() deactivates session; subsequent review() throws NaxError
// ---------------------------------------------------------------------------

describe("ReviewerSession.destroy() — deactivation and guard", () => {
  test("destroy() sets active=false and clears history to empty array", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(session.history.length).toBe(2);
    await session.destroy();
    expect(session.active).toBe(false);
    expect(session.history.length).toBe(0);
  });

  test("review() after destroy() throws NaxError with code REVIEWER_SESSION_DESTROYED", async () => {
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
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
    const session = createReviewerSession(makeAgentManager(), makeSessionManager(), "US-001", "/work", "my-feature", makeConfig());
    await session.destroy();
    await expect(session.destroy()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADR-019 — caller-managed session lifecycle via ISessionManager
// ---------------------------------------------------------------------------

describe("ReviewerSession — ADR-019 caller-managed session lifecycle", () => {
  test("openSession is called exactly once even across multiple review() calls (handle reused)", async () => {
    let openCount = 0;
    const sm = makeSessionManager({
      openSession: async (name) => {
        openCount++;
        return { id: name, agentName: "claude" };
      },
    });
    const session = createReviewerSession(makeAgentManager(), sm, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    expect(openCount).toBe(1);
    await session.destroy();
  });

  test("closeSession is called on destroy()", async () => {
    let closedCount = 0;
    const sm = makeSessionManager({
      closeSession: async () => {
        closedCount++;
      },
    });
    const session = createReviewerSession(makeAgentManager(), sm, "US-001", "/work", "my-feature", makeConfig());
    await session.review(SAMPLE_DIFF, STORY, SEMANTIC_CONFIG);
    await session.destroy();
    expect(closedCount).toBe(1);
  });
});
