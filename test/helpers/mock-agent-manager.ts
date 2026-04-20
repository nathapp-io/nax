import type { AgentAdapter } from "../../src/agents";
import type { IAgentManager } from "../../src/agents";

const DEFAULT_RESULT = {
  success: true,
  exitCode: 0,
  output: "",
  rateLimited: false,
  durationMs: 0,
  estimatedCost: 0,
};

export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return {
    getDefault: () => defaultAgent,
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (_req) => ({ result: DEFAULT_RESULT, fallbacks: [] }),
    completeWithFallback: async (_prompt, _opts) => ({
      result: { output: "", costUsd: 0, source: "fallback" as const },
      fallbacks: [],
    }),
    run: async (_req) => ({ ...DEFAULT_RESULT, agentFallbacks: [] }),
    complete: async (_prompt, _opts) => ({ output: "", costUsd: 0, source: "fallback" as const }),
    getAgent: (_name: string): AgentAdapter | undefined => undefined,
    events: { on: () => {} },
  };
}
