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
import { regression } from "../../verification/gate";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Skip verification if tests are not required
    if (!ctx.config.quality.requireTests) {
      logger.debug("verify", "Skipping verification (quality.requireTests = false)");
      return { action: "continue" };
    }

    // Skip verification if no test command is configured
    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test;
    if (!testCommand) {
      logger.debug("verify", "Skipping verification (no test command configured)");
      return { action: "continue" };
    }

    logger.info("verify", "Running verification");

    // Use unified regression gate (includes 2s wait for agent process cleanup)
    const result = await regression({
      workdir: ctx.workdir,
      command: testCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
    });

    // HARD FAILURE: Tests must pass for story to be marked complete
    if (!result.success) {
      logger.error("verify", "Tests failed", {
        exitCode: result.status,
        storyId: ctx.story.id,
      });

      // Log first few lines of output for context
      if (result.output) {
        const outputLines = result.output.split("\n").slice(0, 10);
        if (outputLines.length > 0) {
          logger.debug("verify", "Test output preview", {
            output: outputLines.join("\n"),
          });
        }
      }

      return {
        action: "escalate",
        reason: `Tests failed (exit code ${result.status ?? "non-zero"})`,
      };
    }

    logger.info("verify", "Tests passed", { storyId: ctx.story.id });
    return { action: "continue" };
  },
};
