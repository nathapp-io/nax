/**
 * Agent Registry
 *
 * Discovers and manages available coding agents.
 */

import type { NaxConfig } from "../config/schema";
import { getLogger } from "../logger";
import { AcpAgentAdapter } from "./acp/adapter";
import { AiderAdapter } from "./aider/adapter";
import { ClaudeCodeAdapter } from "./claude/adapter";
import { CodexAdapter } from "./codex/adapter";
import { GeminiAdapter } from "./gemini/adapter";
import { OpenCodeAdapter } from "./opencode/adapter";
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
  /**
   * Reset per-story state on all cached ACP adapters.
   * Call at each story boundary so transient auth failures in one story
   * do not permanently exclude agents for subsequent stories in the same run.
   */
  resetStoryState(): void;
}

/**
 * Create a protocol-aware agent registry.
 *
 * When config.agent.protocol is 'acp', returns AcpAgentAdapter instances.
 * When 'cli' (or unset), returns legacy CLI adapters.
 * AcpAgentAdapter instances are cached per agent name for the lifetime of the registry.
 */
export function createAgentRegistry(config: NaxConfig): AgentRegistry {
  const protocol: "acp" | "cli" = config.agent?.protocol ?? "acp";
  const logger = getLogger();
  const acpCache = new Map<string, AcpAgentAdapter>();

  // Log which protocol is being used at startup
  logger?.info("agents", `Agent protocol: ${protocol}`, { protocol, hasConfig: !!config.agent });

  function getAgent(name: string): AgentAdapter | undefined {
    if (protocol === "acp") {
      const known = ALL_AGENTS.find((a) => a.name === name);
      if (!known) return undefined;
      if (!acpCache.has(name)) {
        acpCache.set(name, new AcpAgentAdapter(name, config));
        logger?.debug("agents", `Created AcpAgentAdapter for ${name}`, { name, protocol });
      }
      return acpCache.get(name);
    }
    const adapter = ALL_AGENTS.find((a) => a.name === name);
    if (adapter) {
      logger?.debug("agents", `Using CLI adapter for ${name}: ${adapter.constructor.name}`, { name });
    }
    return adapter;
  }

  async function getInstalledAgents(): Promise<AgentAdapter[]> {
    const agents =
      protocol === "acp"
        ? ALL_AGENTS.map((a) => {
            if (!acpCache.has(a.name)) {
              acpCache.set(a.name, new AcpAgentAdapter(a.name, config));
            }
            return acpCache.get(a.name) as AcpAgentAdapter;
          })
        : ALL_AGENTS;
    const results = await Promise.all(agents.map(async (agent) => ({ agent, installed: await agent.isInstalled() })));
    return results.filter((r) => r.installed).map((r) => r.agent);
  }

  async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
    const agents =
      protocol === "acp"
        ? ALL_AGENTS.map((a) => {
            if (!acpCache.has(a.name)) {
              acpCache.set(a.name, new AcpAgentAdapter(a.name, config));
            }
            return acpCache.get(a.name) as AcpAgentAdapter;
          })
        : ALL_AGENTS;
    return Promise.all(
      agents.map(async (agent) => ({
        name: agent.name,
        displayName: agent.displayName,
        installed: await agent.isInstalled(),
      })),
    );
  }

  function resetStoryState(): void {
    for (const adapter of acpCache.values()) {
      adapter.clearUnavailableAgents();
    }
  }

  return { getAgent, getInstalledAgents, checkAgentHealth, protocol, resetStoryState };
}
