/**
 * Gemini CLI Agent Adapter — implements AgentAdapter interface
 *
 * Provides uniform interface for spawning Gemini CLI processes,
 * supporting one-shot completions via 'gemini -p' and Google auth detection.
 */

import { typedSpawn, which } from "../../utils/bun-deps";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "../types";
import { CompleteError } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies — follows the _deps pattern
// Replaced in unit tests to intercept Bun.spawn/Bun.which calls.
// ─────────────────────────────────────────────────────────────────────────────

export const _geminiRunDeps = {
  which,
  spawn: typedSpawn,
};

export const _geminiCompleteDeps = {
  spawn: typedSpawn,
};

// ─────────────────────────────────────────────────────────────────────────────
// GeminiAdapter implementation
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AGENT_OUTPUT_CHARS = 5000;

export class GeminiAdapter implements AgentAdapter {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly binary = "gemini";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
    features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "review", "refactor"]),
  };

  async isInstalled(): Promise<boolean> {
    const path = _geminiRunDeps.which("gemini");
    if (path === null) {
      return false;
    }

    // Check Google auth — run 'gemini' with a flag that shows auth status
    try {
      const proc = _geminiRunDeps.spawn(["gemini", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return false;
      }

      const stdout = await new Response(proc.stdout).text();
      const lowerOut = stdout.toLowerCase();

      // If output explicitly says "not logged in", auth has failed
      if (lowerOut.includes("not logged in")) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: AgentRunOptions): string[] {
    return ["gemini", "-p", options.prompt];
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const cmd = this.buildCommand(options);
    const startTime = Date.now();

    const proc = _geminiRunDeps.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const durationMs = Date.now() - startTime;

    return {
      success: exitCode === 0,
      exitCode,
      output: stdout.slice(-MAX_AGENT_OUTPUT_CHARS),
      rateLimited: false,
      durationMs,
      estimatedCost: 0,
      pid: proc.pid,
    };
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const cmd = ["gemini", "-p", prompt];

    const proc = _geminiCompleteDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const trimmed = stdout.trim();

    if (exitCode !== 0) {
      const errorDetails = stderr.trim() || trimmed;
      const errorMessage = errorDetails || `complete() failed with exit code ${exitCode}`;
      throw new CompleteError(errorMessage, exitCode);
    }

    if (!trimmed) {
      throw new CompleteError("complete() returned empty output");
    }

    return trimmed;
  }

  async plan(_options: PlanOptions): Promise<PlanResult> {
    throw new Error("GeminiAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("GeminiAdapter.decompose() not implemented");
  }
}
