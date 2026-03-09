/**
 * Agent Registry
 *
 * Discovers and manages available coding agents.
 */

import { AiderAdapter } from "./adapters/aider";
import { CodexAdapter } from "./adapters/codex";
import { GeminiAdapter } from "./adapters/gemini";
import { OpenCodeAdapter } from "./adapters/opencode";
import { ClaudeCodeAdapter } from "./claude";
import type { AgentAdapter } from "./types";

/** All known agent adapters */
export const ALL_AGENTS: AgentAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
  new OpenCodeAdapter(),
  new GeminiAdapter(),
  new AiderAdapter(),
];

/** Get all registered agent names */
export function getAllAgentNames(): string[] {
  return ALL_AGENTS.map((a) => a.name);
}

/** Get a specific agent by name */
export function getAgent(name: string): AgentAdapter | undefined {
  return ALL_AGENTS.find((a) => a.name === name);
}

/** Get all installed agents on this machine */
export async function getInstalledAgents(): Promise<AgentAdapter[]> {
  const results = await Promise.all(
    ALL_AGENTS.map(async (agent) => ({
      agent,
      installed: await agent.isInstalled(),
    })),
  );
  return results.filter((r) => r.installed).map((r) => r.agent);
}

/** Check health of all agents */
export async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
  return Promise.all(
    ALL_AGENTS.map(async (agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      installed: await agent.isInstalled(),
    })),
  );
}
