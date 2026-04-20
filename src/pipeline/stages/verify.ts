/**
 * Verify Stage
 *
 * Verifies the agent's work meets basic requirements by running tests.
 * This is a lightweight verification before the full review stage.
 *
 * @returns
 * - `continue`: Tests passed, OR TEST_FAILURE (ctx.verifyResult.success===false → rectifyStage handles it)
 * - `escalate`: TIMEOUT or RUNTIME_CRASH (structural — rectify can't fix these)
 */

import type { SmartTestRunnerConfig } from "../../config/types";
import { getLogger } from "../../logger";
import { resolveQualityTestCommands } from "../../quality/command-resolver";
import { appendScratchEntry } from "../../session/scratch-writer";
import { DEFAULT_TEST_FILE_PATTERNS } from "../../test-runners/conventions";
import { resolveTestFilePatterns } from "../../test-runners/resolver";
import { errorMessage } from "../../utils/errors";
import { logTestOutput } from "../../utils/log-test-output";
import { detectRuntimeCrash } from "../../verification/crash-detector";
import type { VerifyStatus } from "../../verification/orchestrator-types";
import { regression } from "../../verification/runners";
import { _smartRunnerDeps } from "../../verification/smart-runner";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

const DEFAULT_SMART_RUNNER_CONFIG: SmartTestRunnerConfig = {
  enabled: true,
  testFilePatterns: [...DEFAULT_TEST_FILE_PATTERNS],
  fallback: "import-grep",
};

/**
 * Coerces boolean or partial config into a full SmartTestRunnerConfig
 */
function coerceSmartTestRunner(val: boolean | SmartTestRunnerConfig | undefined): SmartTestRunnerConfig {
  if (val === undefined || val === true) return DEFAULT_SMART_RUNNER_CONFIG;
  if (val === false) return { ...DEFAULT_SMART_RUNNER_CONFIG, enabled: false };
  return val;
}

/**
 * Build the scoped test command from discovered test files.
 * Uses the testScoped template (with {{files}} placeholder) if configured,
 * otherwise falls back to buildSmartTestCommand heuristic.
 */
function buildScopedCommand(testFiles: string[], baseCommand: string, testScopedTemplate?: string): string {
  if (testScopedTemplate) {
    return testScopedTemplate.replace("{{files}}", testFiles.join(" "));
  }
  return _smartRunnerDeps.buildSmartTestCommand(testFiles, baseCommand);
}

export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: (ctx: PipelineContext) => !ctx.fullSuiteGatePassed,
  skipReason: () => "not needed (full-suite gate already passed)",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Skip verification if tests are not required
    if (!ctx.config.quality.requireTests) {
      logger.debug("verify", "Skipping verification (quality.requireTests = false)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    // Resolve test commands via SSOT — handles priority, {{package}}, and orchestrator promotion.
    const { rawTestCommand, testCommand, testScopedTemplate, isMonorepoOrchestrator } =
      await _verifyDeps.resolveTestCommands(ctx.config, ctx.workdir, ctx.story.workdir);

    if (!rawTestCommand) {
      logger.debug("verify", "Skipping verification (no test command configured)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    logger.info("verify", "Running verification", { storyId: ctx.story.id });

    // MW-006: workdir is already resolved to the package directory at context creation

    // Determine effective test command (smart runner or full suite)
    let effectiveCommand = rawTestCommand;
    let isFullSuite = true;
    const smartRunnerConfig = coerceSmartTestRunner(ctx.config.execution.smartTestRunner);
    const regressionMode = ctx.config.execution.regressionGate?.mode ?? "deferred";

    // Monorepo orchestrators (turbo, nx) handle change-aware scoping natively via their own
    // filter syntax. Skip nax's smart runner — appending file paths would produce invalid syntax.
    // When storyWorkdir is set, testCommand is the promoted scoped template (e.g. "bunx turbo test --filter=@pkg").
    if (isMonorepoOrchestrator) {
      if (testCommand !== rawTestCommand) {
        // Promoted: use the resolved scoped template (e.g. "bunx turbo test --filter=@koda/cli")
        // testCommand is defined here: promotion only happens when resolvedScopedTemplate is non-null
        effectiveCommand = testCommand as string;
        isFullSuite = false;
        logger.info("verify", "Monorepo orchestrator — using testScoped template", {
          storyId: ctx.story.id,
          command: effectiveCommand,
        });
      } else {
        logger.info("verify", "Monorepo orchestrator — running full suite (no package context)", {
          storyId: ctx.story.id,
          command: effectiveCommand,
        });
      }
    } else if (smartRunnerConfig.enabled) {
      // Resolve test file patterns via ADR-009 SSOT — language-agnostic, config-driven,
      // per-package override-aware. ctx.projectDir is the repo root; story.workdir is the
      // package-relative path (e.g. "packages/lib").
      // Guard: ctx.projectDir may be undefined in test fixtures; fall back to ctx.workdir
      // (absolute path) to prevent a "undefined/.nax/..." relative-path write.
      const repoRoot = ctx.projectDir ?? ctx.workdir;
      const resolvedPatterns = await _verifyDeps.resolveTestFilePatterns(ctx.config, repoRoot, ctx.story.workdir);

      // Pass 0: detect changed test files directly from git diff (#557).
      // Test files are already tests — no source→test mapping needed. They are returned
      // as absolute paths using repoRoot as the anchor.
      const changedTestFiles = await _smartRunnerDeps.getChangedTestFiles(
        ctx.workdir,
        repoRoot,
        ctx.storyGitRef,
        ctx.story.workdir,
        [...resolvedPatterns.regex],
        ctx.naxIgnoreIndex,
      );
      if (changedTestFiles.length > 0) {
        logger.info(
          "verify",
          `[smart-runner] Pass 0: ${changedTestFiles.length} changed test file(s) detected directly`,
          {
            storyId: ctx.story.id,
          },
        );
        effectiveCommand = buildScopedCommand(changedTestFiles, rawTestCommand, testScopedTemplate);
        isFullSuite = false;
      } else {
        // MW-006: pass packagePrefix so git diff is scoped to the package in monorepos.
        // Exclude test files (already handled above) so mapSourceToTests only receives source files.
        const nonTestFiles = await _smartRunnerDeps.getChangedNonTestFiles(
          ctx.workdir,
          ctx.storyGitRef,
          ctx.story.workdir,
          [...resolvedPatterns.regex],
          ctx.naxIgnoreIndex,
        );

        // Pass 1: path convention mapping — pass packagePrefix and testFilePatterns for language-agnostic suffix derivation.
        // ctx.projectDir is the repo root; mapSourceToTests uses it as the absolute base for test path construction.
        const pass1Files = await _smartRunnerDeps.mapSourceToTests(nonTestFiles, ctx.projectDir, ctx.story.workdir, [
          ...resolvedPatterns.globs,
        ]);
        if (pass1Files.length > 0) {
          logger.info("verify", `[smart-runner] Pass 1: path convention matched ${pass1Files.length} test files`, {
            storyId: ctx.story.id,
          });
          effectiveCommand = buildScopedCommand(pass1Files, rawTestCommand, testScopedTemplate);
          isFullSuite = false;
        } else if (smartRunnerConfig.fallback === "import-grep") {
          // Pass 2: import-grep fallback — scan package dir for test files importing the changed sources.
          // ctx.workdir (package dir) keeps the scan scoped to the story's package.
          const pass2Files = await _smartRunnerDeps.importGrepFallback(nonTestFiles, ctx.workdir, [
            ...resolvedPatterns.globs,
          ]);
          if (pass2Files.length > 0) {
            logger.info("verify", `[smart-runner] Pass 2: import-grep matched ${pass2Files.length} test files`, {
              storyId: ctx.story.id,
            });
            effectiveCommand = buildScopedCommand(pass2Files, rawTestCommand, testScopedTemplate);
            isFullSuite = false;
          }
        }
      }
    }

    // US-003: If we are falling back to the full suite AND mode is deferred, skip this stage
    // because the deferred regression gate will handle the full suite at run-end.
    if (isFullSuite && regressionMode === "deferred") {
      logger.info("verify", "[smart-runner] No mapped tests — deferring full suite to run-end (mode: deferred)", {
        storyId: ctx.story.id,
      });
      return { action: "continue" };
    }

    if (isFullSuite) {
      logger.info("verify", "[smart-runner] No mapped tests — falling back to full suite", {
        storyId: ctx.story.id,
      });
    }

    // BUG-044: Log the effective command for observability
    logger.info("verify", isFullSuite ? "Running full suite" : "Running scoped tests", {
      storyId: ctx.story.id,
      command: effectiveCommand,
    });

    // Use unified regression gate (includes 2s wait for agent process cleanup)
    const result = await _verifyDeps.regression({
      workdir: ctx.workdir,
      command: effectiveCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      env: ctx.worktreeDependencyContext?.env,
      acceptOnTimeout: ctx.config.execution.regressionGate?.acceptOnTimeout ?? true,
    });

    // Store result on context for rectify stage
    const verifyStatus = (
      result.status === "TIMEOUT"
        ? "TIMEOUT"
        : result.success
          ? "PASS"
          : detectRuntimeCrash(result.output)
            ? "RUNTIME_CRASH"
            : "TEST_FAILURE"
    ) as VerifyStatus;

    ctx.verifyResult = {
      success: result.success,
      status: verifyStatus,
      storyId: ctx.story.id,
      strategy: "scoped",
      passCount: result.passCount ?? 0,
      failCount: result.failCount ?? 0,
      totalCount: (result.passCount ?? 0) + (result.failCount ?? 0),
      failures: [],
      rawOutput: result.output,
      durationMs: 0,
      countsTowardEscalation: result.countsTowardEscalation,
    };

    // Phase 1: append verify result to session scratch for later stages to read
    if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
      try {
        await _verifyDeps.appendScratch(ctx.sessionScratchDir, {
          kind: "verify-result",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: "verify",
          success: result.success,
          status: verifyStatus,
          passCount: result.passCount ?? 0,
          failCount: result.failCount ?? 0,
          rawOutputTail: (result.output ?? "").slice(-500),
          writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
        });
      } catch (scratchErr) {
        logger.warn("verify", "Failed to write scratch entry — continuing", {
          storyId: ctx.story.id,
          error: errorMessage(scratchErr),
        });
      }
    }

    // HARD FAILURE: Tests must pass for story to be marked complete
    if (!result.success) {
      // BUG-019: Distinguish timeout from actual test failures
      if (result.status === "TIMEOUT") {
        const timeout = ctx.config.execution.verificationTimeoutSeconds;
        logger.error(
          "verify",
          `Test suite exceeded timeout (${timeout}s). This is NOT a test failure — consider increasing execution.verificationTimeoutSeconds or scoping tests.`,
          {
            exitCode: result.status,
            storyId: ctx.story.id,
            timeoutSeconds: timeout,
          },
        );
      } else {
        logger.error("verify", "Tests failed", {
          exitCode: result.status,
          storyId: ctx.story.id,
        });
      }

      // Log tail of output at debug level for context (ENH-001)
      // BUG-037: Use .slice(-20) to show failures, not prechecks
      if (result.status !== "TIMEOUT") {
        logTestOutput(logger, "verify", result.output, { storyId: ctx.story.id });
      }

      // RUNTIME_CRASH and TIMEOUT are structural — escalate immediately (rectify can't fix them)
      if (result.status === "TIMEOUT" || detectRuntimeCrash(result.output)) {
        return {
          action: "escalate",
          reason:
            result.status === "TIMEOUT"
              ? `Test suite TIMEOUT after ${ctx.config.execution.verificationTimeoutSeconds}s (not a code failure)`
              : `Tests failed with runtime crash (exit code ${result.status ?? "non-zero"})`,
        };
      }

      // TEST_FAILURE: ctx.verifyResult is set with success:false — rectifyStage handles it next
      return { action: "continue" };
    }

    logger.info("verify", "Tests passed", { storyId: ctx.story.id });
    return { action: "continue" };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _verifyDeps = {
  regression,
  resolveTestCommands: resolveQualityTestCommands,
  appendScratch: appendScratchEntry,
  resolveTestFilePatterns,
};
