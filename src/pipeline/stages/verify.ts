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

import { spawn } from "bun";
import { getLogger } from "../../logger";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Run test command and check exit code
 */
async function runTests(
  command: string,
  workdir: string,
): Promise<{ success: boolean; exitCode: number; output: string }> {
  try {
    // Parse command into executable and args
    const parts = command.split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    // Spawn the process
    const proc = spawn({
      cmd: [executable, ...args],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for completion
    const exitCode = await proc.exited;

    // Collect output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = [stdout, stderr].filter(Boolean).join("\n");

    return {
      success: exitCode === 0,
      exitCode,
      output,
    };
  } catch (error) {
    return {
      success: false,
      exitCode: -1,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    logger.info("verify", "Running verification");

    // Wait 2 seconds to let agent child processes fully terminate
    // This prevents OOM on low-RAM systems when TypeScript language servers
    // are still in memory while we spawn `bun test`
    logger.debug("verify", "Waiting for agent processes to terminate");
    await Bun.sleep(2000);

    // Get test command from config or use default
    const testCommand = ctx.config.review?.commands?.test ?? "bun test";

    // Run tests
    const result = await runTests(testCommand, ctx.workdir);

    // HARD FAILURE: Tests must pass for story to be marked complete
    if (!result.success) {
      logger.error("verify", "Tests failed", {
        exitCode: result.exitCode,
        storyId: ctx.story.id,
      });

      // Log first few lines of output for context
      const outputLines = result.output.split("\n").slice(0, 10);
      if (outputLines.length > 0) {
        logger.debug("verify", "Test output preview", {
          output: outputLines.join("\n"),
        });
      }

      return {
        action: "escalate",
        reason: `Tests failed (exit code ${result.exitCode})`,
      };
    }

    logger.info("verify", "Tests passed", { storyId: ctx.story.id });
    return { action: "continue" };
  },
};
