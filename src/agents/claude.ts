/**
 * Claude Code Agent Adapter
 */

import type { AgentAdapter, AgentCapabilities, AgentResult, AgentRunOptions } from "./types";
import { estimateCostFromOutput, estimateCostByDuration } from "./cost";

/**
 * Claude Code agent adapter implementation.
 *
 * Implements the AgentAdapter interface for Claude Code CLI,
 * supporting model routing, rate limit retry, and cost tracking.
 *
 * @example
 * ```ts
 * const adapter = new ClaudeCodeAdapter();
 * const installed = await adapter.isInstalled();
 *
 * if (installed) {
 *   const result = await adapter.run({
 *     prompt: "Add unit tests for src/utils.ts",
 *     workdir: "/path/to/project",
 *     modelTier: "balanced",
 *     modelDef: { model: "claude-sonnet-4.5", env: {} },
 *     timeoutSeconds: 600,
 *   });
 * }
 * ```
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly binary = "claude";

  /**
   * Claude Code capability metadata.
   *
   * Supports all three model tiers (fast=Haiku, balanced=Sonnet, powerful=Opus),
   * has a 200k token context window, and handles all workflow features.
   */
  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
    features: new Set(["tdd", "review", "refactor", "batch"]),
  };

  /**
   * Check if Claude Code CLI is installed on this machine.
   *
   * @returns true if the `claude` binary is available in PATH
   *
   * @example
   * ```ts
   * const adapter = new ClaudeCodeAdapter();
   * if (await adapter.isInstalled()) {
   *   console.log("Claude Code is ready");
   * }
   * ```
   */
  async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", this.binary], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Build the CLI command array for a given run.
   *
   * Constructs the `claude` command with model, permissions, and prompt flags.
   * Used for dry-run display and debugging.
   *
   * @param options - Agent run options
   * @returns Command array suitable for Bun.spawn()
   *
   * @example
   * ```ts
   * const cmd = adapter.buildCommand({
   *   prompt: "Fix bug in auth.ts",
   *   workdir: "/project",
   *   modelTier: "fast",
   *   modelDef: { model: "claude-haiku-4.5", env: {} },
   *   timeoutSeconds: 300,
   * });
   * console.log(cmd.join(" "));
   * // ["claude", "--model", "claude-haiku-4.5", "--dangerously-skip-permissions", "-p", "Fix bug in auth.ts"]
   * ```
   */
  buildCommand(options: AgentRunOptions): string[] {
    const model = options.modelDef.model;
    return [
      this.binary,
      "--model", model,
      "--dangerously-skip-permissions",
      "-p", options.prompt,
    ];
  }

  /**
   * Run the Claude Code agent with automatic retry on transient failures.
   *
   * Retries up to 3 times with exponential backoff for rate limits and transient errors.
   * Captures stdout, stderr, exit code, duration, and cost estimate.
   *
   * @param options - Agent run configuration
   * @returns Agent execution result with success status, output, and cost
   * @throws Error if all 3 retry attempts fail
   *
   * @example
   * ```ts
   * const result = await adapter.run({
   *   prompt: "Implement feature X",
   *   workdir: "/project",
   *   modelTier: "balanced",
   *   modelDef: { model: "claude-sonnet-4.5", env: {} },
   *   timeoutSeconds: 600,
   * });
   *
   * if (result.success) {
   *   console.log(`Cost: $${result.estimatedCost.toFixed(4)}`);
   * } else if (result.rateLimited) {
   *   console.log("Rate limited after retries");
   * }
   * ```
   */
  async run(options: AgentRunOptions): Promise<AgentResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.runOnce(options, attempt);

        // If rate limited, retry with exponential backoff
        if (result.rateLimited && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.warn(`Rate limited, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
          continue;
        }

        // If transient error (non-zero exit but not timeout), retry with backoff
        if (!result.success && result.exitCode !== 124 && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.warn(`Agent failed with exit code ${result.exitCode}, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
          continue;
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.warn(`Agent error: ${lastError.message}, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxRetries})`);
          await Bun.sleep(backoffMs);
        }
      }
    }

    // All retries failed
    throw lastError || new Error("Agent execution failed after all retries");
  }

  private async runOnce(options: AgentRunOptions, attempt: number): Promise<AgentResult> {
    const cmd = this.buildCommand(options);
    const startTime = Date.now();

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options.modelDef.env,
        ...options.env,
      },
    });

    // Set up timeout
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Date.now() - startTime;

    // Detect rate limiting from output
    const rateLimited =
      stderr.includes("rate limit") ||
      stderr.includes("429") ||
      stdout.includes("rate limit") ||
      stdout.includes("Too many requests");

    // Try to parse token usage from output, fallback to pessimistic duration-based estimate (BUG-3)
    const fullOutput = stdout + stderr;
    let costEstimate = estimateCostFromOutput(options.modelTier, fullOutput);
    if (!costEstimate) {
      // Fallback to conservative duration-based estimate if tokens not found
      // Use 1.5x multiplier to account for parsing uncertainty
      const fallbackEstimate = estimateCostByDuration(options.modelTier, durationMs);
      costEstimate = {
        cost: fallbackEstimate.cost * 1.5,
        confidence: 'fallback',
      };
      console.warn(`[ngent] Cost estimation fallback (duration-based) for ${options.modelTier} tier: ${costEstimate.cost.toFixed(4)} USD`);
    } else if (costEstimate.confidence === 'estimated') {
      console.warn(`[ngent] Cost estimation using regex parsing (estimated confidence): ${costEstimate.cost.toFixed(4)} USD`);
    }
    const cost = costEstimate.cost;

    // Exit code 124 indicates timeout (convention), use 143 for SIGTERM
    const actualExitCode = timedOut ? 124 : exitCode;

    return {
      success: exitCode === 0 && !timedOut,
      exitCode: actualExitCode,
      output: stdout.slice(-5000), // Last 5k chars
      rateLimited,
      durationMs,
      estimatedCost: cost,
    };
  }
}
