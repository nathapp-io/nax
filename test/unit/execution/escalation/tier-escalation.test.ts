/**
 * Tier Escalation — Runtime Crash Branching (BUG-070)
 *
 * Integration tests for escalation path branching:
 * - RUNTIME_CRASH → retry same tier (transient failure, not a code issue)
 * - TEST_FAILURE  → escalate to next tier (existing behaviour)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveMaxAttemptsOutcome } from "@/execution";
import type { EscalationHandlerContext } from "@/execution/escalation/tier-escalation";
import { pipelineEventBus } from "@/pipeline";
import { makeLogger, makeMockAgentManager, makeNaxConfig, makePRD, makeStory } from "@test/helpers";

// ---------------------------------------------------------------------------
// shouldRetrySameTier — pure predicate (BUG-070)
// ---------------------------------------------------------------------------

describe("shouldRetrySameTier", () => {
  test("returns true when verifyResult status is RUNTIME_CRASH", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "RUNTIME_CRASH", success: false })).toBe(true);
  });

  test("returns false when verifyResult status is TEST_FAILURE", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "TEST_FAILURE", success: false })).toBe(false);
  });

  test("returns false when verifyResult is undefined", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier(undefined)).toBe(false);
  });

  test("returns false when verifyResult status is TIMEOUT", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "TIMEOUT", success: false })).toBe(false);
  });

  test("returns false when verifyResult status is PASS", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "PASS", success: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveMaxAttemptsOutcome — runtime-crash category (BUG-070)
//
// When all attempts are exhausted for a story that kept crashing at runtime,
// it should pause (human review) not fail, since crashes are environmental.
// ---------------------------------------------------------------------------

describe("resolveMaxAttemptsOutcome — runtime-crash category", () => {
  test("returns pause for runtime-crash failure category", () => {
    expect(resolveMaxAttemptsOutcome("runtime-crash")).toBe("pause");
  });

  test("still returns fail for tests-failing (regression guard)", () => {
    expect(resolveMaxAttemptsOutcome("tests-failing")).toBe("fail");
  });

  test("returns fail for full-suite-gate-exhausted (regression guard)", () => {
    expect(resolveMaxAttemptsOutcome("full-suite-gate-exhausted")).toBe("fail");
  });

  test("still returns pause for verifier-rejected (regression guard)", () => {
    expect(resolveMaxAttemptsOutcome("verifier-rejected")).toBe("pause");
  });

  test("returns pause for review-incomplete (US-002: exhausted without review judgment → human review)", () => {
    expect(resolveMaxAttemptsOutcome("review-incomplete")).toBe("pause");
  });

  test("returns pause for no-tests-authored (exhausted without any tests authored → human review)", () => {
    expect(resolveMaxAttemptsOutcome("no-tests-authored")).toBe("pause");
  });
});

describe("handleTierEscalation — tier escalation regression guard", () => {
  test("still escalates tier for TEST_FAILURE (regression guard)", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 0,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 1 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        routing: {
          complexity: "medium",
          reasoning: "",
          modelTier: "fast",
          testStrategy: "test-after",
          agent: "claude",
        },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", agent: "claude", attempts: 3 },
                { tier: "balanced", agent: "claude", attempts: 2 },
                { tier: "fast", agent: "codex", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        routing: {
          complexity: "medium",
          reasoning: "",
          modelTier: "balanced",
          testStrategy: "test-after",
          agent: "claude",
        },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "balanced", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", agent: "claude", attempts: 3 },
                { tier: "balanced", agent: "claude", attempts: 2 },
                { tier: "fast", agent: "codex", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 0,
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 3 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-pre-iter-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        // attempts === tierCfg.attempts (1) → triggers escalation
        attempts: 1,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
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
      });

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-pre-iter.json",
        undefined,
        { hooks: {} },
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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-pre-iter-002",
        title: "Story",
        description: "Test",
        status: "in-progress",
        // attempts (0) < tierCfg.attempts (1) → no escalation
        attempts: 0,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
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
      });

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-pre-iter-2.json",
        undefined,
        { hooks: {} },
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
// BUG-5 story:failed tests: tier-escalation-story-failed.test.ts
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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-escalated-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 0,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 1 },
                { tier: "balanced", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd-escalated.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

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
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    const origGetSafeLogger = _tierEscalationDeps.getSafeLogger;
    const mockLogger = makeLogger();
    _tierEscalationDeps.savePRD = () => Promise.resolve();
    _tierEscalationDeps.getSafeLogger = () => mockLogger;

    try {
      // Story whose agent ("codex") is not in the tierOrder (which only has "claude" rungs)
      const story = makeStory({
        id: "US-unmatched-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 5, // well above any tier's attempt budget — would skip if rung were found
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after", agent: "codex" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
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
      });

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-unmatched.json",
        undefined,
        { hooks: {} },
        "f",
        0,
        "/tmp",
      );

      // Unmatched rung → budget is unbounded → iteration proceeds (not skipped).
      expect(result.shouldSkipIteration).toBe(false);

      // A warn must be emitted so the silent-unlimited-budget path is observable.
      const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
      expect(warnCalls.length).toBeGreaterThan(0);
      const unmatchedWarn = warnCalls.find((c) => c.message.includes("Current rung not found in tierOrder"));
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

// ---------------------------------------------------------------------------
// preIterationTierCheck — ADR-025 gap #3: priorErrors / priorFailures captured
//
// When a story exhausts its per-rung attempt budget before an iteration spawns,
// the saved PRD must carry priorErrors and priorFailures so the next tier's
// agent prompt has context about why escalation happened.
// ---------------------------------------------------------------------------

describe("preIterationTierCheck — ADR-025 gap #3: prior context captured on budget exhaustion", () => {
  test("saves priorErrors and priorFailures when story budget is exhausted (AC)", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    let capturedPrd: import("@/prd").PRD | undefined;
    _tierEscalationDeps.savePRD = async (prd) => {
      capturedPrd = prd as import("@/prd").PRD;
    };

    try {
      const story = makeStory({
        id: "US-prior-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        // attempts === tierCfg.attempts (2) → budget exhausted
        attempts: 2,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 2 },
              { tier: "balanced", attempts: 3 },
            ],
          },
        },
        // per-story mode bypasses LLM re-route
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      });

      const result = await preIterationTierCheck(
        story,
        { modelTier: "fast" },
        config,
        prd,
        "/tmp/test-prd-prior.json",
        undefined,
        { hooks: {} },
        "f",
        0,
        "/tmp",
      );

      // Escalation must have been triggered
      expect(result.shouldSkipIteration).toBe(true);

      // savePRD must have been called with a PRD capturing prior context
      expect(capturedPrd).toBeDefined();

      const savedStory = capturedPrd!.userStories.find((s) => s.id === "US-prior-001");
      expect(savedStory).toBeDefined();

      // priorErrors: at least one entry mentioning the tier "fast"
      expect(savedStory!.priorErrors).toBeDefined();
      expect((savedStory!.priorErrors ?? []).length).toBeGreaterThanOrEqual(1);
      expect((savedStory!.priorErrors ?? []).some((e) => e.includes("fast"))).toBe(true);

      // priorFailures: exactly 1 entry with modelTier "fast" and summary containing "budget"
      expect(savedStory!.priorFailures).toBeDefined();
      expect((savedStory!.priorFailures ?? []).length).toBe(1);
      const failure = (savedStory!.priorFailures ?? [])[0];
      expect(failure.modelTier).toBe("fast");
      expect(failure.summary.toLowerCase()).toContain("budget");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — ADR-025 gap #2: cross-agent escalation provenance
//
// When the tierOrder has agent-qualified rungs and a story escalates to a
// different agent, the escalation record must capture fromAgent / toAgent
// so the audit trail can distinguish a cross-agent jump from a same-agent
// tier bump.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — ADR-025 gap #2: cross-agent escalation provenance", () => {
  test("escalation record includes fromAgent and toAgent on cross-agent escalation", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    let capturedPrd: import("@/prd").PRD | undefined;
    _tierEscalationDeps.savePRD = async (prd) => {
      capturedPrd = prd as import("@/prd").PRD;
    };

    try {
      const story = makeStory({
        id: "US-provenance-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        routing: {
          complexity: "medium",
          reasoning: "",
          modelTier: "balanced",
          testStrategy: "test-after",
          agent: "claude",
        },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "balanced", testStrategy: "test-after" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", agent: "claude", attempts: 3 },
                { tier: "balanced", agent: "claude", attempts: 2 },
                { tier: "fast", agent: "codex", attempts: 2 },
              ],
              escalateEntireBatch: false,
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd-provenance.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
      };

      const result = await handleTierEscalation(ctx);

      expect(result.outcome).toBe("escalated");

      // savePRD must have been called
      expect(capturedPrd).toBeDefined();

      const savedStory = capturedPrd!.userStories.find((s) => s.id === "US-provenance-001");
      expect(savedStory).toBeDefined();

      // At least one escalation record must exist
      expect((savedStory!.escalations ?? []).length).toBeGreaterThanOrEqual(1);

      // The most recent escalation record must carry cross-agent provenance
      const record = savedStory!.escalations![savedStory!.escalations!.length - 1];
      expect(record.fromAgent).toBe("claude");
      expect(record.toAgent).toBe("codex");
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — runtime-crash retry-same (US-002)
//
// The verify layer no longer threads a parallel runtimeCrashResult — instead
// the runtime-crash signal rides on `pipelineResult.context.tddFailureCategory`
// and the pipeline-result handler is expected to derive a runtimeCrashResult
// from it. These tests pin the contract on the receiving side: a context that
// already carries a runtimeCrashResult must short-circuit to "retry-same"
// (no tier advance, no PRD mutation, no savePRD) so the next iteration can
// re-run on the same tier.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — runtime-crash retry-same (US-002)", () => {
  test("returns outcome: 'retry-same' when runtimeCrashResult is RUNTIME_CRASH (AC-4)", async () => {
    const mod = await import("@/execution/escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    let saveCalls = 0;
    _tierEscalationDeps.savePRD = () => {
      saveCalls++;
      return Promise.resolve();
    };

    try {
      const story = makeStory({
        id: "US-002-retry-1",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 2,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Bun runtime crash", context: { tddFailureCategory: "runtime-crash" } },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 2 },
                { tier: "balanced", attempts: 3 },
              ],
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: makePRD({
          project: "test",
          feature: "f",
          branchName: "b",
          userStories: [story],
        }),
        prdPath: "/tmp/test-prd-us002-retry-1.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        runtimeCrashResult: { status: "RUNTIME_CRASH", success: false },
      };

      const result = await handleTierEscalation(ctx);

      expect(result.outcome).toBe("retry-same");
      // retry-same must not write to disk — a save here would corrupt the
      // existing in-flight PRD with a tier-unchanged-but-prdDirty=true record
      expect(saveCalls).toBe(0);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("returns prdDirty: false and the unmodified PRD by reference when outcome is 'retry-same' (AC-5)", async () => {
    const mod = await import("@/execution/escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = () => Promise.resolve();

    try {
      const story = makeStory({
        id: "US-002-retry-2",
        title: "Story",
        description: "Test",
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", reasoning: "", modelTier: "balanced", testStrategy: "test-after" },
      });

      const originalPrd = {
        project: "test",
        feature: "f",
        branchName: "b",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [story],
      };

      const ctx: EscalationHandlerContext = {
        story,
        agentManager: makeMockAgentManager(),
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "balanced", testStrategy: "test-after" },
        pipelineResult: { reason: "Runtime crash", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 2 },
                { tier: "balanced", attempts: 3 },
              ],
              resetMode: "initial",
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        }),
        prd: originalPrd,
        prdPath: "/tmp/test-prd-us002-retry-2.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        runtimeCrashResult: { status: "RUNTIME_CRASH", success: false },
      };

      const result = await handleTierEscalation(ctx);

      expect(result.outcome).toBe("retry-same");
      expect(result.prdDirty).toBe(false);
      // PRD reference must be unchanged — no copy, no new object
      expect(result.prd).toBe(originalPrd);
      // The story in the result must also be the same reference (no spread)
      expect(result.prd.userStories[0]).toBe(story);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});
