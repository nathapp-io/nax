/**
 * OpenCode Agent Adapter — implements AgentAdapter interface
 *
 * Provides uniform interface for spawning OpenCode agent processes,
 * supporting one-shot completions.
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

export const _opencodeCompleteDeps = {
  which,
  spawn: typedSpawn,
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenCodeAdapter implementation
// ─────────────────────────────────────────────────────────────────────────────

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly displayName = "OpenCode";
  readonly binary = "opencode";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 8_000,
    features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "refactor"]),
  };

  async isInstalled(): Promise<boolean> {
    const path = _opencodeCompleteDeps.which("opencode");
    return path !== null;
  }

  buildCommand(_options: AgentRunOptions): string[] {
    throw new Error("OpenCodeAdapter.buildCommand() not implemented");
  }

  async run(_options: AgentRunOptions): Promise<AgentResult> {
    throw new Error("OpenCodeAdapter.run() not implemented");
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const cmd = ["opencode", "--prompt", prompt];

    const proc = _opencodeCompleteDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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
    throw new Error("OpenCodeAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("OpenCodeAdapter.decompose() not implemented");
  }
}
