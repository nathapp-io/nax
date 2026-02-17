/**
 * Review Runner
 *
 * Runs configurable quality checks after story implementation
 */

import { spawn } from "bun";
import type { ReviewConfig, ReviewResult, ReviewCheckResult, ReviewCheckName } from "./types";

/** Default commands for each check type */
const DEFAULT_COMMANDS: Record<ReviewCheckName, string> = {
  typecheck: "bun run typecheck",
  lint: "bun run lint",
  test: "bun test",
};

/**
 * Run a single review check
 */
async function runCheck(
  check: ReviewCheckName,
  command: string,
  workdir: string,
): Promise<ReviewCheckResult> {
  const startTime = Date.now();

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
    const result = await proc.exited;

    // Collect output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = [stdout, stderr].filter(Boolean).join("\n");

    return {
      check,
      command,
      success: result === 0,
      exitCode: result,
      output,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      check,
      command,
      success: false,
      exitCode: -1,
      output: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Run all configured review checks
 */
export async function runReview(
  config: ReviewConfig,
  workdir: string,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const checks: ReviewCheckResult[] = [];
  let firstFailure: string | undefined;

  for (const checkName of config.checks) {
    // Get command from config or use default
    const command = config.commands[checkName] ?? DEFAULT_COMMANDS[checkName];

    // Run the check
    const result = await runCheck(checkName, command, workdir);
    checks.push(result);

    // Track first failure
    if (!result.success && !firstFailure) {
      firstFailure = `${checkName} failed (exit code ${result.exitCode})`;
    }

    // Stop on first failure (fail-fast)
    if (!result.success) {
      break;
    }
  }

  const allPassed = checks.every((c) => c.success);

  return {
    success: allPassed,
    checks,
    totalDurationMs: Date.now() - startTime,
    failureReason: firstFailure,
  };
}
