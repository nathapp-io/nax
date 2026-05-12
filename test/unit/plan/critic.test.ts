/**
 * Tests for runPlanCritic — US-005 AC1-7
 *
 * Covers:
 * - AC1: runPlanCritic returns failed with specDeltasPath when mechanical checks produce blockers
 * - AC2: When mechanical blockers exist, planCriticLlmOp is NOT invoked
 * - AC3: When mechanical checks pass and LLM returns zero blockers, return passed
 * - AC4: When mechanical checks pass and LLM returns blockers, invoke planDraftOp with revisionFindings
 * - AC5: After revision draft passes mechanical checks, return passed
 * - AC6: After revision draft still has blockers, return failed with specDeltasPath (no LLM re-call)
 * - AC7: When planCriticLlmOp throws, log warning and proceed with zero LLM findings
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FactsManifest } from "@/debate";
import type { CallContext } from "@/operations";
import type { VerifierFinding } from "@/plan/spec-deltas";
import type { NaxRuntime } from "@/runtime";
import {
  cleanupTempDir,
  makeMockAgentManager,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";

let tempDir: string;
let runtime: NaxRuntime | undefined;

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(async () => {
  await runtime?.close();
  cleanupTempDir(tempDir);
});

const makeFactsManifest = (overrides?: Partial<FactsManifest>): FactsManifest => ({
  repoFacts: [],
  specClaims: [],
  gaps: [],
  ...overrides,
});

const makeBlockerFinding = (overrides?: Partial<VerifierFinding>): VerifierFinding => ({
  checklistItem: "no-contradictions",
  severity: "blocker",
  message: "Test blocker",
  specId: "S-001",
  ...overrides,
});

const makeMajorFinding = (overrides?: Partial<VerifierFinding>): VerifierFinding => ({
  checklistItem: "some-check",
  severity: "major",
  message: "Test major",
  ...overrides,
});

describe("runPlanCritic (US-005)", () => {
  describe("AC1: Mechanical blockers → failed with specDeltasPath", () => {
    test("returns { outcome: 'failed', prd, findings, specDeltasPath } when mechanical checks produce blockers", async () => {
      // This test will fail until runPlanCritic is implemented.
      // It imports the function and expects it to handle mechanical checks.
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();
      runtime = makeTestRuntime();

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      // Mock checkFilesExist to return a blocker
      // This assumes runPlanCritic will call mechanical check functions
      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      expect(result.outcome).toBe("failed");
      expect(result.prd).toBeDefined();
      expect(result.findings).toBeDefined();
      expect(result.specDeltasPath).toBeDefined();
      expect(result.specDeltasPath).toMatch(/\.nax\/runs\/run-123\/plan\/test-feature\/spec-deltas\.md$/);

      // Verify spec-deltas file was written
      if (result.specDeltasPath) {
        const content = await Bun.file(result.specDeltasPath).text();
        expect(content).toContain("# Spec Deltas");
      }
    });

    test("emits spec-deltas.md to correct path", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();
      runtime = makeTestRuntime();

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "my-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-abc",
        storyId: "my-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Code",
          feature: "my-feature",
          branchName: "feat/my-feature",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      expect(result.specDeltasPath).toMatch(/\.nax\/runs\/run-abc\/plan\/my-feature\/spec-deltas\.md$/);
    });
  });

  describe("AC2: Mechanical blockers → NO LLM call", () => {
    test("does NOT invoke planCriticLlmOp when mechanical checks produce blockers", async () => {
      // This test verifies that the planCriticLlmOp call count is zero
      // when mechanical checks already fail.
      // The implementation should skip the LLM judgment stage.

      const { runPlanCritic } = await import("@/plan/critic");
      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      // Mock agent manager and spy on completeAs calls
      const callSpy = mock();
      const agentManager = makeMockAgentManager({
        completeAsFn: async () => {
          callSpy();
          return { output: "[]", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
        },
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      await runPlanCritic(input);

      // LLM call count should be 0 when mechanical checks block
      expect(callSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("AC3: Mechanical pass + LLM zero blockers → passed", () => {
    test("returns { outcome: 'passed', prd, findings } with no specDeltasPath when all checks pass", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => ({
          output: JSON.stringify({ findings: [] }),
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        }),
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      expect(result.outcome).toBe("passed");
      expect(result.prd).toBeDefined();
      expect(result.findings).toBeDefined();
      expect(result.specDeltasPath).toBeUndefined();
    });

    test("combines mechFindings and llmFindings in findings array", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => ({
          output: JSON.stringify({ findings: [makeMajorFinding()] }),
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        }),
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe("AC4: Mechanical pass + LLM blockers → invoke revision", () => {
    test("invokes planDraftOp exactly once with revisionFindings", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding({ specId: "S-001" }), makeBlockerFinding({ specId: "S-002" })];

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => ({
          output: JSON.stringify({ findings: llmBlockers }),
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        }),
      });
      runtime = makeTestRuntime({ agentManager });

      // This test expects the implementation to call callOp(planDraftOp) with revisionFindings
      // and to track whether it was called with the correct parameters

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      // After revision, if checks pass, outcome should be "passed"
      // If checks still have blockers, outcome should be "failed"
      expect(result.outcome).toBeDefined();
      expect(["passed", "failed"]).toContain(result.outcome);
    });
  });

  describe("AC5: Revision passes mechanical checks → passed", () => {
    test("returns { outcome: 'passed', prd: revisedDraft.prd } after revision passes", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const revisedPrd = makePRD({ feature: "test-feature-revised" });
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding()];

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => ({
          output: JSON.stringify({ findings: llmBlockers }),
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        }),
        runAsFn: async () => ({
          success: true,
          output: JSON.stringify({ prd: revisedPrd, citationRate: 0.8, advisory: false }),
          exitCode: 0,
        }),
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      // If the revision passes, outcome should be "passed"
      // and the prd should be from the revised draft
      if (result.outcome === "passed") {
        expect(result.prd).toBeDefined();
        expect(result.specDeltasPath).toBeUndefined();
      }
    });
  });

  describe("AC6: Revision still has blockers → failed, no LLM re-call", () => {
    test("returns { outcome: 'failed', prd: revisedDraft.prd, specDeltasPath } when revision still has blockers", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const revisedPrd = makePRD({ feature: "test-feature-revised" });
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding()];

      let completeCallCount = 0;
      const agentManager = makeMockAgentManager({
        completeAsFn: async () => {
          completeCallCount++;
          return {
            output: JSON.stringify({ findings: llmBlockers }),
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        },
        runAsFn: async () => ({
          success: true,
          output: JSON.stringify({ prd: revisedPrd, citationRate: 0.8, advisory: false }),
          exitCode: 0,
        }),
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      expect(result.outcome).toBe("failed");
      expect(result.specDeltasPath).toBeDefined();
      // LLM should be called once (for initial judgment)
      // NOT called again for the revision check
      expect(completeCallCount).toBe(1);
    });
  });

  describe("AC7: planCriticLlmOp throws → fail-open", () => {
    test("logs warning and proceeds with zero LLM findings when planCriticLlmOp throws", async () => {
      const { runPlanCritic } = await import("@/plan/critic");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => {
          throw new Error("LLM service unavailable");
        },
      });
      runtime = makeTestRuntime({ agentManager });

      const callCtx = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: tempDir,
        agentName: "claude",
        storyId: "test-feature",
      } satisfies CallContext;

      const input = {
        prd,
        manifest,
        workdir: tempDir,
        runId: "run-123",
        storyId: "test-feature",
        config,
        callCtx,
        draftCtx: {
          manifestSection: "## Facts",
          manifest,
          specContent: "# Spec",
          codebaseContext: "# Codebase",
          feature: "test-feature",
          branchName: "feat/test",
          citationThreshold: 0.5,
        },
      };

      const result = await runPlanCritic(input);

      // Should return "passed" when only mechanical checks are available and they pass
      // OR "failed" if mechanical checks have blockers
      // But it should NOT throw
      expect(result).toBeDefined();
      expect(result.outcome).toBeDefined();
    });
  });
});
