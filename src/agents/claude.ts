/**
 * Claude Code Agent Adapter
 */

import type { AgentAdapter, AgentModelMap, AgentResult, AgentRunOptions } from "./types";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly binary = "claude";

  readonly models: AgentModelMap = {
    cheap: "haiku",
    standard: "sonnet",
    premium: "opus",
  };

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
    const model = this.models[options.modelTier];
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

    return {
      success: exitCode === 0,
      exitCode,
      output: stdout.slice(-5000), // Last 5k chars
      rateLimited,
      durationMs,
      estimatedCost: this.estimateCost(options.modelTier, durationMs),
    };
  }

  private estimateCost(tier: string, durationMs: number): number {
    // Rough estimates per minute of agent runtime
    const costPerMinute: Record<string, number> = {
      cheap: 0.01,    // Haiku
      standard: 0.05, // Sonnet
      premium: 0.15,  // Opus
    };
    const minutes = durationMs / 60000;
    return minutes * (costPerMinute[tier] ?? 0.05);
  }
}
