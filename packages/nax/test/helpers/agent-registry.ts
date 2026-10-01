import type { AgentRegistry } from "@/agents/registry";
/**
 * `AgentRegistry` stubs.
 *
 * The interface has three methods; the ten cast sites supplied only
 * `getAgent`. A complete stub needs no cast at all (#1514 phase 1b).
 */
import type { AgentAdapter } from "@/agents/types";

export function makeAgentRegistry(overrides: Partial<AgentRegistry> = {}): AgentRegistry {
  return {
    getAgent: () => undefined,
    getInstalledAgents: async () => [] as AgentAdapter[],
    checkAgentHealth: async () => [],
    protocol: "acp",
    ...overrides,
  };
}
