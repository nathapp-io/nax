/**
 * Unit tests for semantic verdict persistence in completion stage (US-003)
 *
 * Covers:
 * - AC-4: completion.ts calls persistSemanticVerdict after markStoryPassed when semantic check exists
 * - AC-5: When ctx.reviewResult is undefined, does not write a verdict file
 * - AC-5: When ctx.reviewResult has no semantic check entry, does not write a verdict file
 * - AC-6: When semantic check has success: true, verdict has passed: true and findings: []
 * - AC-7: When semantic check has success: false, verdict has passed: false and findings populated
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _completionDeps } from "../../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewResult } from "../../../../src/review/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { SemanticVerdict } from "../../../../src/acceptance/types";
import { withTempDir } from "../../../helpers/temp";

// ---------------------------------------------------------------------------
// Save originals for restoration
// ---------------------------------------------------------------------------

const originalCheckReviewGate = _completionDeps.checkReviewGate;
const originalPersistSemanticVerdict = _completionDeps.persistSemanticVerdict;

afterEach(() => {
  mock.restore();
  _completionDeps.checkReviewGate = originalCheckReviewGate;
  _completionDeps.persistSemanticVerdict = originalPersistSemanticVerdict;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id = "US-001"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria: ["AC-1: first", "AC-2: second"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeConfig(): NaxConfig {
  return {
    autoMode: { defaultAgent: "test-agent" },
    models: { "test-agent": { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" } },
    execution: {
      sessionTimeoutSeconds: 60,
      dangerouslySkipPermissions: false,
      costLimit: 10,
      maxIterations: 10,
      rectification: { maxRetries: 3 },
    },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers: {},
    },
  } as unknown as NaxConfig;
}

function makeCtx(
  tempDir: string,
  reviewResult?: ReviewResult,
): PipelineContext {
  return {
    config: makeConfig(),
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: tempDir,
    projectDir: tempDir,
    featureDir: tempDir,
    agentResult: { success: true, estimatedCost: 0.01, output: "", stderr: "", exitCode: 0, rateLimited: false },
    hooks: {} as PipelineContext["hooks"],
    storyStartTime: new Date().toISOString(),
    reviewResult,
  } as unknown as PipelineContext;
}

function makeReviewResult(options: {
  semanticSuccess?: boolean;
  semanticFindings?: import("../../../../src/plugins/types").ReviewFinding[];
  includeSemanticCheck?: boolean;
}): ReviewResult {
  const { semanticSuccess = true, semanticFindings = [], includeSemanticCheck = true } = options;

  const checks: ReviewResult["checks"] = [
    { check: "lint", success: true, command: "bun run lint", exitCode: 0, output: "", durationMs: 100 },
  ];

  if (includeSemanticCheck) {
    checks.push({
      check: "semantic",
      success: semanticSuccess,
      command: "",
      exitCode: semanticSuccess ? 0 : 1,
      output: "",
      durationMs: 500,
      findings: semanticFindings,
    });
  }

  return {
    success: semanticSuccess,
    checks,
    totalDurationMs: 600,
  };
}

// ---------------------------------------------------------------------------
// AC-4: completion calls persistSemanticVerdict after markStoryPassed
// ---------------------------------------------------------------------------

describe("completionStage — semantic verdict persistence (AC-4)", () => {
  test("calls persistSemanticVerdict when semantic check exists in reviewResult", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      const persistCalls: Array<{ featureDir: string; storyId: string; verdict: SemanticVerdict }> = [];
      _completionDeps.persistSemanticVerdict = mock(
        async (featureDir: string, storyId: string, verdict: SemanticVerdict) => {
          persistCalls.push({ featureDir, storyId, verdict });
        },
      );

      const reviewResult = makeReviewResult({ semanticSuccess: true });
      const ctx = makeCtx(tempDir, reviewResult);

      await completionStage.execute(ctx);

      expect(persistCalls).toHaveLength(1);
      expect(persistCalls[0].storyId).toBe("US-001");
      expect(persistCalls[0].featureDir).toBe(tempDir);
    });
  });

  test("passes verdict with correct storyId to persistSemanticVerdict", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      const persistCalls: Array<{ storyId: string; verdict: SemanticVerdict }> = [];
      _completionDeps.persistSemanticVerdict = mock(async (_f, storyId, verdict) => {
        persistCalls.push({ storyId, verdict });
      });

      const story = makeStory("US-007");
      const prd: PRD = { ...makePRD(), userStories: [story] };
      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true }));
      ctx.story = story;
      (ctx as any).stories = [story];
      (ctx as any).prd = prd;

      await completionStage.execute(ctx);

      expect(persistCalls[0].storyId).toBe("US-007");
    });
  });

  test("passes featureDir from ctx to persistSemanticVerdict", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedFeatureDir = "";
      _completionDeps.persistSemanticVerdict = mock(async (featureDir) => {
        capturedFeatureDir = featureDir;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true }));

      await completionStage.execute(ctx);

      expect(capturedFeatureDir).toBe(tempDir);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: no verdict file when reviewResult is absent or has no semantic check
// ---------------------------------------------------------------------------

describe("completionStage — skips persistence when no semantic check (AC-5)", () => {
  test("does not call persistSemanticVerdict when ctx.reviewResult is undefined", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let persistCalled = false;
      _completionDeps.persistSemanticVerdict = mock(async () => {
        persistCalled = true;
      });

      const ctx = makeCtx(tempDir, undefined);

      await completionStage.execute(ctx);

      expect(persistCalled).toBe(false);
    });
  });

  test("does not call persistSemanticVerdict when no semantic entry in checks", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let persistCalled = false;
      _completionDeps.persistSemanticVerdict = mock(async () => {
        persistCalled = true;
      });

      const reviewResult = makeReviewResult({ includeSemanticCheck: false });
      const ctx = makeCtx(tempDir, reviewResult);

      await completionStage.execute(ctx);

      expect(persistCalled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6: semantic check success: true → verdict has passed: true and findings: []
// ---------------------------------------------------------------------------

describe("completionStage — verdict shape when semantic check passes (AC-6)", () => {
  test("verdict.passed is true when semantic check has success: true", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true, semanticFindings: [] }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.passed).toBe(true);
    });
  });

  test("verdict.findings is empty array when semantic check passes", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.findings).toEqual([]);
    });
  });

  test("verdict includes timestamp as ISO string", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true }));
      await completionStage.execute(ctx);

      expect(typeof capturedVerdict?.timestamp).toBe("string");
      expect(capturedVerdict?.timestamp.length).toBeGreaterThan(0);
    });
  });

  test("verdict.acCount matches number of acceptance criteria in story", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      // makeStory() gives 2 acceptance criteria: ["AC-1: first", "AC-2: second"]
      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: true }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.acCount).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7: semantic check success: false → verdict has passed: false, findings populated
// ---------------------------------------------------------------------------

describe("completionStage — verdict shape when semantic check fails (AC-7)", () => {
  test("verdict.passed is false when semantic check has success: false", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: false }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.passed).toBe(false);
    });
  });

  test("verdict.findings is populated from semantic check findings when failed", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const findings: import("../../../../src/plugins/types").ReviewFinding[] = [
        { ruleId: "rule-1", severity: "error", file: "src/a.ts", line: 10, message: "issue 1" },
        { ruleId: "rule-2", severity: "warning", file: "src/b.ts", line: 20, message: "issue 2" },
      ];

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: false, semanticFindings: findings }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.findings).toHaveLength(2);
      expect(capturedVerdict?.findings[0].ruleId).toBe("rule-1");
      expect(capturedVerdict?.findings[1].ruleId).toBe("rule-2");
    });
  });

  test("verdict.findings is empty array when semantic check fails with no findings", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");

      let capturedVerdict: SemanticVerdict | undefined;
      _completionDeps.persistSemanticVerdict = mock(async (_f, _s, verdict) => {
        capturedVerdict = verdict;
      });

      const ctx = makeCtx(tempDir, makeReviewResult({ semanticSuccess: false, semanticFindings: [] }));
      await completionStage.execute(ctx);

      expect(capturedVerdict?.findings).toEqual([]);
    });
  });
});
