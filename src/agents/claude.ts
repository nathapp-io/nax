/**
 * Claude Code Agent Adapter
 */

import type { AgentAdapter, AgentResult, AgentRunOptions } from "./types";
import { estimateCostFromOutput, estimateCostByDuration } from "./cost";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly binary = "claude";

  async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", this.binary], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  buildCommand(options: AgentRunOptions): string[] {
    const model = options.modelDef.model;
    return [
      this.binary,
      "--model", model,
      "--dangerously-skip-permissions",
      "-p", options.prompt,
    ];
  }

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
