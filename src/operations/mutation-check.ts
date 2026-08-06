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

import { isAbsolute, join } from "node:path";
import { mutationCheckConfigSelector, qualityConfigSelector } from "../config";
import type { MutationCheckConfig } from "../config/selectors";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { detectLanguage } from "../project/detector";
import type { ResolvedTestPatterns } from "../test-runners";
import { selectScopedTests } from "../test-runners/scoped-selection";
import type { SelectScopedTestsInput, SelectScopedTestsResult } from "../test-runners/scoped-selection";
import { applyMutant, classifyMutant, generateMutants, revertMutant } from "../verification/mutation";
import type { Mutant, SurvivingMutant } from "../verification/mutation/types";
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
  readonly outcomes: {
    readonly killed: number;
    readonly survived: number;
    readonly errored: number;
  };
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
      return { success: true, survivors: [], outcomes: { killed: 0, survived: 0, errored: 0 } };
    }

    const logger = getLogger();
    const packageDir = input.packageDir ?? input.workdir;
    const language = await deps.detectLanguage(packageDir);
    const quality = ctx.packageView.select(qualityConfigSelector);
    let baseTestCommand = quality.quality?.commands?.test;
    if (!baseTestCommand) {
      const { resolveDefaultQualityCommands } = await import("../quality/command-defaults");
      baseTestCommand = (await resolveDefaultQualityCommands(input.workdir)).test;
    }
    if (!baseTestCommand) {
      logger.warn("mutation-check", "No test command configured — skipping mutation spot-check", {
        storyId: input.storyId,
      });
      return { success: true, survivors: [], outcomes: { killed: 0, survived: 0, errored: 0 } };
    }
    const changedFiles = await deps.getChangedNonTestFiles(
      input.workdir,
      input.storyGitRef,
      input.packagePrefix,
      [...input.resolvedTestPatterns.regex],
      undefined,
      input.repoRoot,
    );
    // getChangedNonTestFiles returns paths relative to repoRoot — anchor them
    // before any file I/O so resolution doesn't silently depend on the
    // process's current working directory.
    const anchor = input.repoRoot ?? input.workdir;
    const absoluteChangedFiles = changedFiles.map((f) => (isAbsolute(f) ? f : join(anchor, f)));

    const survivors: SurvivingMutant[] = [];
    const outcomes = { killed: 0, survived: 0, errored: 0 };
    // Per-story budget cap: cfg.maxMutants applies to the total across all
    // changed files, not per-file. Accumulate mutants until we reach the cap.
    const mutants: Mutant[] = [];
    for (const file of absoluteChangedFiles) {
      if (mutants.length >= cfg.maxMutants) break;
      try {
        const source = await Bun.file(file).text();
        for (const m of generateMutants({ source, language, file })) {
          mutants.push(m);
          if (mutants.length >= cfg.maxMutants) break;
        }
      } catch (err) {
        // Fail-open: a source read failure never fails the story — skip this file.
        logger.warn("mutation-check", "Failed to read changed file — skipping", {
          storyId: input.storyId,
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const mutant of mutants) {
      try {
        await applyMutant(mutant);
        try {
          const scoped = await deps.selectScopedTests({
            workdir: input.workdir,
            storyId: input.storyId,
            storyGitRef: input.storyGitRef,
            testCommand: baseTestCommand,
            testScopedTemplate: quality.quality?.commands?.testScoped,
            smartRunnerConfig: quality.execution?.smartTestRunner,
            fallbackFullSuiteCommand: baseTestCommand,
            repoRoot: input.repoRoot,
            packagePrefix: input.packagePrefix,
            resolvedTestPatterns: input.resolvedTestPatterns,
          });
          const result = await deps.regression({
            workdir: input.workdir,
            command: scoped.effectiveCommand,
            timeoutSeconds: cfg.timeoutSeconds,
          });
          const outcome = classifyMutant(result);
          outcomes[outcome] += 1;
          if (outcome === "survived") {
            survivors.push({ ...mutant, outcome: "survived" });
          }
        } finally {
          await revertMutant(mutant);
        }
      } catch (err) {
        // Fail-open: any error mutating/testing/reverting a single mutant is
        // never a gate failure — log and move on to the next mutant.
        outcomes.errored += 1;
        logger.warn("mutation-check", "Error processing mutant — skipping", {
          storyId: input.storyId,
          file: mutant.file,
          line: mutant.line,
          operatorId: mutant.operatorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const s of survivors) {
      logger.warn("mutation-check", "Test suite did not catch injected mutation", {
        storyId: input.storyId,
        file: s.file,
        line: s.line,
        operatorId: s.operatorId,
      });
    }

    return { success: true, survivors, outcomes };
  },
};
