/**
 * CLI availability precheck implementations
 */

import type { NaxConfig } from "../config";
import type { Check } from "./types";

/** Dependency injection for testability */
export const _deps = {
  spawn: Bun.spawn,
};

/** Check if Claude CLI is available. Uses: claude --version */
export async function checkClaudeCLI(): Promise<Check> {
  try {
    const proc = _deps.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "claude-cli-available",
      tier: "blocker",
      passed,
      message: passed ? "Claude CLI is available" : "Claude CLI not found. Install from https://claude.ai/download",
    };
  } catch {
    return {
      name: "claude-cli-available",
      tier: "blocker",
      passed: false,
      message: "Claude CLI not found in PATH. Install from https://claude.ai/download",
    };
  }
}

/** Check if configured agent binary is available. Reads agent from config, defaults to 'claude'.
 * Supports: claude, codex, opencode, gemini, aider */
export async function checkAgentCLI(config: NaxConfig): Promise<Check> {
  const agent = config.execution?.agent || "claude";

  try {
    const proc = _deps.spawn([agent, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "agent-cli-available",
      tier: "blocker",
      passed,
      message: passed ? `${agent} CLI is available` : `${agent} CLI not found. Install the ${agent} binary.`,
    };
  } catch {
    return {
      name: "agent-cli-available",
      tier: "blocker",
      passed: false,
      message: `${agent} CLI not found in PATH. Install the ${agent} binary.`,
    };
  }
}
