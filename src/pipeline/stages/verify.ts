/**
 * Verify Stage
 *
 * Verifies the agent's work meets basic requirements by running tests.
 * This is a lightweight verification before the full review stage.
 *
 * @returns
 * - `continue`: Tests passed
 * - `escalate`: Tests failed (retry with escalation)
 *
 * @example
 * ```ts
 * // Tests pass
 * await verifyStage.execute(ctx);
 * // Logs: "✓ Tests passed"
 *
 * // Tests fail
 * await verifyStage.execute(ctx);
 * // Returns: { action: "escalate", reason: "Tests failed (exit code 1)" }
 * ```
 */

import { getLogger } from "../../logger";
import { buildSmartTestCommand, getChangedSourceFiles, mapSourceToTests } from "../../verification/smart-runner";
import { regression } from "../../verification/gate";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

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
    const smartRunnerEnabled = ctx.config.execution.smartTestRunner !== false;

    if (smartRunnerEnabled) {
      const sourceFiles = await getChangedSourceFiles(ctx.workdir);
      const testFiles = await mapSourceToTests(sourceFiles, ctx.workdir);

      if (testFiles.length > 0) {
        effectiveCommand = buildSmartTestCommand(testFiles, testCommand);
        logger.info("verify", `[smart-runner] Running ${testFiles.length} targeted test files`, { storyId: ctx.story.id });
      } else {
        logger.info("verify", "[smart-runner] No mapped tests — falling back to full suite", { storyId: ctx.story.id });
      }
    }

    // Use unified regression gate (includes 2s wait for agent process cleanup)
    const result = await regression({
      workdir: ctx.workdir,
      command: effectiveCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
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

      // Log first few lines of output for context (skip for TIMEOUT — output is misleading)
      if (result.output && result.status !== "TIMEOUT") {
        const outputLines = result.output.split("\n").slice(0, 10);
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
