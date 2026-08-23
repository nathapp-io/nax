import type { IAgentManager } from "@/agents";

/**
 * Private surface of `AgentManager` that the call-op retry tests drive
 * directly: `_resolveRegistry` is swapped for a stub registry returning a
 * canned adapter. The cast is contained here once instead of at every site —
 * see #1514 §11 Group A.
 */
export type AgentManagerInternals = {
  _resolveRegistry: () => { getAgent: (name: string) => unknown };
};

export function agentManagerInternals(m: IAgentManager): AgentManagerInternals {
  return m as unknown as AgentManagerInternals;
}
