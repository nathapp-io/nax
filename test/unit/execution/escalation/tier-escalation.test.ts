/**
 * Tier Escalation — Runtime Crash Branching (BUG-070)
 *
 * Integration tests for escalation path branching:
 * - RUNTIME_CRASH → retry same tier (transient failure, not a code issue)
 * - TEST_FAILURE  → escalate to next tier (existing behaviour)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";

// ---------------------------------------------------------------------------
// shouldRetrySameTier — pure predicate (BUG-070)
// ---------------------------------------------------------------------------

describe("shouldRetrySameTier", () => {
  test("returns true when verifyResult status is RUNTIME_CRASH", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "RUNTIME_CRASH", success: false }),
    ).toBe(true);
  });

  test("returns false when verifyResult status is TEST_FAILURE", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "TEST_FAILURE", success: false }),
    ).toBe(false);
  });

  test("returns false when verifyResult is undefined", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier(undefined)).toBe(false);
  });

  test("returns false when verifyResult status is TIMEOUT", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "TIMEOUT", success: false }),
    ).toBe(false);
  });

  test("returns false when verifyResult status is PASS", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "PASS", success: true }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveMaxAttemptsOutcome — runtime-crash category (BUG-070)
//
// When all attempts are exhausted for a story that kept crashing at runtime,
// it should pause (human review) not fail, since crashes are environmental.
// ---------------------------------------------------------------------------

describe("resolveMaxAttemptsOutcome — runtime-crash category", () => {
  test("returns pause for runtime-crash failure category", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("runtime-crash")).toBe("pause");
  });

  test("still returns fail for tests-failing (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("tests-failing")).toBe("fail");
  });

  test("returns fail for full-suite-gate-exhausted (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("full-suite-gate-exhausted")).toBe("fail");
  });

  test("still returns pause for verifier-rejected (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("verifier-rejected")).toBe("pause");
  });
});

describe("handleTierEscalation — tier escalation regression guard", () => {
  test("still escalates tier for TEST_FAILURE (regression guard)", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after" },
      };

      const ctx = {
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: {
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 1 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd: {
          project: "test",
          feature: "f",
          branchName: "b",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        },
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        verifyResult: { status: "TEST_FAILURE", success: false },
      };

      const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]);

      // TEST_FAILURE must still escalate — existing behaviour preserved
      expect(result.outcome).toBe("escalated");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — cross-agent escalation (US-004)
//
// When tierOrder entries have an agent field, the escalated story's routing
// in the PRD should include the agent from the next tier entry.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — cross-agent escalation (US-004)", () => {
  test("sets routing.agent in PRD when next tier entry has agent field (AC-5)", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after", agent: "claude", complexity: "medium", reasoning: "" },
      };

      const ctx = {
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after", agent: "claude" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: {
          autoMode: {
            defaultAgent: "claude",
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", agent: "claude", attempts: 3 },
                { tier: "balanced", agent: "claude", attempts: 2 },
                { tier: "fast", agent: "codex", attempts: 2 },
              ],
              escalateEntireBatch: false,
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd: {
          project: "test",
          feature: "f",
          branchName: "b",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        },
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        verifyResult: { status: "TEST_FAILURE", success: false },
      };

      const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]);

      expect(result.outcome).toBe("escalated");
      const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
      // Next tier entry is { tier: "balanced", agent: "claude" }
      expect(updatedStory?.routing?.modelTier).toBe("balanced");
      expect(updatedStory?.routing?.agent).toBe("claude");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("sets codex agent when escalating from claude/balanced to codex/fast (AC-5, AC-6)", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { modelTier: "balanced", testStrategy: "test-after", agent: "claude", complexity: "medium", reasoning: "" },
      };

      const ctx = {
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "balanced", testStrategy: "test-after", agent: "claude" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: {
          autoMode: {
            defaultAgent: "claude",
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", agent: "claude", attempts: 3 },
                { tier: "balanced", agent: "claude", attempts: 2 },
                { tier: "fast", agent: "codex", attempts: 2 },
              ],
              escalateEntireBatch: false,
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd: {
          project: "test",
          feature: "f",
          branchName: "b",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        },
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        verifyResult: { status: "TEST_FAILURE", success: false },
      };

      const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]);

      expect(result.outcome).toBe("escalated");
      const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
      // Next tier entry is { tier: "fast", agent: "codex" }
      expect(updatedStory?.routing?.modelTier).toBe("fast");
      expect(updatedStory?.routing?.agent).toBe("codex");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("does not set agent when tierOrder entry has no agent field (AC-4 backward compat)", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
      };

      const ctx = {
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: {
          autoMode: {
            defaultAgent: "claude",
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 3 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd: {
          project: "test",
          feature: "f",
          branchName: "b",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        },
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        verifyResult: { status: "TEST_FAILURE", success: false },
      };

      const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]);

      expect(result.outcome).toBe("escalated");
      const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
      expect(updatedStory?.routing?.modelTier).toBe("balanced");
      // No agent field set — caller uses defaultAgent
      expect(updatedStory?.routing?.agent).toBeUndefined();
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// preIterationTierCheck — story:escalated event emission (BUG-2)
// ---------------------------------------------------------------------------

describe("preIterationTierCheck — story:escalated event emission", () => {
  type StoryEscalatedPayload = { type: "story:escalated"; storyId: string; fromTier: string; toTier: string };
  let capturedEvents: StoryEscalatedPayload[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    capturedEvents = [];
    unsubscribe = pipelineEventBus.on("story:escalated", (event) => {
      capturedEvents.push(event as StoryEscalatedPayload);
    });
  });

  afterEach(() => {
    unsubscribe?.();
  });

  test("emits story:escalated when story has exhausted current tier budget", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-pre-iter-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        // attempts === tierCfg.attempts (1) → triggers escalation
        attempts: 1,
        routing: { modelTier: "fast", testStrategy: "test-after" },
      };

      const prd = {
        project: "test",
        feature: "f",
        branchName: "b",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [story],
      };

      const config = {
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      };

      const result = await preIterationTierCheck(
        story as unknown as Parameters<typeof preIterationTierCheck>[0],
        { modelTier: "fast" },
        config as unknown as Parameters<typeof preIterationTierCheck>[2],
        prd as unknown as Parameters<typeof preIterationTierCheck>[3],
        "/tmp/test-prd-pre-iter.json",
        undefined,
        { hooks: {} } as unknown as Parameters<typeof preIterationTierCheck>[6],
        "f",
        0,
        "/tmp",
      );

      expect(result.shouldSkipIteration).toBe(true);
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        type: "story:escalated",
        storyId: "US-pre-iter-001",
        fromTier: "fast",
        toTier: "balanced",
      });
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("does not emit story:escalated when story is still within tier budget", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-pre-iter-002",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        // attempts (0) < tierCfg.attempts (1) → no escalation
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after" },
      };

      const prd = {
        project: "test",
        feature: "f",
        branchName: "b",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [story],
      };

      const config = {
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      };

      const result = await preIterationTierCheck(
        story as unknown as Parameters<typeof preIterationTierCheck>[0],
        { modelTier: "fast" },
        config as unknown as Parameters<typeof preIterationTierCheck>[2],
        prd as unknown as Parameters<typeof preIterationTierCheck>[3],
        "/tmp/test-prd-pre-iter-2.json",
        undefined,
        { hooks: {} } as unknown as Parameters<typeof preIterationTierCheck>[6],
        "f",
        0,
        "/tmp",
      );

      expect(result.shouldSkipIteration).toBe(false);
      expect(capturedEvents).toHaveLength(0);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — story:escalated event emission
// ---------------------------------------------------------------------------

describe("handleTierEscalation — story:escalated event emission", () => {
  type StoryEscalatedPayload = { type: "story:escalated"; storyId: string; fromTier: string; toTier: string };
  let capturedEvents: StoryEscalatedPayload[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    capturedEvents = [];
    unsubscribe = pipelineEventBus.on("story:escalated", (event) => {
      capturedEvents.push(event as StoryEscalatedPayload);
    });
  });

  afterEach(() => {
    unsubscribe?.();
  });

  test("emits story:escalated event with correct storyId, fromTier, and toTier on successful escalation", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = {
        id: "US-escalated-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after" },
      };

      const ctx = {
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: {
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 1 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd: {
          project: "test",
          feature: "f",
          branchName: "b",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        },
        prdPath: "/tmp/test-prd-escalated.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]);

      expect(result.outcome).toBe("escalated");
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        type: "story:escalated",
        storyId: "US-escalated-001",
        fromTier: "fast",
        toTier: "balanced",
      });
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// preIterationTierCheck — M2: unmatched rung does not grant unlimited budget
//
// When tierOrder has agent-qualified rungs but the story's (tier, agent) pair
// matches no rung, the function must NOT skip the iteration (budget is treated
// as unbounded, which keeps the story running) and emits a warn.
// ---------------------------------------------------------------------------

describe("preIterationTierCheck — M2: unmatched rung on non-empty agent ladder", () => {
  test("shouldSkipIteration is false when (tier, agent) pair is absent from agent-qualified tierOrder", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    const origGetSafeLogger = _tierEscalationDeps.getSafeLogger;
    const mockLogger = makeLogger();
    _tierEscalationDeps.savePRD = () => Promise.resolve();
    _tierEscalationDeps.getSafeLogger = () => mockLogger as unknown as ReturnType<typeof origGetSafeLogger>;

    try {
      // Story whose agent ("codex") is not in the tierOrder (which only has "claude" rungs)
      const story = {
        id: "US-unmatched-001",
        title: "Story",
        description: "Test",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "in-progress" as const,
        passes: false,
        escalations: [],
        attempts: 5, // well above any tier's attempt budget — would skip if rung were found
        routing: { modelTier: "fast", testStrategy: "test-after", agent: "codex" },
      };

      const prd = {
        project: "test",
        feature: "f",
        branchName: "b",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [story],
      };

      const config = {
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", agent: "claude", attempts: 2 },
              { tier: "balanced", agent: "claude", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      };

      const result = await preIterationTierCheck(
        story as unknown as Parameters<typeof preIterationTierCheck>[0],
        { modelTier: "fast" },
        config as unknown as Parameters<typeof preIterationTierCheck>[2],
        prd as unknown as Parameters<typeof preIterationTierCheck>[3],
        "/tmp/test-prd-unmatched.json",
        undefined,
        { hooks: {} } as unknown as Parameters<typeof preIterationTierCheck>[6],
        "f",
        0,
        "/tmp",
      );

      // Unmatched rung → budget is unbounded → iteration proceeds (not skipped).
      expect(result.shouldSkipIteration).toBe(false);

      // A warn must be emitted so the silent-unlimited-budget path is observable.
      const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
      expect(warnCalls.length).toBeGreaterThan(0);
      const unmatchedWarn = warnCalls.find((c) =>
        c.message.includes("Current rung not found in tierOrder"),
      );
      expect(unmatchedWarn).toBeDefined();
      expect(unmatchedWarn?.data?.storyId).toBe("US-unmatched-001");
      expect(unmatchedWarn?.data?.agent).toBe("codex");
      expect(unmatchedWarn?.data?.hasAgentRungs).toBe(true);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
      _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
    }
  });
});
