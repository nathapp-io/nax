/**
 * Verify Stage
 *
 * Verifies the agent\'s work meets basic requirements by running tests.
 * This is a lightweight verification before the full review stage.
 *
 * @returns
 * - `continue`: Tests passed
 * - `escalate`: Tests failed (retry with escalation)
 */

import type { SmartTestRunnerConfig } from "../../config/types";
import { getLogger } from "../../logger";
import { regression } from "../../verification/gate";
import { _smartRunnerDeps } from "../../verification/smart-runner";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

const DEFAULT_SMART_RUNNER_CONFIG: SmartTestRunnerConfig = {
  enabled: true,
  testFilePatterns: ["test/**/*.test.ts"],
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

export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Skip verification if tests are not required
    if (!ctx.config.quality.requireTests) {
      logger.debug("verify", "Skipping verification (quality.requireTests = false)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    // Skip verification if no test command is configured
    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test;
    if (!testCommand) {
      logger.debug("verify", "Skipping verification (no test command configured)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    logger.info("verify", "Running verification", { storyId: ctx.story.id });

    // Determine effective test command (smart runner or full suite)
    let effectiveCommand = testCommand;
    let isFullSuite = true;
    const smartRunnerConfig = coerceSmartTestRunner(ctx.config.execution.smartTestRunner);
    const regressionMode = ctx.config.execution.regressionGate?.mode ?? "deferred";

    if (smartRunnerConfig.enabled) {
      const sourceFiles = await _smartRunnerDeps.getChangedSourceFiles(ctx.workdir, ctx.storyGitRef);

      // Pass 1: path convention mapping
      const pass1Files = await _smartRunnerDeps.mapSourceToTests(sourceFiles, ctx.workdir);
      if (pass1Files.length > 0) {
        logger.info("verify", `[smart-runner] Pass 1: path convention matched ${pass1Files.length} test files`, {
          storyId: ctx.story.id,
        });
        effectiveCommand = _smartRunnerDeps.buildSmartTestCommand(pass1Files, testCommand);
        isFullSuite = false;
      } else if (smartRunnerConfig.fallback === "import-grep") {
        // Pass 2: import-grep fallback
        const pass2Files = await _smartRunnerDeps.importGrepFallback(
          sourceFiles,
          ctx.workdir,
          smartRunnerConfig.testFilePatterns,
        );
        if (pass2Files.length > 0) {
          logger.info("verify", `[smart-runner] Pass 2: import-grep matched ${pass2Files.length} test files`, {
            storyId: ctx.story.id,
          });
          effectiveCommand = _smartRunnerDeps.buildSmartTestCommand(pass2Files, testCommand);
          isFullSuite = false;
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

    // Use unified regression gate (includes 2s wait for agent process cleanup)
    const result = await _verifyDeps.regression({
      workdir: ctx.workdir,
      command: effectiveCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      acceptOnTimeout: ctx.config.execution.regressionGate?.acceptOnTimeout ?? true,
    });

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

      // Log first few lines of output for context
      // BUG-037: Changed from .slice(0, 10) to .slice(-20) to show failures, not prechecks
      if (result.output && result.status !== "TIMEOUT") {
        const outputLines = result.output.split("\n").slice(-20);
        if (outputLines.length > 0) {
          logger.debug("verify", "Test output preview", {
            storyId: ctx.story.id,
            output: outputLines.join("\n"),
          });
        }
      }

      return {
        action: "escalate",
        reason:
          result.status === "TIMEOUT"
            ? `Test suite TIMEOUT after ${ctx.config.execution.verificationTimeoutSeconds}s (not a code failure)`
            : `Tests failed (exit code ${result.status ?? "non-zero"})`,
      };
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
};
