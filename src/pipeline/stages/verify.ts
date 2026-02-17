/**
 * Verify Stage
 *
 * Verifies the agent's work meets basic requirements by running tests.
 * This is a lightweight verification before the full review stage.
 *
 * @returns
 * - `continue`: Tests passed
 * - `fail`: Tests failed (hard failure)
 *
 * @example
 * ```ts
 * // Tests pass
 * await verifyStage.execute(ctx);
 * // Logs: "✓ Tests passed"
 *
 * // Tests fail
 * await verifyStage.execute(ctx);
 * // Returns: { action: "fail", reason: "Tests failed (exit code 1)" }
 * ```
 */

import chalk from "chalk";
import { spawn } from "bun";
import type { PipelineStage, PipelineContext, StageResult } from "../types";

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
    console.log(chalk.cyan("\n   → Running verification..."));

    // Get test command from config or use default
    const testCommand = ctx.config.review?.commands?.test ?? "bun test";

    // Run tests
    const result = await runTests(testCommand, ctx.workdir);

    // HARD FAILURE: Tests must pass for story to be marked complete
    if (!result.success) {
      console.log(chalk.red(`   ✗ Tests failed (exit code ${result.exitCode})`));

      // Log first few lines of output for context
      const outputLines = result.output.split("\n").slice(0, 10);
      if (outputLines.length > 0) {
        console.log(chalk.dim("   Output preview:"));
        for (const line of outputLines) {
          console.log(chalk.dim(`     ${line}`));
        }
      }

      return {
        action: "fail",
        reason: `Tests failed (exit code ${result.exitCode})`,
      };
    }

    console.log(chalk.green("   ✓ Tests passed"));
    return { action: "continue" };
  },
};
