/**
 * Tier Escalation — Runtime Crash Branching (BUG-070)
 *
 * Integration tests for escalation path branching:
 * - RUNTIME_CRASH → retry same tier (transient failure, not a code issue)
 * - TEST_FAILURE  → escalate to next tier (existing behaviour)
 *
 * Tests are RED until handleTierEscalation() checks verifyResult.status
 * and returns "retry-same" for RUNTIME_CRASH rather than escalating the tier.
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// shouldRetrySameTier — pure predicate (BUG-070)
//
// RED: This function does not exist yet. It will be exported from
// src/execution/escalation/tier-escalation.ts as part of the implementation.
// ---------------------------------------------------------------------------

describe("shouldRetrySameTier", () => {
  test("returns true when verifyResult status is RUNTIME_CRASH", async () => {
    // RED: shouldRetrySameTier is not exported yet — import will return undefined
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    // @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      // @ts-expect-error: RUNTIME_CRASH not in VerifyStatus until BUG-070 is implemented
      shouldRetrySameTier({ status: "RUNTIME_CRASH", success: false }),
    ).toBe(true);
  });

  test("returns false when verifyResult status is TEST_FAILURE", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    // @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "TEST_FAILURE", success: false }),
    ).toBe(false);
  });

  test("returns false when verifyResult is undefined", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    // @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier(undefined)).toBe(false);
  });

  test("returns false when verifyResult status is TIMEOUT", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    // @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented
    const { shouldRetrySameTier } = mod;

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(
      shouldRetrySameTier({ status: "TIMEOUT", success: false }),
    ).toBe(false);
  });

  test("returns false when verifyResult status is PASS", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    // @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented
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

    // RED: "runtime-crash" is not in FailureCategory yet — returns "fail" currently
    expect(
      // @ts-expect-error: runtime-crash not in FailureCategory until BUG-070 is implemented
      resolveMaxAttemptsOutcome("runtime-crash"),
    ).toBe("pause");
  });

  test("still returns fail for tests-failing (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("tests-failing")).toBe("fail");
  });

  test("still returns pause for verifier-rejected (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("verifier-rejected")).toBe("pause");
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation outcome — RUNTIME_CRASH produces retry-same
//
// When the pipeline escalates due to a RUNTIME_CRASH verifyResult,
// handleTierEscalation should return outcome="retry-same" and NOT change
// the story's modelTier in the PRD.
//
// RED: EscalationHandlerContext does not yet have verifyResult field.
//      handleTierEscalation does not yet return "retry-same".
//      _tierEscalationDeps does not yet exist for mocking savePRD.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — RUNTIME_CRASH retries same tier", () => {
  test("returns retry-same outcome when verifyResult is RUNTIME_CRASH", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation } = mod;

    // _tierEscalationDeps does not exist yet — this will fail when implemented
    // @ts-expect-error: _tierEscalationDeps does not exist until BUG-070 is implemented
    const { _tierEscalationDeps } = mod;

    if (_tierEscalationDeps) {
      // Mock savePRD to prevent file I/O in tests
      const origSavePRD = _tierEscalationDeps.savePRD;
      _tierEscalationDeps.savePRD = () => Promise.resolve();

      try {
        const story = {
          id: "US-001",
          title: "Test Story",
          description: "Test",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "in-progress" as const,
          passes: false,
          escalations: [],
          attempts: 1,
          routing: { modelTier: "fast", testStrategy: "test-after" },
        };

        const ctx = {
          story,
          storiesToExecute: [story],
          isBatchExecution: false,
          routing: { modelTier: "fast", testStrategy: "test-after" },
          pipelineResult: {
            reason: "Tests failed",
            context: {},
          },
          config: {
            autoMode: {
              escalation: {
                enabled: true,
                tierOrder: [
                  { name: "fast", attempts: 3 },
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
            feature: "test-feature",
            branchName: "test-branch",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            userStories: [story],
          },
          prdPath: "/tmp/test-prd.json",
          featureDir: undefined,
          hooks: { hooks: {} },
          feature: "test-feature",
          totalCost: 0,
          workdir: "/tmp",
          // verifyResult with RUNTIME_CRASH — not yet in EscalationHandlerContext type
          verifyResult: { status: "RUNTIME_CRASH", success: false },
        };

        // RED: outcome will be "escalated" until RUNTIME_CRASH branch is implemented
        const result = await handleTierEscalation(ctx as Parameters<typeof handleTierEscalation>[0]);
        expect(result.outcome).toBe("retry-same");
      } finally {
        if (_tierEscalationDeps) {
          _tierEscalationDeps.savePRD = origSavePRD;
        }
      }
    } else {
      // _tierEscalationDeps not exported yet — test must fail explicitly
      expect(_tierEscalationDeps).not.toBeUndefined();
    }
  });

  test("does NOT change story modelTier in PRD when RUNTIME_CRASH", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation } = mod;
    // @ts-expect-error: _tierEscalationDeps does not exist until BUG-070 is implemented
    const { _tierEscalationDeps } = mod;

    if (_tierEscalationDeps) {
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
          attempts: 1,
          routing: { modelTier: "fast", testStrategy: "test-after" },
        };

        const prd = {
          project: "test",
          feature: "test-feature",
          branchName: "test-branch",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        };

        const ctx = {
          story,
          storiesToExecute: [story],
          isBatchExecution: false,
          routing: { modelTier: "fast", testStrategy: "test-after" },
          pipelineResult: { reason: "crash", context: {} },
          config: {
            autoMode: {
              escalation: {
                enabled: true,
                tierOrder: [
                  { name: "fast", attempts: 3 },
                  { name: "balanced", attempts: 2 },
                ],
                escalateEntireBatch: false,
              },
            },
            routing: { llm: { mode: "per-story" }, strategy: "keyword" },
            models: {},
          },
          prd,
          prdPath: "/tmp/test-prd.json",
          featureDir: undefined,
          hooks: { hooks: {} },
          feature: "test-feature",
          totalCost: 0,
          workdir: "/tmp",
          verifyResult: { status: "RUNTIME_CRASH", success: false },
        };

        const result = await handleTierEscalation(ctx as Parameters<typeof handleTierEscalation>[0]);

        // The story's tier must NOT change to "balanced" — same tier retry
        const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
        expect(updatedStory?.routing?.modelTier ?? "fast").toBe("fast");
      } finally {
        if (_tierEscalationDeps) {
          _tierEscalationDeps.savePRD = origSavePRD;
        }
      }
    } else {
      expect(_tierEscalationDeps).not.toBeUndefined();
    }
  });

  test("still escalates tier for TEST_FAILURE (regression guard)", async () => {
    const mod = await import("../../../../src/execution/escalation/tier-escalation");
    const { handleTierEscalation } = mod;
    // @ts-expect-error: _tierEscalationDeps does not exist until BUG-070 is implemented
    const { _tierEscalationDeps } = mod;

    if (_tierEscalationDeps) {
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

        const result = await handleTierEscalation(ctx as Parameters<typeof handleTierEscalation>[0]);

        // TEST_FAILURE must still escalate — existing behaviour preserved
        expect(result.outcome).toBe("escalated");
      } finally {
        if (_tierEscalationDeps) {
          _tierEscalationDeps.savePRD = origSavePRD;
        }
      }
    } else {
      expect(_tierEscalationDeps).not.toBeUndefined();
    }
  });
});
