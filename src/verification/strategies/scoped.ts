// RE-ARCH: keep
/**
 * Scoped Verification Strategy (ADR-005, Phase 1)
 *
 * Runs tests scoped to files changed by the current story using the smart
 * test runner. Falls back to full suite when no specific tests are mapped.
 * Falls through to SKIPPED when in deferred mode and no tests are mapped.
 *
 * Extracted from src/pipeline/stages/verify.ts (lines 40-164).
 * Must produce identical results to the existing verify stage.
 */

import { getLogger } from "../../logger";
import type { IVerificationStrategy, VerifyContext, VerifyResult } from "../orchestrator-types";
import { makeFailResult, makePassResult, makeSkippedResult } from "../orchestrator-types";
import { parseBunTestOutput } from "../parser";
import { regression } from "../runners";
import { _smartRunnerDeps } from "../smart-runner";

const DEFAULT_SMART_RUNNER_CONFIG = {
  enabled: true,
  testFilePatterns: ["test/**/*.test.ts"],
  fallback: "import-grep" as const,
};

function coerceSmartRunner(val: unknown) {
  if (val === undefined || val === true) return DEFAULT_SMART_RUNNER_CONFIG;
  if (val === false) return { ...DEFAULT_SMART_RUNNER_CONFIG, enabled: false };
  return val as typeof DEFAULT_SMART_RUNNER_CONFIG;
}

function buildScopedCommand(testFiles: string[], baseCommand: string, testScopedTemplate?: string): string {
  if (testScopedTemplate) {
    return testScopedTemplate.replace("{{files}}", testFiles.join(" "));
  }
  return _scopedDeps.buildSmartTestCommand(testFiles, baseCommand);
}

/**
 * Returns true when the test command delegates to a monorepo orchestrator
 * (Turborepo, Nx) that handles change-aware scoping natively.
 *
 * These tools use their own filter syntax (e.g. `--filter=...[HEAD~1]`,
 * `nx affected`) — nax's smart test runner must not attempt to append
 * file paths to such commands, as it would produce invalid syntax.
 */
export function isMonorepoOrchestratorCommand(command: string): boolean {
  return /\bturbo\b/.test(command) || /\bnx\b/.test(command);
}

export class ScopedStrategy implements IVerificationStrategy {
  readonly name = "scoped" as const;

  async execute(ctx: VerifyContext): Promise<VerifyResult> {
    const logger = getLogger();
    const smartCfg = coerceSmartRunner(ctx.smartRunnerConfig);
    const regressionMode = ctx.regressionMode ?? "deferred";

    // Monorepo orchestrators (turbo, nx) handle change-aware scoping themselves.
    // Skip nax's smart runner — appending file paths would produce invalid syntax.
    // Also bypass deferred mode: run per-story so the orchestrator's own filter
    // (e.g. --filter=...[HEAD~1]) can pick up the story's changes immediately.
    const isMonorepoOrchestrator = isMonorepoOrchestratorCommand(ctx.testCommand);

    let effectiveCommand = ctx.testCommand;
    let isFullSuite = true;

    if (smartCfg.enabled && ctx.storyGitRef && !isMonorepoOrchestrator) {
      const sourceFiles = await _scopedDeps.getChangedSourceFiles(ctx.workdir, ctx.storyGitRef);

      const pass1Files = await _scopedDeps.mapSourceToTests(sourceFiles, ctx.workdir);
      if (pass1Files.length > 0) {
        logger.info("verify[scoped]", `Pass 1: path convention matched ${pass1Files.length} test files`, {
          storyId: ctx.storyId,
        });
        effectiveCommand = buildScopedCommand(pass1Files, ctx.testCommand, ctx.testScopedTemplate);
        isFullSuite = false;
      } else if (smartCfg.fallback === "import-grep") {
        const pass2Files = await _scopedDeps.importGrepFallback(sourceFiles, ctx.workdir, smartCfg.testFilePatterns);
        if (pass2Files.length > 0) {
          logger.info("verify[scoped]", `Pass 2: import-grep matched ${pass2Files.length} test files`, {
            storyId: ctx.storyId,
          });
          effectiveCommand = buildScopedCommand(pass2Files, ctx.testCommand, ctx.testScopedTemplate);
          isFullSuite = false;
        }
      }
    }

    // Defer to regression gate when no scoped tests found and mode is deferred.
    // Exception: monorepo orchestrators run per-story (they carry their own change filter).
    if (isFullSuite && regressionMode === "deferred" && !isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "No mapped tests — deferring to run-end (mode: deferred)", {
        storyId: ctx.storyId,
      });
      return makeSkippedResult(ctx.storyId, "scoped");
    }

    if (isFullSuite && !isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "No mapped tests — falling back to full suite", { storyId: ctx.storyId });
    } else if (isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "Monorepo orchestrator detected — delegating scoping to tool", {
        storyId: ctx.storyId,
        command: effectiveCommand,
      });
    }

    const start = Date.now();
    const result = await _scopedDeps.regression({
      workdir: ctx.workdir,
      command: effectiveCommand,
      timeoutSeconds: ctx.timeoutSeconds,
      acceptOnTimeout: ctx.acceptOnTimeout ?? true,
    });
    const durationMs = Date.now() - start;

    if (result.success) {
      const parsed = result.output ? parseBunTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };
      return makePassResult(ctx.storyId, "scoped", {
        rawOutput: result.output,
        passCount: parsed.passed,
        durationMs,
      });
    }

    if (result.status === "TIMEOUT") {
      return makeFailResult(ctx.storyId, "scoped", "TIMEOUT", {
        rawOutput: result.output,
        durationMs,
        countsTowardEscalation: false,
      });
    }

    const parsed = result.output ? parseBunTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };
    return makeFailResult(ctx.storyId, "scoped", "TEST_FAILURE", {
      rawOutput: result.output,
      passCount: parsed.passed,
      failCount: parsed.failed,
      failures: parsed.failures,
      durationMs,
    });
  }
}

/**
 * Injectable deps for testing.
 */
export const _scopedDeps = {
  getChangedSourceFiles: _smartRunnerDeps.getChangedSourceFiles,
  mapSourceToTests: _smartRunnerDeps.mapSourceToTests,
  importGrepFallback: _smartRunnerDeps.importGrepFallback,
  buildSmartTestCommand: _smartRunnerDeps.buildSmartTestCommand,
  regression,
};
