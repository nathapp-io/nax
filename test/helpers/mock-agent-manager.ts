import type { AgentAdapter, IAgentManager } from "../../src/agents";

const DEFAULT_RESULT = {
  success: true,
  exitCode: 0,
  output: "",
  rateLimited: false,
  durationMs: 0,
  estimatedCost: 0,
};

/**
 * Creates a minimal IAgentManager mock. Pass `overrides` to customize behavior.
 *
 * Example:
 * ```ts
 * const manager = makeMockAgentManager({
 *   complete: async () => ({ output: "stubbed", costUsd: 0, source: "primary" }),
 * });
 * ```
 */
export function makeMockAgentManager(overrides: Partial<IAgentManager> = {}): IAgentManager {
  return {
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async () => ({ result: DEFAULT_RESULT, fallbacks: [] }),
    completeWithFallback: async () => ({
      result: { output: "", costUsd: 0, source: "fallback" as const },
      fallbacks: [],
    }),
    run: async () => ({ ...DEFAULT_RESULT, agentFallbacks: [] }),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    getAgent: (_name: string): AgentAdapter | undefined => undefined,
    runAs: async (_name: string, _req: unknown) => ({ ...DEFAULT_RESULT, agentFallbacks: [] }),
    completeAs: async (_name: string, _prompt: string, _opts: unknown) => ({ output: "", costUsd: 0, source: "fallback" as const }),
    plan: async () => ({ specContent: "" }),
    planAs: async (_name: string, _opts: unknown) => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async (_name: string, _opts: unknown) => ({ stories: [] }),
    events: { on: () => {} },
    ...overrides,
  } as IAgentManager;
}

/** @deprecated Use {@link makeMockAgentManager} with overrides instead. */
export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return makeMockAgentManager({ getDefault: () => defaultAgent });
}
