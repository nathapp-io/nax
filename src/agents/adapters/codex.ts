/**
 * Codex Agent Adapter — stub
 *
 * STUB ONLY: This file exists to satisfy import resolution for the test suite.
 * Real implementation is pending (AA-007).
 *
 * DO NOT add real logic here. This stub intentionally throws on all method calls
 * so that tests remain RED until the implementation is written.
 */

import type { AgentAdapter, AgentCapabilities, AgentResult, AgentRunOptions, CompleteOptions } from "../types";
import type { DecomposeOptions, DecomposeResult, PlanOptions, PlanResult } from "../types-extended";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies — matches the _deps pattern used in claude.ts
// These are replaced in unit tests to intercept Bun.spawn calls.
// ─────────────────────────────────────────────────────────────────────────────

export const _codexRunDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },
  spawn(
    _cmd: string[],
    _opts: { cwd?: string; stdout: "pipe"; stderr: "pipe" | "inherit"; env?: Record<string, string | undefined> },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
    kill(signal?: number | NodeJS.Signals): void;
  } {
    throw new Error("CodexAdapter.run() not implemented");
  },
};

export const _codexCompleteDeps = {
  spawn(
    _cmd: string[],
    _opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
  } {
    throw new Error("CodexAdapter.complete() not implemented");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CodexAdapter — stub implementation
// ─────────────────────────────────────────────────────────────────────────────

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
    throw new Error("CodexAdapter.isInstalled() not implemented");
  }

  buildCommand(_options: AgentRunOptions): string[] {
    throw new Error("CodexAdapter.buildCommand() not implemented");
  }

  async run(_options: AgentRunOptions): Promise<AgentResult> {
    throw new Error("CodexAdapter.run() not implemented");
  }

  async complete(_prompt: string, _options?: CompleteOptions): Promise<string> {
    throw new Error("CodexAdapter.complete() not implemented");
  }

  async plan(_options: PlanOptions): Promise<PlanResult> {
    throw new Error("CodexAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("CodexAdapter.decompose() not implemented");
  }
}
