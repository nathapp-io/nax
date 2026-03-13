/**
 * Acceptance Setup Stage
 *
 * Pre-run pipeline stage that generates acceptance tests from PRD criteria
 * and validates them with a RED gate before story execution begins.
 *
 * RED gate behavior:
 * - exit != 0 (tests fail) → valid RED, continue
 * - exit == 0 (all tests pass) → tests are not testing new behavior, warn and skip
 *
 * Stores results in ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount }.
 */

import path from "node:path";
import type { RefinedCriterion } from "../../acceptance/types";
import { resolveModel } from "../../config";
import type { UserStory } from "../../prd/types";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Injectable dependencies for acceptance-setup stage.
 * Allows tests to mock bun test execution, file I/O, and LLM calls.
 * @internal
 */
export const _acceptanceSetupDeps = {
  fileExists: async (_path: string): Promise<boolean> => {
    const f = Bun.file(_path);
    return f.exists();
  },
  writeFile: async (filePath: string, content: string): Promise<void> => {
    await Bun.write(filePath, content);
  },
  runTest: async (_testPath: string, _workdir: string): Promise<{ exitCode: number; output: string }> => {
    const proc = Bun.spawn(["bun", "test", _testPath], {
      cwd: _workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  },
  refine: async (
    _criteria: string[],
    _context: import("../../acceptance/types").RefinementContext,
  ): Promise<RefinedCriterion[]> => {
    const { refineAcceptanceCriteria } = await import("../../acceptance/refinement");
    return refineAcceptanceCriteria(_criteria, _context);
  },
  generate: async (
    _stories: UserStory[],
    _refined: RefinedCriterion[],
    _options: import("../../acceptance/types").GenerateFromPRDOptions,
  ): Promise<import("../../acceptance/types").AcceptanceTestResult> => {
    const { generateFromPRD } = await import("../../acceptance/generator");
    return generateFromPRD(_stories, _refined, _options);
  },
};

export const acceptanceSetupStage: PipelineStage = {
  name: "acceptance-setup",

  enabled(ctx: PipelineContext): boolean {
    return ctx.config.acceptance.enabled && !!ctx.featureDir;
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    if (!ctx.featureDir) {
      return { action: "fail", reason: "[acceptance-setup] featureDir is not set" };
    }

    const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
    const fileExists = await _acceptanceSetupDeps.fileExists(testPath);

    let totalCriteria = 0;
    let testableCount = 0;

    if (!fileExists) {
      const allCriteria: string[] = ctx.prd.userStories.flatMap((s) => s.acceptanceCriteria);
      totalCriteria = allCriteria.length;

      let refinedCriteria: RefinedCriterion[];

      if (ctx.config.acceptance.refinement) {
        refinedCriteria = await _acceptanceSetupDeps.refine(allCriteria, {
          storyId: ctx.prd.userStories[0]?.id ?? "US-001",
          codebaseContext: "",
          config: ctx.config,
          testStrategy: ctx.config.acceptance.testStrategy,
          testFramework: ctx.config.acceptance.testFramework,
        });
      } else {
        refinedCriteria = allCriteria.map((c) => ({
          original: c,
          refined: c,
          testable: true,
          storyId: ctx.prd.userStories[0]?.id ?? "US-001",
        }));
      }

      testableCount = refinedCriteria.filter((r) => r.testable).length;

      const result = await _acceptanceSetupDeps.generate(ctx.prd.userStories, refinedCriteria, {
        featureName: ctx.prd.feature,
        workdir: ctx.workdir,
        codebaseContext: "",
        modelTier: ctx.config.acceptance.model ?? "fast",
        modelDef: resolveModel(ctx.config.models[ctx.config.acceptance.model ?? "fast"]),
        config: ctx.config,
        testStrategy: ctx.config.acceptance.testStrategy,
        testFramework: ctx.config.acceptance.testFramework,
      });

      await _acceptanceSetupDeps.writeFile(testPath, result.testCode);
    }

    if (ctx.config.acceptance.redGate === false) {
      ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 0 };
      return { action: "continue" };
    }

    const { exitCode } = await _acceptanceSetupDeps.runTest(testPath, ctx.workdir);

    if (exitCode === 0) {
      ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 0 };
      return {
        action: "skip",
        reason:
          "[acceptance-setup] Acceptance tests already pass — they are not testing new behavior. Skipping acceptance gate.",
      };
    }

    ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 1 };
    return { action: "continue" };
  },
};
