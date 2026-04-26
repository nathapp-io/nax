/**
 * Agent Registry
 *
 * Discovers and manages available coding agents via the ACP protocol.
 */

import type { NaxConfig } from "../config/schema";
import { getLogger } from "../logger";
import { AcpAgentAdapter } from "./acp/adapter";
import type { AgentAdapter } from "./types";

/** Known agent names (used for name validation and health checks) */
export const KNOWN_AGENT_NAMES = ["claude", "codex", "opencode", "gemini", "aider"];

/**
 * Test-only adapter overrides. Keys are agent names; values are adapter instances
 * that take precedence over ACP adapter creation. Do not use in production.
 *
 * Usage in tests:
 *   _registryTestAdapters.set("mock", myMockAdapter);
 *   // ... run test ...
 *   _registryTestAdapters.delete("mock");
 */
export const _registryTestAdapters = new Map<string, AgentAdapter>();

/** Get all registered agent names */
export function getAllAgentNames(): string[] {
  return KNOWN_AGENT_NAMES;
}

/** Get all installed agents on this machine */
export async function getInstalledAgents(): Promise<AgentAdapter[]> {
  return [];
}

/** Check health of all agents */
export async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
  return [];
}

/** Protocol-aware agent registry returned by createAgentRegistry() */
export interface AgentRegistry {
  /** Get a specific agent, respecting the configured protocol */
  getAgent(name: string): AgentAdapter | undefined;
  /** Get all installed agents */
  getInstalledAgents(): Promise<AgentAdapter[]>;
  /** Check health of all agents */
  checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>>;
  /** Active protocol (always 'acp') */
  protocol: "acp";
}

/**
 * Create an ACP-based agent registry.
 *
 * All agents use AcpAgentAdapter instances, cached per agent name for the
 * lifetime of the registry. Test adapters registered in _registryTestAdapters
 * take precedence and are returned as-is without ACP wrapping.
 */
export function createAgentRegistry(config: NaxConfig): AgentRegistry {
  const logger = getLogger();
  const acpCache = new Map<string, AcpAgentAdapter>();

  logger?.info("agents", "Agent protocol: acp", { protocol: "acp", hasConfig: !!config.agent });

  function getAgent(name: string): AgentAdapter | undefined {
    // Test override takes precedence
    if (_registryTestAdapters.has(name)) return _registryTestAdapters.get(name);
    if (!KNOWN_AGENT_NAMES.includes(name)) return undefined;
    if (!acpCache.has(name)) {
      acpCache.set(name, new AcpAgentAdapter(name));
      logger?.debug("agents", `Created AcpAgentAdapter for ${name}`, { name });
    }
    return acpCache.get(name);
  }

  async function getInstalledAgents(): Promise<AgentAdapter[]> {
    const testAdapters = Array.from(_registryTestAdapters.values());
    const acpAdapters = KNOWN_AGENT_NAMES.map((name) => {
      if (!acpCache.has(name)) {
        acpCache.set(name, new AcpAgentAdapter(name));
      }
      return acpCache.get(name) as AcpAgentAdapter;
    });
    const allAdapters = [...testAdapters, ...acpAdapters];
    const results = await Promise.all(
      allAdapters.map(async (agent) => ({ agent, installed: await agent.isInstalled() })),
    );
    return results.filter((r) => r.installed).map((r) => r.agent);
  }

  async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
    const testAdapters = Array.from(_registryTestAdapters.values());
    const acpAdapters = KNOWN_AGENT_NAMES.map((name) => {
      if (!acpCache.has(name)) {
        acpCache.set(name, new AcpAgentAdapter(name));
      }
      return acpCache.get(name) as AcpAgentAdapter;
    });
    const allAdapters = [...testAdapters, ...acpAdapters];
    return Promise.all(
      allAdapters.map(async (agent) => ({
        name: agent.name,
        displayName: agent.displayName,
        installed: await agent.isInstalled(),
      })),
    );
  }

  return { getAgent, getInstalledAgents, checkAgentHealth, protocol: "acp" };
}
