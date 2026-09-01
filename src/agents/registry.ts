/**
 * Agent Registry
 *
 * Discovers and manages available coding agents via the ACP protocol.
 */

import type { AgentManagerConfig } from "@/config/selectors";
import { getLogger } from "../logger";
import { AcpAgentAdapter } from "./acp/adapter";
import { NATIVE_AGENT, NativeAgentAdapter } from "./native";
import type { AgentAdapter } from "./types";

/** Known agent names (used for name validation and health checks) */
export const KNOWN_AGENT_NAMES = ["claude", "codex", "opencode", "gemini", "aider", "pi", NATIVE_AGENT];

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

/**
 * The registry is a routing decision, not one adapter kind repeated: the agent
 * name selects the transport (ADR-027 section 3).
 */
function adapterFor(name: string): AgentAdapter {
  return name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
}

function buildAdapterList(): AgentAdapter[] {
  return [...Array.from(_registryTestAdapters.values()), ...KNOWN_AGENT_NAMES.map(adapterFor)];
}

/**
 * All known agent adapters, regardless of installed status — the full
 * candidate set `getInstalledAgents()` filters down from. Exists separately
 * so callers that need to report on *un*installed agents too (e.g.
 * version-detection's "available but not installed" list) have a set to
 * diff `getInstalledAgents()`'s result against.
 */
export function getAllAgents(): AgentAdapter[] {
  return buildAdapterList();
}

/**
 * BUG-19: this used to unconditionally return `[]`, so `multi-agent-health`
 * precheck always reported "No additional agents detected" regardless of
 * what was actually installed. Mirrors createAgentRegistry().getInstalledAgents().
 */
export async function getInstalledAgents(): Promise<AgentAdapter[]> {
  const allAdapters = buildAdapterList();
  const results = await Promise.all(
    allAdapters.map(async (agent) => ({ agent, installed: await agent.isInstalled() })),
  );
  return results.filter((r) => r.installed).map((r) => r.agent);
}

/** Check health of all agents. BUG-19: previously an unconditional `[]` stub. */
export async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
  const allAdapters = buildAdapterList();
  return Promise.all(
    allAdapters.map(async (agent) => ({
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
export function createAgentRegistry(config: AgentManagerConfig): AgentRegistry {
  const logger = getLogger();
  // Widened from Map<string, AcpAgentAdapter>: the registry is a routing
  // decision now, so the cache holds whichever adapter the name selects.
  const adapterCache = new Map<string, AgentAdapter>();
  const protocol = config.agent?.protocol ?? "acp";

  logger?.info("agents", `Agent protocol: ${protocol}`, { protocol, hasConfig: !!config.agent });

  function cachedAdapter(name: string): AgentAdapter {
    let adapter = adapterCache.get(name);
    if (adapter === undefined) {
      // No configured tiers are passed: agentManagerConfigSelector picks
      // "agent", "execution", "profile" and deliberately NOT "models" —
      // ADR-019 puts model resolution at the callOp seam, not the manager.
      // Widening the selector to reach models.native would breach that
      // boundary for a capability field. See the note below Step 4.
      adapter = name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
      adapterCache.set(name, adapter);
      logger?.debug("agents", `Created ${adapter.constructor.name} for ${name}`, { name });
    }
    return adapter;
  }

  function getAgent(name: string): AgentAdapter | undefined {
    // Test override takes precedence
    if (_registryTestAdapters.has(name)) return _registryTestAdapters.get(name);
    if (!KNOWN_AGENT_NAMES.includes(name)) return undefined;
    return cachedAdapter(name);
  }

  async function getInstalledAgents(): Promise<AgentAdapter[]> {
    const testAdapters = Array.from(_registryTestAdapters.values());
    const adapters = KNOWN_AGENT_NAMES.map(cachedAdapter);
    const allAdapters = [...testAdapters, ...adapters];
    const results = await Promise.all(
      allAdapters.map(async (agent) => ({ agent, installed: await agent.isInstalled() })),
    );
    return results.filter((r) => r.installed).map((r) => r.agent);
  }

  async function checkAgentHealth(): Promise<Array<{ name: string; displayName: string; installed: boolean }>> {
    const testAdapters = Array.from(_registryTestAdapters.values());
    const adapters = KNOWN_AGENT_NAMES.map(cachedAdapter);
    const allAdapters = [...testAdapters, ...adapters];
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
