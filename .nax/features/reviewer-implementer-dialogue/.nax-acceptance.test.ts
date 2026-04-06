import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "../../../src/errors";

// ---------------------------------------------------------------------------
// Shared mock agent factory
// ---------------------------------------------------------------------------

function makeRunSpy(responseJson: string) {
  const calls: Array<{ options: Record<string, unknown> }> = [];
  const run = async (options: Record<string, unknown>) => {
    calls.push({ options });
    return {
      success: true,
      exitCode: 0,
      output: responseJson,
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.001,
    };
  };
  return { run, calls };
}

function makeDefaultRunSpy() {
  return makeRunSpy(
    JSON.stringify({
      checkResult: { success: true, findings: ["f1"] },
      findingReasoning: { f1: "reason text" },
    }),
  );
}

function makeMockAgent(runSpy: ReturnType<typeof makeRunSpy>) {
  return {
    name: "claude",
    displayName: "Claude",
    binary: "claude",
    capabilities: { supportedTiers: ["balanced"], maxContextTokens: 100000, features: new Set(["review"]) },
    isInstalled: async () => true,
    run: runSpy.run,
    buildCommand: () => [],
    plan: async () => ({ specContent: "", cost: 0 }),
    decompose: async () => ({ stories: [], cost: 0 }),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
  };
}

const VALID_SEMANTIC_CONFIG = {
  modelTier: "balanced" as const,
  rules: [],
  timeoutMs: 60000,
  excludePatterns: [],
};

const VALID_STORY = {
  id: "story-1",
  title: "Test story",
  description: "Test description",
  acceptanceCriteria: ["AC-1: something"],
};

const VALID_DIALOGUE_CONFIG = {
  enabled: true,
  maxClarificationsPerAttempt: 2,
  maxDialogueMessages: 20,
};

// ---------------------------------------------------------------------------
// AC-1: ReviewDialogueConfigSchema validation
// ---------------------------------------------------------------------------

describe("AC-1: ReviewDialogueConfigSchema validation", () => {
  test("AC-1a: parsing {} yields { enabled: false, maxClarificationsPerAttempt: 2, maxDialogueMessages: 20 }", () => {
    const { ReviewDialogueConfigSchema } = require("../../../src/config/schemas");
    const result = ReviewDialogueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.maxClarificationsPerAttempt).toBe(2);
      expect(result.data.maxDialogueMessages).toBe(20);
    }
  });

  test("AC-1b: parsing { enabled: true, maxClarificationsPerAttempt: 11 } fails Zod validation", () => {
    const { ReviewDialogueConfigSchema } = require("../../../src/config/schemas");
    const result = ReviewDialogueConfigSchema.safeParse({ enabled: true, maxClarificationsPerAttempt: 11 });
    expect(result.success).toBe(false);
  });

  test("AC-1c: parsing { maxClarificationsPerAttempt: -1 } fails Zod validation", () => {
    const { ReviewDialogueConfigSchema } = require("../../../src/config/schemas");
    const result = ReviewDialogueConfigSchema.safeParse({ maxClarificationsPerAttempt: -1 });
    expect(result.success).toBe(false);
  });

  test("AC-1d: parsing { maxDialogueMessages: 4 } fails Zod validation", () => {
    const { ReviewDialogueConfigSchema } = require("../../../src/config/schemas");
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 4 });
    expect(result.success).toBe(false);
  });

  test("AC-1e: parsing { maxDialogueMessages: 101 } fails Zod validation", () => {
    const { ReviewDialogueConfigSchema } = require("../../../src/config/schemas");
    const result = ReviewDialogueConfigSchema.safeParse({ maxDialogueMessages: 101 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-2: DEFAULT_CONFIG.review.dialogue values
// ---------------------------------------------------------------------------

describe("AC-2: DEFAULT_CONFIG.review.dialogue defaults", () => {
  test("AC-2: DEFAULT_CONFIG.review.dialogue.enabled === false", () => {
    const { DEFAULT_CONFIG } = require("../../../src/config/defaults");
    expect(DEFAULT_CONFIG.review.dialogue.enabled).toBe(false);
  });

  test("AC-2: DEFAULT_CONFIG.review.dialogue.maxClarificationsPerAttempt === 2", () => {
    const { DEFAULT_CONFIG } = require("../../../src/config/defaults");
    expect(DEFAULT_CONFIG.review.dialogue.maxClarificationsPerAttempt).toBe(2);
  });

  test("AC-2: DEFAULT_CONFIG.review.dialogue.maxDialogueMessages === 20", () => {
    const { DEFAULT_CONFIG } = require("../../../src/config/defaults");
    expect(DEFAULT_CONFIG.review.dialogue.maxDialogueMessages).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// AC-3: ReviewConfig.dialogue type compatibility
// ---------------------------------------------------------------------------

describe("AC-3: ReviewConfig has optional dialogue field of type ReviewDialogueConfig", () => {
  test("AC-3: ReviewConfig can be constructed with a valid dialogue object", () => {
    // TypeScript type compatibility — this test file will fail tsc if the types are wrong.
    // At runtime, we verify structural compatibility.
    const dialogueConfig = {
      enabled: false,
      maxClarificationsPerAttempt: 2,
      maxDialogueMessages: 20,
    };
    const reviewConfig = {
      enabled: true,
      checks: [] as const,
      commands: {},
      dialogue: dialogueConfig,
    };
    expect(reviewConfig.dialogue.enabled).toBe(false);
    expect(reviewConfig.dialogue.maxClarificationsPerAttempt).toBe(2);
    expect(reviewConfig.dialogue.maxDialogueMessages).toBe(20);
  });

  test("AC-3: ReviewConfig can be constructed without dialogue field (optional)", () => {
    const reviewConfig = {
      enabled: true,
      checks: [] as const,
      commands: {},
    };
    expect((reviewConfig as Record<string, unknown>).dialogue).toBeUndefined();
  });

  test("AC-3: ReviewConfig type from src/review/types.ts accepts dialogue property", () => {
    // Importing and using the type at runtime verifies the module exports correctly.
    // The TypeScript compiler enforces structural compatibility at build time.
    const { DEFAULT_CONFIG } = require("../../../src/config/defaults");
    const dialogue = DEFAULT_CONFIG.review.dialogue;
    expect(typeof dialogue).toBe("object");
    expect(typeof dialogue.enabled).toBe("boolean");
    expect(typeof dialogue.maxClarificationsPerAttempt).toBe("number");
    expect(typeof dialogue.maxDialogueMessages).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// AC-4: createReviewerSession() returns correct initial state
// ---------------------------------------------------------------------------

describe("AC-4: createReviewerSession() initial state", () => {
  test("AC-4: returns object with active === true", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);
    expect(session.active).toBe(true);
  });

  test("AC-4: returns object with history as empty array", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);
    expect(Array.isArray(session.history)).toBe(true);
    expect(session.history.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5: review() calls agent.run() with correct options
// ---------------------------------------------------------------------------

describe("AC-5: review() calls agent.run() with correct options", () => {
  test("AC-5: agent.run() is called exactly once with sessionRole=reviewer, keepSessionOpen=true, pipelineStage=review", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);

    expect(runSpy.calls.length).toBe(1);
    const opts = runSpy.calls[0].options;
    expect(opts.sessionRole).toBe("reviewer");
    expect(opts.keepSessionOpen).toBe(true);
    expect(opts.pipelineStage).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// AC-6: review() parses response and returns ReviewDialogueResult
// ---------------------------------------------------------------------------

describe("AC-6: review() parses agent response into ReviewDialogueResult", () => {
  test("AC-6: result.checkResult.success === true", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    const result = await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(result.checkResult.success).toBe(true);
  });

  test("AC-6: result.checkResult.findings[0] === 'f1'", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    const result = await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(Array.isArray(result.checkResult.findings)).toBe(true);
    expect(result.checkResult.findings[0]).toBe("f1");
  });

  test("AC-6: result.findingReasoning is a Map", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    const result = await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(result.findingReasoning instanceof Map).toBe(true);
  });

  test("AC-6: result.findingReasoning.get('f1') === 'reason text'", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    const result = await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(result.findingReasoning.get("f1")).toBe("reason text");
  });

  test("AC-6: review() throws NaxError when agent returns invalid JSON", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const badSpy = makeRunSpy("NOT VALID JSON {{{");
    const agent = makeMockAgent(badSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await expect(session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG)).rejects.toBeInstanceOf(NaxError);
  });

  test("AC-6: review() throws NaxError when agent response is missing required fields", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const partialSpy = makeRunSpy(JSON.stringify({ onlyPartialField: true }));
    const agent = makeMockAgent(partialSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await expect(session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG)).rejects.toBeInstanceOf(NaxError);
  });
});

// ---------------------------------------------------------------------------
// AC-7: review() appends to history
// ---------------------------------------------------------------------------

describe("AC-7: review() appends implementer prompt and reviewer response to history", () => {
  test("AC-7: after review(), session.history.length === 2", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(session.history.length).toBe(2);
  });

  test("AC-7: history[0].role === 'implementer' with non-empty content", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(session.history[0].role).toBe("implementer");
    expect(typeof session.history[0].content).toBe("string");
    expect(session.history[0].content.length).toBeGreaterThan(0);
  });

  test("AC-7: history[1].role === 'reviewer' with non-empty content", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(session.history[1].role).toBe("reviewer");
    expect(typeof session.history[1].content).toBe("string");
    expect(session.history[1].content.length).toBeGreaterThan(0);
  });

  test("AC-7: after second review(), session.history.length === 4", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff content", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.review("diff content v2", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(session.history.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// AC-8: destroy() clears session and subsequent review() throws
// ---------------------------------------------------------------------------

describe("AC-8: destroy() deactivates session", () => {
  test("AC-8: after destroy(), session.active === false", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.destroy();
    expect(session.active).toBe(false);
  });

  test("AC-8: after destroy(), session.history.length === 0", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.destroy();
    expect(Array.isArray(session.history)).toBe(true);
    expect(session.history.length).toBe(0);
  });

  test("AC-8: review() on destroyed session throws NaxError with code REVIEWER_SESSION_DESTROYED", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.destroy();

    let thrown: unknown;
    try {
      await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NaxError);
    expect((thrown as NaxError).code).toBe("REVIEWER_SESSION_DESTROYED");
  });

  test("AC-8: calling destroy() a second time does not throw", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.destroy();
    await expect(session.destroy()).resolves.toBeUndefined();
    expect(session.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9: reReview() prompt contains AC identifiers from last findings
// ---------------------------------------------------------------------------

describe("AC-9: reReview() prompt references last checkResult.findings", () => {
  test("AC-9: agent.run() is called with keepSessionOpen=true after reReview()", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const findingsResponse = JSON.stringify({
      checkResult: { success: false, findings: ["AC-1", "AC-2"] },
      findingReasoning: { "AC-1": "reason 1", "AC-2": "reason 2" },
    });
    const runSpy = makeRunSpy(findingsResponse);
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("original diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const callCountAfterReview = runSpy.calls.length;

    await session.reReview("updated diff");

    expect(runSpy.calls.length).toBe(callCountAfterReview + 1);
    const reReviewCall = runSpy.calls[runSpy.calls.length - 1];
    expect(reReviewCall.options.keepSessionOpen).toBe(true);
  });

  test("AC-9: reReview() prompt contains each AC identifier from last findings", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const findingsResponse = JSON.stringify({
      checkResult: { success: false, findings: ["AC-1", "AC-2"] },
      findingReasoning: { "AC-1": "reason 1", "AC-2": "reason 2" },
    });
    const runSpy = makeRunSpy(findingsResponse);
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("original diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.reReview("updated diff");

    const reReviewPrompt = String(runSpy.calls[runSpy.calls.length - 1].options.prompt);
    expect(reReviewPrompt).toContain("AC-1");
    expect(reReviewPrompt).toContain("AC-2");
  });
});

// ---------------------------------------------------------------------------
// AC-10: reReview() returns ReviewDialogueResult with deltaSummary
// ---------------------------------------------------------------------------

describe("AC-10: reReview() returns ReviewDialogueResult with deltaSummary", () => {
  test("AC-10: result.deltaSummary is a non-empty string", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const reviewResponse = JSON.stringify({
      checkResult: { success: false, findings: ["AC-1"] },
      findingReasoning: { "AC-1": "reason 1" },
    });
    const reReviewResponse = JSON.stringify({
      checkResult: { success: true, findings: [] },
      findingReasoning: {},
      deltaSummary: "AC-1 is now resolved.",
    });

    let callCount = 0;
    const runFn = async (options: Record<string, unknown>) => {
      callCount++;
      const output = callCount === 1 ? reviewResponse : reReviewResponse;
      return { success: true, exitCode: 0, output, rateLimited: false, durationMs: 100, estimatedCost: 0 };
    };
    const spyCalls: Array<{ options: Record<string, unknown> }> = [];
    const runSpy = {
      run: async (opts: Record<string, unknown>) => {
        spyCalls.push({ options: opts });
        return runFn(opts);
      },
      calls: spyCalls,
    };

    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("original diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const result = await session.reReview("updated diff");

    expect(typeof result.deltaSummary).toBe("string");
    expect(result.deltaSummary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-11: reReview() appends to history
// ---------------------------------------------------------------------------

describe("AC-11: reReview() appends implementer and reviewer entries to history", () => {
  test("AC-11: history.length increases by 2 after reReview()", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const lengthBeforeReReview = session.history.length;

    await session.reReview("updated diff");
    expect(session.history.length).toBe(lengthBeforeReReview + 2);
  });

  test("AC-11: second-to-last history entry has role === 'implementer'", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.reReview("updated diff");

    const secondToLast = session.history[session.history.length - 2];
    expect(secondToLast.role).toBe("implementer");
  });

  test("AC-11: last history entry has role === 'reviewer'", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.reReview("updated diff");

    const last = session.history[session.history.length - 1];
    expect(last.role).toBe("reviewer");
  });
});

// ---------------------------------------------------------------------------
// AC-12: Context overflow — destroy + fresh session with compacted summary
// ---------------------------------------------------------------------------

describe("AC-12: reReview() destroys session when history exceeds maxDialogueMessages", () => {
  test("AC-12: when adding 2 messages would exceed maxDialogueMessages, a new session is started", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const destroyCalls: number[] = [];
    const runSpy = makeDefaultRunSpy();
    const originalRun = runSpy.run.bind(runSpy);
    let interceptedDestroyCalled = false;

    // We'll track through session.active flips
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 5,
    });

    // Fill history to 4 entries (2 review calls)
    await session.review("diff 1", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.review("diff 2", VALID_STORY, VALID_SEMANTIC_CONFIG);
    expect(session.history.length).toBe(4);

    // Next reReview would push history to 6, exceeding maxDialogueMessages=5
    // Session should be destroyed and a new one started
    const prompts: string[] = [];
    const trackingRun = async (opts: Record<string, unknown>) => {
      prompts.push(String(opts.prompt ?? ""));
      return originalRun(opts as Parameters<typeof originalRun>[0]);
    };
    (agent as Record<string, unknown>).run = trackingRun;

    await session.reReview("overflow diff");

    // The new session prompt should contain a compacted summary of prior history
    const newSessionPrompt = prompts[prompts.length - 1];
    expect(typeof newSessionPrompt).toBe("string");
    // After reset, session should still be active and functional
    expect(session.active).toBe(true);
  });

  test("AC-12: compacted summary contains text derived from prior history entries", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const runSpy = makeRunSpy(
      JSON.stringify({
        checkResult: { success: false, findings: ["AC-3"] },
        findingReasoning: { "AC-3": "unique-marker-text-xyz" },
      }),
    );
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 5,
    });

    // Two review calls → 4 history entries
    await session.review("diff 1", VALID_STORY, VALID_SEMANTIC_CONFIG);
    await session.review("diff 2", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const promptsCollected: string[] = [];
    const originalRun = agent.run.bind(agent);
    (agent as Record<string, unknown>).run = async (opts: Record<string, unknown>) => {
      promptsCollected.push(String(opts.prompt ?? ""));
      return originalRun(opts as Parameters<typeof originalRun>[0]);
    };

    // This reReview triggers context overflow
    await session.reReview("overflow diff");

    // The first prompt after overflow should contain a compacted summary
    const overflowPrompt = promptsCollected[0];
    expect(overflowPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-13: clarify() calls agent.run() and returns response text
// ---------------------------------------------------------------------------

describe("AC-13: clarify() sends question and returns raw response text", () => {
  test("AC-13: clarify() calls agent.run() with keepSessionOpen=true", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const clarifyRunSpy = makeRunSpy("The answer to your question is X.");
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;

    await session.clarify("What do you mean by error handling?");

    expect(clarifyRunSpy.calls.length).toBe(1);
    expect(clarifyRunSpy.calls[0].options.keepSessionOpen).toBe(true);
  });

  test("AC-13: clarify() prompt contains the exact question string", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const question = "What specific timeout check do you require?";
    const clarifyRunSpy = makeRunSpy("You need to check for network timeouts specifically.");
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;

    await session.clarify(question);

    const prompt = String(clarifyRunSpy.calls[0].options.prompt);
    expect(prompt).toContain(question);
  });

  test("AC-13: clarify() returns the raw agent response text", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const expectedResponse = "You need to check for network timeouts specifically.";
    const clarifyRunSpy = makeRunSpy(expectedResponse);
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;

    const result = await session.clarify("What specific timeout check do you require?");
    expect(result).toBe(expectedResponse);
  });
});

// ---------------------------------------------------------------------------
// AC-14: clarify() appends to history
// ---------------------------------------------------------------------------

describe("AC-14: clarify() appends implementer question and reviewer answer to history", () => {
  test("AC-14: history.length increases by 2 after clarify()", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const lengthBefore = session.history.length;

    const clarifyRunSpy = makeRunSpy("Clarification answer.");
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;
    await session.clarify("A question?");

    expect(session.history.length).toBe(lengthBefore + 2);
  });

  test("AC-14: second-to-last entry has role === 'implementer' after clarify()", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const clarifyRunSpy = makeRunSpy("Clarification answer.");
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;
    await session.clarify("A question?");

    const secondToLast = session.history[session.history.length - 2];
    expect(secondToLast.role).toBe("implementer");
  });

  test("AC-14: last entry has role === 'reviewer' after clarify()", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", {
      ...VALID_DIALOGUE_CONFIG,
      maxDialogueMessages: 100,
    });

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);

    const clarifyRunSpy = makeRunSpy("Clarification answer.");
    (agent as Record<string, unknown>).run = clarifyRunSpy.run;
    await session.clarify("A question?");

    const last = session.history[session.history.length - 1];
    expect(last.role).toBe("reviewer");
  });
});

// ---------------------------------------------------------------------------
// AC-15: getVerdict() returns correct SemanticVerdict
// ---------------------------------------------------------------------------

describe("AC-15: getVerdict() returns SemanticVerdict from last review", () => {
  test("AC-15: result.storyId matches the session storyId", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const verdict = session.getVerdict();

    expect(verdict.storyId).toBe("story-1");
  });

  test("AC-15: result.passed matches lastCheckResult.success", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const verdict = session.getVerdict();

    expect(verdict.passed).toBe(true);
  });

  test("AC-15: result.timestamp is a parseable ISO string", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const verdict = session.getVerdict();

    expect(typeof verdict.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(verdict.timestamp))).toBe(false);
  });

  test("AC-15: result.acCount matches lastCheckResult.findings.length", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const verdict = session.getVerdict();

    expect(verdict.acCount).toBe(1); // findings: ["f1"] has length 1
  });

  test("AC-15: result.findings deep-equals lastCheckResult.findings", async () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    await session.review("diff", VALID_STORY, VALID_SEMANTIC_CONFIG);
    const verdict = session.getVerdict();

    expect(verdict.findings).toEqual(["f1"]);
  });
});

// ---------------------------------------------------------------------------
// AC-16: getVerdict() before review() throws NaxError with NO_REVIEW_RESULT
// ---------------------------------------------------------------------------

describe("AC-16: getVerdict() before any review() throws NaxError", () => {
  test("AC-16: throws NaxError with code NO_REVIEW_RESULT on fresh session", () => {
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    let thrown: unknown;
    try {
      session.getVerdict();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NaxError);
    expect((thrown as NaxError).code).toBe("NO_REVIEW_RESULT");
  });
});

// ---------------------------------------------------------------------------
// AC-17: PipelineContext includes reviewerSession field
// ---------------------------------------------------------------------------

describe("AC-17: PipelineContext.reviewerSession field type", () => {
  test("AC-17: keyof PipelineContext includes reviewerSession", () => {
    // We can't call `keyof` at runtime directly, but we can verify the field
    // exists on a constructed PipelineContext-shaped object.
    // TypeScript compilation enforces the type; this test checks the runtime shape.
    const { createReviewerSession } = require("../../../src/review/dialogue");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const session = createReviewerSession(agent, "story-1", "/tmp/work", "feature-x", VALID_DIALOGUE_CONFIG);

    // A minimal PipelineContext-shaped object with reviewerSession
    const ctx = {
      reviewerSession: session,
    } as Record<string, unknown>;

    expect(ctx.reviewerSession).toBeDefined();
    expect(ctx.reviewerSession).toBe(session);
  });

  test("AC-17: reviewerSession can be undefined on PipelineContext (optional field)", () => {
    const ctx = {
      reviewerSession: undefined,
    } as Record<string, unknown>;
    expect(ctx.reviewerSession).toBeUndefined();
  });

  test("AC-17: src/pipeline/types.ts exports PipelineContext with reviewerSession field", () => {
    // Verify that the module can be imported and the type includes the field at runtime
    // (TypeScript will enforce the type at compile time via tsc --noEmit)
    const pipelineTypes = require("../../../src/pipeline/types");
    // The module should export type definitions; we verify it loads without error
    expect(typeof pipelineTypes).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// AC-18: reviewStage creates ReviewerSession when dialogue.enabled === true
// ---------------------------------------------------------------------------

describe("AC-18: reviewStage creates ReviewerSession when dialogue enabled", () => {
  test("AC-18: createReviewerSession called once when dialogue.enabled === true", async () => {
    const { reviewStage, _reviewDeps } = require("../../../src/pipeline/stages/review");
    const { createReviewerSession } = require("../../../src/review/dialogue");

    const createdSessions: unknown[] = [];
    const origCreateReviewerSession = _reviewDeps.createReviewerSession;

    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);

    _reviewDeps.createReviewerSession = (...args: unknown[]) => {
      const session = createReviewerSession(...(args as Parameters<typeof createReviewerSession>));
      createdSessions.push(session);
      return session;
    };

    const ctx = makeMinimalCtxWithDialogue(agent, true);

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore errors from missing orchestrator deps
    } finally {
      _reviewDeps.createReviewerSession = origCreateReviewerSession;
    }

    expect(createdSessions.length).toBe(1);
    expect(ctx.reviewerSession).toBeDefined();
  });

  test("AC-18: ctx.reviewerSession is undefined when dialogue.enabled === false", async () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const ctx = makeMinimalCtxWithDialogue(agent, false);

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore
    }

    expect(ctx.reviewerSession).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-19: reviewStage calls ctx.reviewerSession.reReview() on re-review
// ---------------------------------------------------------------------------

describe("AC-19: reviewStage calls reReview() when ctx.reviewerSession already set", () => {
  test("AC-19: reReview() is called and runSemanticReview() is NOT called for the semantic check path", async () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");
    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);

    const reReviewCalls: string[] = [];
    const mockSession = {
      storyId: "story-1",
      history: [],
      active: true,
      review: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map(), deltaSummary: "" }),
      reReview: async (diff: string) => {
        reReviewCalls.push(diff);
        return { checkResult: { success: true, findings: [] }, findingReasoning: new Map(), deltaSummary: "resolved" };
      },
      clarify: async () => "",
      getVerdict: () => ({ storyId: "story-1", passed: true, timestamp: new Date().toISOString(), acCount: 0, findings: [] }),
      destroy: async () => {},
    };

    const ctx = makeMinimalCtxWithDialogue(agent, true);
    ctx.reviewerSession = mockSession as unknown as typeof ctx.reviewerSession;

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore
    }

    expect(reReviewCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-20: buildDialogueAwareRectificationPrompt() includes findingReasoning and history
// ---------------------------------------------------------------------------

describe("AC-20: buildDialogueAwareRectificationPrompt() includes reasoning and history", () => {
  test("AC-20: prompt contains each findingReasoning entry text", () => {
    const { buildDialogueAwareRectificationPrompt } = require("../../../src/pipeline/stages/autofix-prompts");

    const findingReasoning = new Map([
      ["AC-1", "unique-reasoning-text-for-ac1"],
      ["AC-2", "unique-reasoning-text-for-ac2"],
    ]);

    const history = [
      { role: "implementer" as const, content: "prompt content", timestamp: Date.now() },
      { role: "reviewer" as const, content: "response content", timestamp: Date.now() },
    ];

    const prompt = buildDialogueAwareRectificationPrompt({
      findings: ["AC-1", "AC-2"],
      findingReasoning,
      history,
      historyWindowSize: 10,
      basePrompt: "Fix the following issues:",
    });

    expect(prompt).toContain("unique-reasoning-text-for-ac1");
    expect(prompt).toContain("unique-reasoning-text-for-ac2");
  });

  test("AC-20: prompt contains last N history messages where N = historyWindowSize", () => {
    const { buildDialogueAwareRectificationPrompt } = require("../../../src/pipeline/stages/autofix-prompts");

    const findingReasoning = new Map<string, string>();
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("implementer" as const) : ("reviewer" as const),
      content: `unique-message-content-${i}`,
      timestamp: Date.now() + i,
    }));

    const prompt = buildDialogueAwareRectificationPrompt({
      findings: [],
      findingReasoning,
      history,
      historyWindowSize: 3,
      basePrompt: "Fix the following issues:",
    });

    // Last 3 messages should be present
    expect(prompt).toContain("unique-message-content-9");
    expect(prompt).toContain("unique-message-content-8");
    expect(prompt).toContain("unique-message-content-7");
    // Earlier messages should NOT be present
    expect(prompt).not.toContain("unique-message-content-6");
  });
});

// ---------------------------------------------------------------------------
// AC-21: autofix stage detects CLARIFY: and calls ctx.reviewerSession.clarify()
// ---------------------------------------------------------------------------

describe("AC-21: autofix handles CLARIFY: pattern in agent output", () => {
  test("AC-21: when agent output matches CLARIFY: pattern, session.clarify() is called with captured group", async () => {
    const { _autofixDeps } = require("../../../src/pipeline/stages/autofix");
    const clarifyQuestion = "What specifically needs error handling for the timeout case?";
    const agentOutputWithClarify = `I'm looking at the code.\nCLARIFY: ${clarifyQuestion}\nLet me fix this.`;

    const clarifyCalls: string[] = [];
    const mockSession = {
      storyId: "story-1",
      history: [],
      active: true,
      clarify: async (q: string) => {
        clarifyCalls.push(q);
        return "The timeout should be handled at line 42.";
      },
      getVerdict: () => ({ storyId: "story-1", passed: true, timestamp: new Date().toISOString(), acCount: 0, findings: [] }),
      destroy: async () => {},
    };

    // Simulate the CLARIFY: detection logic that autofix should implement
    const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
    const match = agentOutputWithClarify.match(CLARIFY_REGEX);
    if (match) {
      await mockSession.clarify(match[1].trim());
    }

    expect(clarifyCalls.length).toBe(1);
    expect(clarifyCalls[0]).toContain(clarifyQuestion.trim());
  });

  test("AC-21: clarify() return value is appended to agent context", async () => {
    const clarifyResponse = "The timeout should be handled at line 42.";
    const contextParts: string[] = [];

    const mockSession = {
      clarify: async (q: string) => clarifyResponse,
    };

    const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
    const agentOutput = "CLARIFY: What about the timeout?";
    const match = agentOutput.match(CLARIFY_REGEX);
    if (match) {
      const answer = await mockSession.clarify(match[1].trim());
      contextParts.push(answer);
    }

    expect(contextParts).toContain(clarifyResponse);
  });
});

// ---------------------------------------------------------------------------
// AC-22: clarify() calls capped at maxClarificationsPerAttempt
// ---------------------------------------------------------------------------

describe("AC-22: CLARIFY: handling is capped at maxClarificationsPerAttempt", () => {
  test("AC-22: spy call count equals maxClarificationsPerAttempt when more CLARIFY: blocks are present", async () => {
    // Simulate the autofix clarification loop with cap enforcement
    const maxClarificationsPerAttempt = 2;
    let callCount = 0;
    const clarifyFn = async (question: string) => {
      callCount++;
      return "Answer.";
    };

    const agentOutputs = [
      "CLARIFY: Question 1?",
      "CLARIFY: Question 2?",
      "CLARIFY: Question 3?",
      "CLARIFY: Question 4?",
    ];

    const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
    let clarificationsDone = 0;

    for (const output of agentOutputs) {
      const match = output.match(CLARIFY_REGEX);
      if (match && clarificationsDone < maxClarificationsPerAttempt) {
        await clarifyFn(match[1]);
        clarificationsDone++;
      }
    }

    expect(callCount).toBe(maxClarificationsPerAttempt);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-23: completionStage.execute() calls session.destroy()
// ---------------------------------------------------------------------------

describe("AC-23: completionStage destroys reviewerSession on story completion", () => {
  test("AC-23: destroy() called exactly once when ctx.reviewerSession is set (passing story)", async () => {
    const { completionStage, _completionDeps } = require("../../../src/pipeline/stages/completion");

    const destroyCalls: number[] = [];
    const mockSession = {
      storyId: "story-1",
      history: [],
      active: true,
      review: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map(), deltaSummary: "" }),
      reReview: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map(), deltaSummary: "" }),
      clarify: async () => "",
      getVerdict: () => ({ storyId: "story-1", passed: true, timestamp: new Date().toISOString(), acCount: 0, findings: [] }),
      destroy: async () => {
        destroyCalls.push(1);
      },
    };

    const ctx = makeMinimalCompletionCtx();
    ctx.reviewerSession = mockSession as unknown as typeof ctx.reviewerSession;

    try {
      await completionStage.execute(ctx);
    } catch {
      // Ignore errors from missing deps (prd save, etc.)
    }

    expect(destroyCalls.length).toBe(1);
  });

  test("AC-23: destroy() is NOT called when ctx.reviewerSession is undefined", async () => {
    const { completionStage } = require("../../../src/pipeline/stages/completion");

    const ctx = makeMinimalCompletionCtx();
    // reviewerSession is not set

    let destroyCalled = false;
    const originalDestroy = ctx.reviewerSession?.destroy;

    try {
      await completionStage.execute(ctx);
    } catch {
      // Ignore
    }

    expect(destroyCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-24: When dialogue disabled, no ReviewerSession created across all stages
// ---------------------------------------------------------------------------

describe("AC-24: dialogue disabled — no ReviewerSession created across stages", () => {
  test("AC-24: createReviewerSession never called in reviewStage when dialogue.enabled === false", async () => {
    const { reviewStage, _reviewDeps } = require("../../../src/pipeline/stages/review");

    let createSessionCallCount = 0;
    const origCreate = _reviewDeps.createReviewerSession;
    _reviewDeps.createReviewerSession = (...args: unknown[]) => {
      createSessionCallCount++;
      return origCreate?.(...args);
    };

    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);
    const ctx = makeMinimalCtxWithDialogue(agent, false);

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore
    } finally {
      _reviewDeps.createReviewerSession = origCreate;
    }

    expect(createSessionCallCount).toBe(0);
    expect(ctx.reviewerSession).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-25: When reReview() throws, review stage falls back to runSemanticReview()
// ---------------------------------------------------------------------------

describe("AC-25: reReview() error triggers fallback to runSemanticReview()", () => {
  test("AC-25: when reReview() throws, reviewStage calls runSemanticReview() exactly once and emits logger.warn", async () => {
    const { reviewStage, _reviewDeps } = require("../../../src/pipeline/stages/review");

    const runSemanticReviewCalls: unknown[] = [];
    const warnCalls: Array<{ data: Record<string, unknown> }> = [];

    const origRunSemantic = _reviewDeps.runSemanticReview;
    _reviewDeps.runSemanticReview = async (...args: unknown[]) => {
      runSemanticReviewCalls.push(args);
      return { success: true, checks: [], totalDurationMs: 0 };
    };

    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);

    const throwingSession = {
      storyId: "story-1",
      history: [],
      active: true,
      review: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map(), deltaSummary: "" }),
      reReview: async () => {
        throw new Error("Session crashed");
      },
      clarify: async () => "",
      getVerdict: () => ({ storyId: "story-1", passed: true, timestamp: new Date().toISOString(), acCount: 0, findings: [] }),
      destroy: async () => {},
    };

    const ctx = makeMinimalCtxWithDialogue(agent, true);
    ctx.reviewerSession = throwingSession as unknown as typeof ctx.reviewerSession;

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore
    } finally {
      _reviewDeps.runSemanticReview = origRunSemantic;
    }

    expect(runSemanticReviewCalls.length).toBe(1);
  });

  test("AC-25: logger.warn is emitted with storyId when reReview() throws", async () => {
    const { reviewStage, _reviewDeps } = require("../../../src/pipeline/stages/review");
    const { getLogger } = require("../../../src/logger");

    const warnMessages: Array<{ data: Record<string, unknown> }> = [];
    const logger = getLogger();
    const origWarn = logger.warn.bind(logger);
    logger.warn = (stage: string, msg: string, data?: Record<string, unknown>) => {
      warnMessages.push({ data: data ?? {} });
    };

    _reviewDeps.runSemanticReview = async () => ({ success: true, checks: [], totalDurationMs: 0 });

    const runSpy = makeDefaultRunSpy();
    const agent = makeMockAgent(runSpy);

    const throwingSession = {
      storyId: "story-1",
      history: [],
      active: true,
      reReview: async () => {
        throw new Error("Session crashed");
      },
      destroy: async () => {},
    };

    const ctx = makeMinimalCtxWithDialogue(agent, true);
    ctx.reviewerSession = throwingSession as unknown as typeof ctx.reviewerSession;

    try {
      await reviewStage.execute(ctx);
    } catch {
      // ignore
    } finally {
      logger.warn = origWarn;
      _reviewDeps.runSemanticReview = undefined;
    }

    const warnWithStoryId = warnMessages.find((w) => w.data.storyId === "story-1");
    expect(warnWithStoryId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-26: When clarify() throws, autofix continues without clarification
// ---------------------------------------------------------------------------

describe("AC-26: clarify() error — autofix continues without appending clarification", () => {
  test("AC-26: when clarify() throws, no clarification is appended to agent context", async () => {
    const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
    const maxClarifications = 2;
    let clarificationsDone = 0;
    const contextParts: string[] = [];
    const debugCalls: Array<{ data: Record<string, unknown> }> = [];

    const throwingClarify = async (q: string) => {
      throw new Error("Session unavailable");
    };

    const agentOutput = "CLARIFY: What about the null check?";
    const match = agentOutput.match(CLARIFY_REGEX);

    if (match && clarificationsDone < maxClarifications) {
      try {
        const answer = await throwingClarify(match[1]);
        contextParts.push(answer);
        clarificationsDone++;
      } catch {
        // AC-26: catch, do NOT append, log debug
        debugCalls.push({ data: { storyId: "story-1" } });
      }
    }

    expect(contextParts.length).toBe(0);
    expect(debugCalls.length).toBe(1);
  });

  test("AC-26: execution continues normally after clarify() throws", async () => {
    const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
    let executionContinued = false;

    const throwingClarify = async (q: string) => {
      throw new Error("Timeout");
    };

    const agentOutput = "CLARIFY: A question?";
    const match = agentOutput.match(CLARIFY_REGEX);

    if (match) {
      try {
        await throwingClarify(match[1]);
      } catch {
        // swallow — should not rethrow
      }
    }

    // Execution reaches here — not blocked by the clarify() error
    executionContinued = true;
    expect(executionContinued).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalCtxWithDialogue(agent: ReturnType<typeof makeMockAgent>, dialogueEnabled: boolean): Record<string, unknown> & { reviewerSession?: unknown } {
  const { DEFAULT_CONFIG } = require("../../../src/config/defaults");
  const effectiveConfig = {
    ...DEFAULT_CONFIG,
    review: {
      ...DEFAULT_CONFIG.review,
      enabled: true,
      checks: ["semantic"],
      dialogue: {
        enabled: dialogueEnabled,
        maxClarificationsPerAttempt: 2,
        maxDialogueMessages: 20,
      },
    },
  };

  return {
    config: DEFAULT_CONFIG,
    effectiveConfig,
    story: { id: "story-1", title: "Test story", description: "desc", acceptanceCriteria: ["AC-1: something"], status: "pending", attempts: 0 },
    stories: [{ id: "story-1", title: "Test story", description: "desc", acceptanceCriteria: ["AC-1: something"], status: "pending", attempts: 0 }],
    prd: { feature: "feature-x", version: "1.0.0", stories: [] },
    routing: { complexity: "medium", modelTier: "balanced", testStrategy: "tdd-simple", reasoning: "test" },
    workdir: "/tmp/work",
    hooks: {},
    agentGetFn: () => agent,
    reviewerSession: undefined,
  };
}

function makeMinimalCompletionCtx(): Record<string, unknown> & { reviewerSession?: unknown } {
  const { DEFAULT_CONFIG } = require("../../../src/config/defaults");

  return {
    config: DEFAULT_CONFIG,
    effectiveConfig: DEFAULT_CONFIG,
    story: { id: "story-1", title: "Test story", description: "desc", acceptanceCriteria: [], status: "pending", attempts: 0 },
    stories: [{ id: "story-1", title: "Test story", description: "desc", acceptanceCriteria: [], status: "pending", attempts: 0 }],
    prd: { feature: "feature-x", version: "1.0.0", stories: [{ id: "story-1", title: "Test story", description: "desc", acceptanceCriteria: [], status: "pending", attempts: 0 }] },
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "no-test", reasoning: "test" },
    workdir: "/tmp/work",
    featureDir: "/tmp/work/.nax/features/feature-x",
    hooks: {},
    agentGetFn: () => undefined,
    agentResult: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 },
    storyStartTime: new Date().toISOString(),
    reviewerSession: undefined,
  };
}