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
    const timeoutId = setTimeout(() => {
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

    // Try to parse token usage from output, fallback to duration-based estimate
    const fullOutput = stdout + stderr;
    let cost = estimateCostFromOutput(options.modelTier, fullOutput);
    if (cost === 0) {
      // Fallback to duration-based estimate if tokens not found
      cost = estimateCostByDuration(options.modelTier, durationMs);
    }

    return {
      success: exitCode === 0,
      exitCode,
      output: stdout.slice(-5000), // Last 5k chars
      rateLimited,
      durationMs,
      estimatedCost: cost,
    };
  }
}
