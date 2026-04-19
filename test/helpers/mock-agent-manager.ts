import type { IAgentManager } from "../../src/agents";

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
    runWithFallback: async (_req) => ({
      result: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      },
      fallbacks: [],
    }),
    events: { on: () => {} },
  };
}
