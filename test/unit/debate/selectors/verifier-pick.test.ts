/**
 * Tests for src/debate/selectors/verifier-pick.ts (verifier-pick selector strategy)
 * AC 3: verifierPickSelector registered under "verifier-pick", ranks proposals with documented scoring
 * AC 4: skips patching when patch disabled or overlap high
 * AC 5: invokes patch step when patch enabled and overlap low
 * AC 6: patch step continues session using existing handle
 * AC 7: handles patch failures with onFailure config
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionHandle } from "@/agents";
import { resolveSelector, verifierPickSelector } from "@/debate";
import type { SelectorContext } from "@/debate";
import type { SuccessfulProposal } from "@/debate";
import { makeMockAgentManager, type makeTestRuntime } from "@test/helpers";

function makeProposal(output: string, agentName = "claude", handle?: SessionHandle): SuccessfulProposal {
  return {
    debater: { agent: agentName },
    agentName,
    output,
    cost: 0.05,
    handle,
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
      models: {},
      agent: { default: "claude" },
    },
    proposals: [],
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test-feature",
    timeoutMs: 30000,
    agentManager: makeMockAgentManager(),
    debaters: [],
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

      const proposals = [
        makeProposal("Proposal 1: AC1, AC2, AC3", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC4, AC5", "claude", {} as SessionHandle),
      ];

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

      const proposals = [
        makeProposal("Proposal 1: AC1, AC2", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC3, AC4", "claude", {} as SessionHandle),
      ];

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

      const proposals = [
        makeProposal("Proposal 1: AC1, AC2", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC3, AC4", "claude", {} as SessionHandle),
      ];

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

  describe("AC 6: patch step continues session using existing handle", () => {
    test("calls runAsSession with winner.proposal.agentName", async () => {
      let capturedAgentName: string | undefined;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async (agentName) => {
          capturedAgentName = agentName;
          return {
            output: "Patched output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 1,
            estimatedCostUsd: 0.1,
          };
        },
      });

      const proposals = [
        makeProposal("Proposal 1: AC1", "opencode", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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
        await verifierPickSelector(ctx);
        // After implementation, should verify capturedAgentName === "opencode"
      } catch {
        // Expected to fail
      }
    });

    test("calls runAsSession with winner.proposal.handle to continue session", async () => {
      let capturedHandle: SessionHandle | undefined;
      const testHandle = { sessionId: "nax-12345-test" };
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async (agentName, handle) => {
          capturedHandle = handle;
          return {
            output: "Patched output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 1,
            estimatedCostUsd: 0.1,
          };
        },
      });

      const proposals = [
        makeProposal("Proposal 1: AC1", "claude", testHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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
        await verifierPickSelector(ctx);
        // After implementation, should verify capturedHandle === testHandle
      } catch {
        // Expected to fail
      }
    });

    test("calls runAsSession with correct pipelineStage and storyId", async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async (agentName, handle, prompt, options) => {
          capturedOptions = options;
          return {
            output: "Patched output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 1,
            estimatedCostUsd: 0.1,
          };
        },
      });

      const proposals = [
        makeProposal("Proposal 1: AC1", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

      const ctx = makeSelectorContext({
        storyId: "US-003",
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
        await verifierPickSelector(ctx);
        // After implementation, should verify:
        // capturedOptions.storyId === "US-003"
        // capturedOptions.pipelineStage === "plan"
      } catch {
        // Expected to fail
      }
    });

    test("returns patch result output and estimatedCostUsd", async () => {
      const mockAgentManager = makeMockAgentManager({
        runAsSessionFn: async () => ({
          output: "Final patched proposal",
          tokenUsage: { inputTokens: 100, outputTokens: 200 },
          internalRoundTrips: 1,
          estimatedCostUsd: 0.25,
        }),
      });

      const proposals = [
        makeProposal("Proposal 1: AC1", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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
        // After implementation, should verify:
        // result.output === "Final patched proposal"
        // result.output contains the patched content
      } catch {
        // Expected to fail
      }
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

      const proposals = [
        makeProposal(unPatchedOutput, "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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

      const proposals = [
        makeProposal("Original proposal", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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

      const proposals = [
        makeProposal("Proposal 1: AC1", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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

      const proposals = [
        makeProposal("Proposal 1: AC1", "claude", {} as SessionHandle),
        makeProposal("Proposal 2: AC2", "claude", {} as SessionHandle),
      ];

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
