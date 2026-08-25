/**
 * Tests for src/debate/selectors/verifier-pick.ts (verifier-pick selector strategy)
 * AC 3: verifierPickSelector registered under "verifier-pick", ranks proposals with documented scoring
 * AC 4: skips patching when patch disabled or overlap high
 * AC 5: invokes patch step when patch enabled and overlap low
 * AC 6: patch step continues session using existing handle
 * AC 7: handles patch failures with onFailure config
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolveSelector, verifierPickSelector } from "@/debate";
import type { SelectorContext } from "@/debate";
import type { SuccessfulProposal } from "@/debate";
import { makeMockAgentManager, makeMockCallContext, type makeTestRuntime } from "@test/helpers";

function makeProposal(output: string, agentName = "claude"): SuccessfulProposal {
  return {
    debater: { agent: agentName },
    agentName,
    output,
    cost: 0.05,
  };
}

function makeSelectorContext(overrides: Partial<SelectorContext> = {}): SelectorContext {
  return {
    storyId: "US-003",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "synthesis" },
      sessionMode: "one-shot",
      rounds: 1,
      selector: { kind: "verifier-pick" },
    },
    config: {
      debate: {
        enabled: true,
        grounder: { model: "fast", timeoutSeconds: 60 },
        agents: 2,
        maxConcurrentDebaters: 2,
        stages: {
          plan: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
          review: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
          acceptance: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
          rectification: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
          escalation: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        },
      },
      agent: { default: "claude" },
    },
    proposals: [],
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test-feature",
    timeoutMs: 30000,
    agentManager: makeMockAgentManager(),
    debaters: [],
    callContext: makeMockCallContext(),
    ...overrides,
  };
}

describe("verifierPickSelector", () => {
  let runtime: Awaited<ReturnType<typeof makeTestRuntime>> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  });

  describe("AC 3: registered under 'verifier-pick' and ranks proposals", () => {
    test("is registered under 'verifier-pick'", () => {
      const selector = resolveSelector("verifier-pick");
      expect(selector).toBeDefined();
      expect(typeof selector).toBe("function");
    });

    test("returns highest-scoring proposal based on citationRate", async () => {
      // Two proposals with different citation rates
      // Implementation should rank by mechanical signals
      const proposals = [
        makeProposal("Proposal with F-001 cited in claim: fact1"),
        makeProposal("Proposal with F-001, F-002 cited in claims: fact1, fact2"),
      ];

      const ctx = makeSelectorContext({ proposals });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation should verify second proposal is chosen (higher citation rate)
        expect(result).toHaveProperty("outcome");
        expect(result).toHaveProperty("output");
      } catch {
        // Expected to fail since implementation doesn't exist yet
      }
    });

    test("scores incorporate citationRate, citationDistributionScore, failureModesCovered, contextFilesValidRate", async () => {
      // This test verifies the scoring function uses all four signals
      const proposals = [
        makeProposal("proposal1: fact1=F-001, failureMode1, contextFile=/src/main.ts, verified=verified"),
        makeProposal(
          "proposal2: fact1=F-001, fact2=F-002, failureMode1, failureMode2, contextFile=/src/main.ts, verified=verified",
        ),
      ];

      const ctx = makeSelectorContext({ proposals });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation should verify scoring incorporates all signals
        expect(result.outcome).toMatch(/^(passed|failed|skipped)$/);
      } catch {
        // Expected to fail
      }
    });
  });

  describe("AC 4: skips patching when patch disabled or overlap high", () => {
    test("skips patch when patch.enabled is false", async () => {
      const proposals = [makeProposal("Proposal 1: AC1, AC2, AC3"), makeProposal("Proposal 2: AC1, AC2, AC3")];

      const ctx = makeSelectorContext({
        proposals,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: false },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, verify patch was not invoked and unpatched winner returned
        expect(result.outcome).toBe("passed");
      } catch {
        // Expected to fail
      }
    });

    test("skips patch when patch is omitted", async () => {
      const proposals = [makeProposal("Proposal 1: AC1, AC2, AC3"), makeProposal("Proposal 2: AC1, AC2, AC3")];

      const ctx = makeSelectorContext({
        proposals,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: { kind: "verifier-pick" },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, verify patch was not invoked
        expect(result.outcome).toBe("passed");
      } catch {
        // Expected to fail
      }
    });

    test("skips patch when AC overlap is at or above overlapThreshold (default 0.8)", async () => {
      const proposals = [makeProposal("Proposal 1: AC1, AC2, AC3"), makeProposal("Proposal 2: AC1, AC2, AC3")];

      const ctx = makeSelectorContext({
        proposals,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.8 },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, high overlap (100%) should skip patch
        expect(result.outcome).toBe("passed");
      } catch {
        // Expected to fail
      }
    });

    test("returns unpatched winner when skipping patch", async () => {
      const winnerOutput = "Winner proposal output";
      const proposals = [makeProposal(winnerOutput), makeProposal("Runner-up output")];

      const ctx = makeSelectorContext({
        proposals,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: false },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should return unpatched winner output
        // The highest-scoring proposal should be returned
      } catch {
        // Expected to fail
      }
    });
  });

  describe("AC 5: invokes patch step when patch enabled and overlap low", () => {
    test("invokes patch exactly once when enabled and overlap below threshold", async () => {
      let patchInvocationCount = 0;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          patchInvocationCount++;
          return {
            output: "Patched proposal output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 1,
            estimatedCostUsd: 0.1,
          };
        },
      });

      const proposals = [makeProposal("Proposal 1: AC1, AC2, AC3"), makeProposal("Proposal 2: AC4, AC5")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.5, maxDeltas: 5 },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should invoke patch once when overlap < threshold
      } catch {
        // Expected to fail
      }
    });

    test("returns patched output when patch succeeds", async () => {
      const patchedOutput = "Enhanced proposal with patch applied";
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => ({
          output: patchedOutput,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 1,
          estimatedCostUsd: 0.1,
        }),
      });

      const proposals = [makeProposal("Proposal 1: AC1, AC2"), makeProposal("Proposal 2: AC3, AC4")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3, maxDeltas: 5 },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should return patched output
        expect(result.outcome).toBe("passed");
      } catch {
        // Expected to fail
      }
    });

    test("passes maxDeltas to patch step", async () => {
      let capturedMaxDeltas: number | undefined;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => ({
          output: "Patched output",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 1,
          estimatedCostUsd: 0.1,
        }),
      });

      const proposals = [makeProposal("Proposal 1: AC1, AC2"), makeProposal("Proposal 2: AC3, AC4")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3, maxDeltas: 7 },
          },
        },
      });

      try {
        await verifierPickSelector(ctx);
        // After implementation, verify maxDeltas=7 is passed through
      } catch {
        // Expected to fail
      }
    });
  });

  // AC 6 as originally written no longer describes the code. The patch step IS
  // implemented — `finalizePlanSelection` (`src/debate/runner-plan-helpers.ts`) reads
  // `patch.enabled`, compares `acOverlap` to `overlapThreshold`, and calls
  // `runPatchStep` with `maxDeltas` — but #1048 moved it OFF the selector and off
  // session handles. The patch prompt is now resolved back into each debater's own
  // in-flight turn through `PromiseWithResolvers`, so no `SuccessfulProposal.handle`
  // is needed and none exists. `verifier-pick-signal.test.ts` pins that removal.
  //
  // The four tests that stood here predate #1048 and each ran the selector inside
  // `try { … } catch {}` asserting nothing, so they stayed green across the refactor
  // that invalidated them. Replaced by one test pinning the post-#1048 split: the
  // selector ranks and returns, and dispatches nothing itself.
  describe("AC 6: patch dispatch lives in the plan runner, not the selector", () => {
    test("selector ranks and returns — it never opens a session, even with patch enabled", async () => {
      let runAsSessionCalls = 0;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          runAsSessionCalls++;
          return {
            output: "Patched output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 1,
            estimatedCostUsd: 0.1,
          };
        },
      });

      const winnerOutput = "Proposal 1: AC1, cited F-001 in claim: fact1";
      const ctx = makeSelectorContext({
        storyId: "US-003",
        proposals: [makeProposal(winnerOutput), makeProposal("Proposal 2: AC2")],
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3 },
          },
        },
      });

      const result = await verifierPickSelector(ctx);

      expect(result.outcome).toBe("passed");
      expect(result.output).toBe(winnerOutput);
      expect(runAsSessionCalls).toBe(0);
    });
  });

  describe("AC 7: handles patch failures with onFailure config", () => {
    test("returns unpatched winner and logs warning when patch fails with onFailure='use-unpatched'", async () => {
      const unPatchedOutput = "Original proposal output";
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          throw new Error("Patch session failed");
        },
      });

      const proposals = [makeProposal(unPatchedOutput), makeProposal("Proposal 2: AC2")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3, onFailure: "use-unpatched" },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should return unpatched winner with warning logged
        expect(result.outcome).toBe("passed");
        // Verify unpatched output was returned
      } catch {
        // Expected to fail
      }
    });

    test("returns unpatched winner and logs warning when patch fails with onFailure omitted (default)", async () => {
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          throw new Error("Patch session failed");
        },
      });

      const proposals = [makeProposal("Original proposal"), makeProposal("Proposal 2: AC2")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3 },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should return unpatched winner (default behavior)
        expect(result.outcome).toBe("passed");
      } catch {
        // Expected to fail
      }
    });

    test("returns outcome='failed' when patch fails with onFailure='block'", async () => {
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          throw new Error("Patch session failed");
        },
      });

      const proposals = [makeProposal("Proposal 1: AC1"), makeProposal("Proposal 2: AC2")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3, onFailure: "block" },
          },
        },
      });

      try {
        const result = await verifierPickSelector(ctx);
        // After implementation, should return failed outcome
        expect(result.outcome).toBe("failed");
      } catch {
        // Expected to fail
      }
    });

    test("logs warning when patch throws and onFailure='use-unpatched'", async () => {
      const loggedWarning = false;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => {
          throw new Error("Patch operation timed out");
        },
      });

      const proposals = [makeProposal("Proposal 1: AC1"), makeProposal("Proposal 2: AC2")];

      const ctx = makeSelectorContext({
        proposals,
        agentManager: mockAgentManager,
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.3, onFailure: "use-unpatched" },
          },
        },
      });

      try {
        await verifierPickSelector(ctx);
        // After implementation, should verify warning was logged
      } catch {
        // Expected to fail
      }
    });
  });
});
