import type { IAgentManager } from "@/agents";
import type { AgentRegistry } from "@/agents/registry";

/**
 * Private surface of `AgentManager` that the call-op retry tests drive
 * directly: `_resolveRegistry` is swapped for a stub registry returning a
 * canned adapter. The cast is contained here once instead of at every site —
 * see #1514 §11 Group A.
 */
export type AgentManagerInternals = {
  _resolveRegistry: () => { getAgent: (name: string) => unknown };
  /** Lazily created on first getAgent() call — undefined until then. */
  _registry: AgentRegistry | undefined;
};

export function agentManagerInternals(m: IAgentManager): AgentManagerInternals {
  return m as unknown as AgentManagerInternals;
}
