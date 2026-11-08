/**
 * Tier Escalation — tier advance behaviour
 *
 * Integration tests for the escalation path:
 * - a failed story escalates to the next tier and keeps its test strategy
 * - the escalation is recorded on the story's priorFailures
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeEscalationContext,
  makeLogger,
  makeMockAgentManager,
  makeNaxConfig,
  makePRD,
  makeStory,
} from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation/tier-escalation";
import { pipelineEventBus } from "@/pipeline";

describe("handleTierEscalation — tier escalation regression guard", () => {
  test("still escalates tier for TEST_FAILURE (regression guard)", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });

  test("sets codex agent when escalating from claude/balanced to codex/fast (AC-5, AC-6)", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        routing: { modelTier: "balanced", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });

  test("does not set agent when tierOrder entry has no agent field (AC-4 backward compat)", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });

  test("does not emit story:escalated when story is still within tier budget", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

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
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    const origGetSafeLogger = _tierEscalationDeps.getSafeLogger;
    const mockLogger = makeLogger();
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();
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
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
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
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    let capturedPrd: import("@/prd").PRD | undefined;
    _tierEscalationDeps.savePrdProgress = async (prd) => {
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
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
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
      assertDefined(capturedPrd, "captured prd");

      const savedStory = capturedPrd.userStories.find((s) => s.id === "US-prior-001");
      assertDefined(savedStory, "saved story");

      // priorErrors: at least one entry mentioning the tier "fast"
      assertDefined(savedStory.priorErrors, "savedStory.priorErrors");
      expect(savedStory.priorErrors.length).toBeGreaterThanOrEqual(1);
      expect(savedStory.priorErrors.some((e) => e.includes("fast"))).toBe(true);

      // priorFailures: exactly 1 entry with modelTier "fast" and summary containing "budget"
      assertDefined(savedStory.priorFailures, "savedStory.priorFailures");
      expect(savedStory.priorFailures.length).toBe(1);
      const failure = savedStory.priorFailures[0];
      expect(failure.modelTier).toBe("fast");
      expect(failure.summary.toLowerCase()).toContain("budget");
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
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

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    let capturedPrd: import("@/prd").PRD | undefined;
    _tierEscalationDeps.savePrdProgress = async (prd) => {
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
        routing: { modelTier: "balanced", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
      assertDefined(capturedPrd, "captured prd");
      const savedStory = capturedPrd.userStories.find((s) => s.id === "US-provenance-001");
      assertDefined(savedStory, "saved story");

      // At least one escalation record must exist
      const escalations = savedStory.escalations;
      assertDefined(escalations, "savedStory.escalations");
      expect(escalations.length).toBeGreaterThanOrEqual(1);
      // The most recent escalation record must carry cross-agent provenance
      const record = escalations[escalations.length - 1];
      expect(record.fromAgent).toBe("claude");
      expect(record.toAgent).toBe("codex");
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — tier advance invariants (US-001)
//
// The escalation layer carries no runtime-crash same-tier retry and no
// TDD strategy switch. What remains is the ordinary ladder: a failed story
// moves exactly one rung up, keeps its test strategy, and records the
// failure under the "escalation" stage.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — tier advance invariants (US-001)", () => {
  const TIER_ORDER = [
    { tier: "fast", attempts: 1 },
    { tier: "balanced", attempts: 1 },
    { tier: "powerful", attempts: 1 },
  ];

  function makeLadderConfig() {
    return makeNaxConfig({
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: TIER_ORDER,
          escalateEntireBatch: false,
          resetMode: "initial",
        },
      },
      routing: { llm: { mode: "per-story" }, strategy: "keyword" },
      models: {},
    });
  }

  function makeThreeSessionStory() {
    return makeStory({
      id: "US-001",
      title: "Story",
      description: "Test",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "medium", reasoning: "", modelTier: "fast", testStrategy: "three-session-tdd" },
    });
  }

  test("AC-1: escalates to the next tier and leaves the test strategy unchanged", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

    try {
      const story = makeThreeSessionStory();
      const ctx = makeEscalationContext({
        story,
        routing: {
          complexity: "medium",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "test-fixture",
        },
        pipelineResult: { reason: "verify failed", context: {} },
        config: makeLadderConfig(),
      });

      const result = await handleTierEscalation(ctx);

      expect(result.outcome).toBe("escalated");
      const escalated = result.prd.userStories.find((s) => s.id === story.id);
      assertDefined(escalated, "escalated story");
      expect(escalated.routing?.modelTier).toBe("balanced");
      expect(escalated.routing?.testStrategy).toBe("three-session-tdd");
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });

  test("AC-2: records the escalation failure under the 'escalation' stage with no review findings", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

    try {
      const story = makeThreeSessionStory();
      const ctx = makeEscalationContext({
        story,
        routing: {
          complexity: "medium",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "test-fixture",
        },
        pipelineResult: { reason: "verify failed", context: {} },
        config: makeLadderConfig(),
      });

      const result = await handleTierEscalation(ctx);

      const escalated = result.prd.userStories.find((s) => s.id === story.id);
      assertDefined(escalated, "escalated story");
      const failures = escalated.priorFailures ?? [];
      expect(failures.length).toBeGreaterThan(0);
      const lastFailure = failures[failures.length - 1];
      expect(lastFailure.stage).toBe("escalation");
      expect(lastFailure.summary).toBe("Tier fast: verify failed");
      // The escalation failure carries no review findings — the escalation
      // layer no longer receives them.
      expect(Object.hasOwn(lastFailure, "reviewFindings")).toBe(false);
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });

  test("AC-3: a repeat escalation advances a rung instead of retrying the same tier", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { handleTierEscalation, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();

    try {
      const story = makeThreeSessionStory();
      const first = await handleTierEscalation(
        makeEscalationContext({
          story,
          routing: {
            complexity: "medium",
            modelTier: "fast",
            testStrategy: "three-session-tdd",
            reasoning: "test-fixture",
          },
          pipelineResult: { reason: "verify failed", context: {} },
          config: makeLadderConfig(),
        }),
      );
      expect(first.outcome).toBe("escalated");

      const escalatedStory = first.prd.userStories.find((s) => s.id === story.id);
      assertDefined(escalatedStory, "escalated story");

      const second = await handleTierEscalation(
        makeEscalationContext({
          story: escalatedStory,
          routing: {
            complexity: "medium",
            modelTier: "balanced",
            testStrategy: "three-session-tdd",
            reasoning: "test-fixture",
          },
          pipelineResult: { reason: "verify failed", context: {} },
          config: makeLadderConfig(),
          prd: first.prd,
        }),
      );

      expect(second.outcome).toBe("escalated");
      const twiceEscalated = second.prd.userStories.find((s) => s.id === story.id);
      assertDefined(twiceEscalated, "twice-escalated story");
      expect(twiceEscalated.routing?.modelTier).toBe("powerful");
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });
});
