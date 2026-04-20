import type { NaxConfig } from "../config";
import type { IAgentManager } from "./manager-types";
import type { AgentAdapter } from "./types";

const FALLBACK_DEFAULT_AGENT = "claude";

export function resolveDefaultAgent(config: NaxConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}

/**
 * Wrap a single AgentAdapter as a minimal IAgentManager with no fallback logic.
 * Used by session runners when no AgentManager is available (test / bootstrap
 * paths) so SessionManager.runInSession always receives an IAgentManager.
 * ADR-013 Phase 1.
 */
export function wrapAdapterAsManager(adapter: AgentAdapter): IAgentManager {
  const mgr: IAgentManager = {
    getDefault: () => adapter.name,
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (req) => ({ result: await adapter.run(req.runOptions), fallbacks: [] }),
    completeWithFallback: async (prompt, opts) => ({
      result: await adapter.complete(prompt, opts),
      fallbacks: [],
    }),
    run: async (req) => {
      const outcome = await mgr.runWithFallback(req);
      return { ...outcome.result, agentFallbacks: outcome.fallbacks };
    },
    complete: async (prompt, opts) => adapter.complete(prompt, opts),
    getAgent: () => adapter,
    events: { on: () => {} },
  };
  return mgr;
}
