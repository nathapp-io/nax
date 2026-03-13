/**
 * Agent Registry
 *
 * Discovers and manages available coding agents.
 */

import type { NaxConfig } from "../config/schema";
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

/** Protocol-aware agent registry returned by createAgentRegistry() */
export interface AgentRegistry {
  /** Get a specific agent, respecting the configured protocol */
  getAgent(name: string): AgentAdapter | undefined;
  /** Get all installed agents */
  getInstalledAgents(): Promise<AgentAdapter[]>;
  /** Check health of all agents */
  checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>>;
  /** Active protocol ('acp' | 'cli') */
  protocol: "acp" | "cli";
}

/**
 * Create a protocol-aware agent registry.
 *
 * Stub — ACP-003 implementer will fill in real logic.
 * When config.agent.protocol is 'acp', returns AcpAgentAdapter instances.
 * When 'cli' (or unset), returns legacy CLI adapters.
 * AcpAgentAdapter instances are cached per agent name for the lifetime of the registry.
 */
export function createAgentRegistry(_config: NaxConfig): AgentRegistry {
  // Stub — not yet implemented
  throw new Error("[registry] createAgentRegistry() not yet implemented — ACP-003");
}
