/**
 * Mutation-Check Deterministic Operation
 *
 * Opt-in mutation-testing spot-check that runs after GREEN passes to verify the
 * test suite actually catches real defects. Always advisory (success: true) and
 * always restores the worktree (revertMutant runs in a `finally`).
 *
 * Combination shape:
 *  - DeterministicOperation like greenfieldGateOp (filesystem/inspection, no LLM)
 *  - Executes tests like verifyScopedOp (DI'd regression + selectScopedTests)
 *
 * DI collaborators (mirrors _verifyScopedDeps) so unit tests need no real git/test run.
 */

import { mutationCheckConfigSelector } from "../config/selectors";
import type { MutationCheckConfig } from "../config/selectors";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { detectLanguage } from "../project/detector";
import type { ResolvedTestPatterns } from "../test-runners";
import { selectScopedTests } from "../test-runners/scoped-selection";
import type { SelectScopedTestsInput, SelectScopedTestsResult } from "../test-runners/scoped-selection";
import { applyMutant, classifyMutant, generateMutants, revertMutant } from "../verification/mutation";
import { getOperatorsForLanguage } from "../verification/mutation/operators";
import type { SurvivingMutant } from "../verification/mutation/types";
import { regression } from "../verification/runners";
import { getChangedNonTestFiles } from "../verification/smart-runner";
import type { VerificationGateOptions, VerificationResult } from "../verification/types";
import type { CallContext, DeterministicOperation } from "./types";

export interface MutationCheckInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
  readonly storyGitRef?: string;
  readonly repoRoot?: string;
  readonly packagePrefix?: string;
  readonly resolvedTestPatterns: ResolvedTestPatterns;
}

export interface MutationCheckOutput {
  readonly success: true;
  readonly survivors: readonly SurvivingMutant[];
}

export interface MutationCheckDeps {
  detectLanguage: typeof detectLanguage;
  getChangedNonTestFiles: typeof getChangedNonTestFiles;
  selectScopedTests: (input: SelectScopedTestsInput) => Promise<SelectScopedTestsResult>;
  regression: (opts: VerificationGateOptions) => Promise<VerificationResult>;
}

export const _mutationCheckDeps: MutationCheckDeps = {
  detectLanguage,
  getChangedNonTestFiles,
  selectScopedTests,
  regression,
};

export const mutationCheckOp: DeterministicOperation<MutationCheckInput, MutationCheckOutput, MutationCheckConfig> = {
  kind: "deterministic",
  name: "mutation-check",
  stage: "verify",
  config: mutationCheckConfigSelector,
  async execute(
    input: MutationCheckInput,
    ctx: CallContext,
    deps: MutationCheckDeps = _mutationCheckDeps,
  ): Promise<MutationCheckOutput> {
    const cfg = ctx.packageView.select(mutationCheckConfigSelector);
    if (!cfg?.enabled) {
      return { success: true, survivors: [] };
    }

    const logger = getLogger();
    const packageDir = input.packageDir ?? input.workdir;
    const language = await deps.detectLanguage(packageDir);
    const changedFiles = await deps.getChangedNonTestFiles(
      input.workdir,
      input.storyGitRef,
      input.packagePrefix,
      [...input.resolvedTestPatterns.regex],
      undefined,
      input.repoRoot,
    );

    const survivors: SurvivingMutant[] = [];
    const hasOperators = getOperatorsForLanguage(language).length > 0;
    for (const file of changedFiles) {
      if (!hasOperators) break;
      const source = await Bun.file(file).text();
      const mutants = generateMutants({ source, language, file, max: cfg.maxMutants });
      for (const mutant of mutants) {
        await applyMutant(mutant);
        try {
          const scoped = await deps.selectScopedTests({
            workdir: input.workdir,
            storyId: input.storyId,
            storyGitRef: input.storyGitRef,
            testCommand: `bun test ${mutant.file}`,
            smartRunnerConfig: undefined,
            fallbackFullSuiteCommand: `bun test ${mutant.file}`,
            repoRoot: input.repoRoot,
            packagePrefix: input.packagePrefix,
            resolvedTestPatterns: input.resolvedTestPatterns,
          });
          let result: VerificationResult;
          try {
            result = await deps.regression({
              workdir: input.workdir,
              command: scoped.effectiveCommand,
              timeoutSeconds: cfg.timeoutSeconds,
            });
          } catch (err) {
            // Fail-open: a regression subprocess throw is never a gate failure.
            // revertMutant below restores the worktree; we just skip this mutant.
            logger?.warn("mutation-check", "regression() threw — skipping mutant", {
              storyId: input.storyId,
              file: mutant.file,
              line: mutant.line,
              operatorId: mutant.operatorId,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          if (classifyMutant(result) === "survived") {
            survivors.push({ ...mutant, outcome: "survived" });
          }
        } finally {
          await revertMutant(mutant);
        }
      }
    }

    for (const s of survivors) {
      logger?.warn("mutation-check", "Test suite did not catch injected mutation", {
        storyId: input.storyId,
        file: s.file,
        line: s.line,
        operatorId: s.operatorId,
      });
    }

    return { success: true, survivors };
  },
};
