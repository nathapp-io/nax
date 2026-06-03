/**
 * Tier Escalation — Runtime Crash Branching (BUG-070)
 *
 * Integration tests for escalation path branching:
 * - RUNTIME_CRASH → retry same tier (transient failure, not a code issue)
 * - TEST_FAILURE  → escalate to next tier (existing behaviour)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
                { name: "fast", attempts: 1 },
                { name: "balanced", attempts: 2 },
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
                { name: "fast", attempts: 1 },
                { name: "balanced", attempts: 2 },
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
