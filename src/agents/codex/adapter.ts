/**
 * Codex Agent Adapter — implements AgentAdapter interface
 *
 * Provides uniform interface for spawning Codex agent processes,
 * supporting one-shot completions and headless execution.
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
// Injectable dependencies — matches the _deps pattern used in claude.ts
// These are replaced in unit tests to intercept Bun.spawn calls.
// ─────────────────────────────────────────────────────────────────────────────

export const _codexRunDeps = {
  which,
  spawn: typedSpawn,
};

export const _codexCompleteDeps = {
  spawn: typedSpawn,
};

// ─────────────────────────────────────────────────────────────────────────────
// CodexAdapter implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum characters to capture from agent stdout.
 */
const MAX_AGENT_OUTPUT_CHARS = 5000;

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly binary = "codex";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 8_000,
    features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "refactor"]),
  };

  async isInstalled(): Promise<boolean> {
    const path = _codexRunDeps.which("codex");
    return path !== null;
  }

  buildCommand(options: AgentRunOptions): string[] {
    return ["codex", "-q", "--prompt", options.prompt];
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const cmd = this.buildCommand(options);
    const startTime = Date.now();

    const proc = _codexRunDeps.spawn(cmd, {
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
    const cmd = ["codex", "-q", "--prompt", prompt];

    const proc = _codexCompleteDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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
    throw new Error("CodexAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("CodexAdapter.decompose() not implemented");
  }
}
