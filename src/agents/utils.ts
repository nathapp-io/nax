import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import { NO_OP_INTERACTION_HANDLER } from "./interaction-handler";
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
  const warnMismatch = (method: string, requested: string): void => {
    if (requested !== adapter.name) {
      getLogger().warn(
        "agents",
        "wrapAdapterAsManager: agentName mismatch — bootstrap manager wraps a single adapter",
        {
          method,
          requested,
          wrapped: adapter.name,
        },
      );
    }
  };
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
    runAs: async (agentName, req) => {
      warnMismatch("runAs", agentName);
      const outcome = await mgr.runWithFallback(req);
      return { ...outcome.result, agentFallbacks: outcome.fallbacks };
    },
    completeAs: async (agentName, prompt, opts) => {
      warnMismatch("completeAs", agentName);
      return adapter.complete(prompt, opts);
    },
    plan: async (opts) => adapter.plan(opts),
    planAs: async (agentName, opts) => {
      warnMismatch("planAs", agentName);
      return adapter.plan(opts);
    },
    decompose: async (opts) => adapter.decompose(opts),
    decomposeAs: async (agentName, opts) => {
      warnMismatch("decomposeAs", agentName);
      return adapter.decompose(opts);
    },
    runAsSession: async (_agentName, handle, prompt, _opts) => {
      return adapter.sendTurn(handle, prompt, { interactionHandler: NO_OP_INTERACTION_HANDLER });
    },
  };
  return mgr;
}
