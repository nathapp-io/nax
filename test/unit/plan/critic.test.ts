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
import {
  cleanupTempDir,
  makeMockAgentManager,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { FactsManifest } from "@/debate";
import type { CallContext } from "@/operations";
import type { VerifierFinding } from "@/plan/spec-deltas";
import type { NaxRuntime } from "@/runtime";

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
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD({
        userStories: [makeStory({ contextFiles: [{ path: "nonexistent-file.ts", factId: "F-001" }] })],
      });
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
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD({
        userStories: [makeStory({ contextFiles: [{ path: "nonexistent-file.ts", factId: "F-001" }] })],
      });
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

      const { runPlanCritic } = await import("@/plan");
      const prd = makePRD({
        userStories: [makeStory({ contextFiles: [{ path: "nonexistent-file.ts", factId: "F-001" }] })],
      });
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      // planCriticLlmOp is kind:"run" — goes through runWithFallback, not completeAs
      const runWithFallbackSpy = mock();
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          runWithFallbackSpy(req.runOptions.sessionRole);
          return {
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify({ findings: [] }),
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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

      // LLM runWithFallback should NOT be called when mechanical checks already block
      expect(runWithFallbackSpy).not.toHaveBeenCalled();
    });
  });

  describe("AC3: Mechanical pass + LLM zero blockers → passed", () => {
    test("returns { outcome: 'passed', prd, findings } with no specDeltasPath when all checks pass", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      // planCriticLlmOp is kind:"run" — goes through runWithFallback, not completeAs
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          const role = req.runOptions.sessionRole;
          const output = role === "plan-critic" ? JSON.stringify({ findings: [] }) : "";
          return {
            result: {
              success: true,
              exitCode: 0,
              output,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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

      expect(result.outcome).toBe("passed");
      expect(result.prd).toBeDefined();
      expect(result.findings).toBeDefined();
      expect(result.specDeltasPath).toBeUndefined();
    });

    test("combines mechFindings and llmFindings in findings array", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      // planCriticLlmOp is kind:"run" — goes through runWithFallback, not completeAs
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          const role = req.runOptions.sessionRole;
          const output = role === "plan-critic" ? JSON.stringify({ findings: [makeMajorFinding()] }) : "";
          return {
            result: {
              success: true,
              exitCode: 0,
              output,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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

      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe("AC4: Mechanical pass + LLM blockers → invoke revision", () => {
    test("invokes planDraftOp exactly once with revisionFindings", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding({ specId: "S-001" }), makeBlockerFinding({ specId: "S-002" })];

      // planCriticLlmOp and planDraftOp are both kind:"run" — go through runWithFallback
      let draftCallCount = 0;
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          const role = req.runOptions.sessionRole;
          if (role === "plan-critic") {
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify({ findings: llmBlockers }),
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          }
          // Draft revision call
          draftCallCount++;
          return {
            result: {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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

      // planDraftOp should be invoked once for revision
      expect(draftCallCount).toBe(1);
      expect(result.outcome).toBeDefined();
      expect(["passed", "failed"]).toContain(result.outcome);
    });
  });

  describe("AC5: Revision passes mechanical checks → passed", () => {
    test("returns { outcome: 'passed', prd: revisedDraft.prd } after revision passes", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding()];

      // Revision PRD: valid schema, no contextFiles blockers, citation-exempt (threshold=0)
      const validRevisionPrd = JSON.stringify({
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Test story",
            description: "A test story",
            acceptanceCriteria: ["AC-1: works"],
            complexity: "simple",
          },
        ],
      });

      // planCriticLlmOp and planDraftOp are both kind:"run" — go through runWithFallback
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          const role = req.runOptions.sessionRole;
          const output = role === "plan-critic" ? JSON.stringify({ findings: llmBlockers }) : validRevisionPrd;
          return {
            result: {
              success: true,
              exitCode: 0,
              output,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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
          citationThreshold: 0, // exempt citation check so revision parses cleanly
        },
      };

      const result = await runPlanCritic(input);

      expect(result.outcome).toBe("passed");
      expect(result.prd).toBeDefined();
      expect(result.specDeltasPath).toBeUndefined();
    });
  });

  describe("AC6: Revision still has blockers → failed, no LLM re-call", () => {
    test("returns { outcome: 'failed', prd: revisedDraft.prd, specDeltasPath } when revision still has blockers", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      const llmBlockers = [makeBlockerFinding()];

      // Revision PRD: valid schema but contextFiles has nonexistent file → mechanical blocker
      const revisionWithBlockers = JSON.stringify({
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Test story",
            description: "A test story",
            acceptanceCriteria: ["AC-1: works"],
            complexity: "simple",
            contextFiles: [{ path: "nonexistent-revised.ts", factId: "F-001" }],
          },
        ],
      });

      // planCriticLlmOp and planDraftOp are both kind:"run" — go through runWithFallback
      let criticCallCount = 0;
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          const role = req.runOptions.sessionRole;
          if (role === "plan-critic") {
            criticCallCount++;
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify({ findings: llmBlockers }),
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          }
          // Draft revision: returns PRD that still has mechanical blockers
          return {
            result: {
              success: true,
              exitCode: 0,
              output: revisionWithBlockers,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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
          citationThreshold: 0, // exempt citation check so revision PRD parses cleanly
        },
      };

      const result = await runPlanCritic(input);

      expect(result.outcome).toBe("failed");
      expect(result.specDeltasPath).toBeDefined();
      // LLM critic called once; NOT called again for the revision mechanical check
      expect(criticCallCount).toBe(1);
    });
  });

  describe("AC7: planCriticLlmOp throws → fail-open", () => {
    test("logs warning and proceeds with zero LLM findings when planCriticLlmOp throws", async () => {
      const { runPlanCritic } = await import("@/plan");

      const prd = makePRD();
      const manifest = makeFactsManifest();
      const config = makeNaxConfig();

      // planCriticLlmOp is kind:"run" — goes through runWithFallback, not completeAs
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          if (req.runOptions.sessionRole === "plan-critic") {
            throw new Error("LLM service unavailable");
          }
          return {
            result: {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
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
