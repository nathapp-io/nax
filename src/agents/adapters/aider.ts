/**
 * Aider Agent Adapter — implements AgentAdapter interface
 *
 * Provides uniform interface for spawning Aider agent processes,
 * supporting one-shot completions in headless mode.
 */

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

export const _aiderCompleteDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
  } {
    return Bun.spawn(cmd, opts) as unknown as {
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      pid: number;
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// AiderAdapter implementation
// ─────────────────────────────────────────────────────────────────────────────

export class AiderAdapter implements AgentAdapter {
  readonly name = "aider";
  readonly displayName = "Aider";
  readonly binary = "aider";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 16_000,
    features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "refactor"]),
  };

  async isInstalled(): Promise<boolean> {
    const path = _aiderCompleteDeps.which("aider");
    return path !== null;
  }

  buildCommand(_options: AgentRunOptions): string[] {
    throw new Error("AiderAdapter.buildCommand() not implemented");
  }

  async run(_options: AgentRunOptions): Promise<AgentResult> {
    throw new Error("AiderAdapter.run() not implemented");
  }

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const cmd: string[] = ["aider", "--message", prompt, "--yes"];

    if (options?.model) {
      cmd.push("--model", options.model);
    }

    const proc = _aiderCompleteDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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
    throw new Error("AiderAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("AiderAdapter.decompose() not implemented");
  }
}
