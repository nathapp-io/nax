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

import type { RefinedCriterion } from "../../acceptance/types";
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
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
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

  enabled(_ctx: PipelineContext): boolean {
    // TODO: implement — stub for test-writer phase
    throw new Error("[acceptance-setup] not implemented");
  },

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    // TODO: implement — stub for test-writer phase
    throw new Error("[acceptance-setup] not implemented");
  },
};
