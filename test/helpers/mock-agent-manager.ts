import type { AgentAdapter, IAgentManager } from "../../src/agents";
import type { AgentRunRequest } from "../../src/agents/manager-types";
import type { AgentRunOptions, CompleteOptions, CompleteResult } from "../../src/agents/types";
import type { PlanOptions, PlanResult, DecomposeOptions, DecomposeResult } from "../../src/agents/shared/types-extended";

const DEFAULT_RESULT = {
  success: true,
  exitCode: 0,
  output: "",
  rateLimited: false,
  durationMs: 0,
  estimatedCost: 0,
};

const DEFAULT_COMPLETE_RESULT: CompleteResult = {
  output: "",
  costUsd: 0,
  source: "primary" as const,
};

export interface MockAgentManagerOptions {
  getDefaultAgent?: string;
  unavailableAgents?: Set<string>;
  getAgentFn?: (name: string) => AgentAdapter | undefined;
  runFn?: (agentName: string, opts: AgentRunOptions) => Promise<{ success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCost: number; agentFallbacks: unknown[] }>;
  completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  runWithFallbackFn?: (req: AgentRunRequest) => Promise<{ result: { success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCost: number; agentFallbacks: unknown[] }; fallbacks: unknown[] }>;
  completeWithFallbackFn?: (prompt: string, opts?: CompleteOptions) => Promise<{ result: CompleteResult; fallbacks: unknown[] }>;
  planFn?: (opts: PlanOptions) => Promise<PlanResult>;
  planAsFn?: (agentName: string, opts: PlanOptions) => Promise<PlanResult>;
  decomposeFn?: (opts: DecomposeOptions) => Promise<DecomposeResult>;
  decomposeAsFn?: (agentName: string, opts: DecomposeOptions) => Promise<DecomposeResult>;
}

/**
 * Creates a minimal IAgentManager mock. Pass options to customize behavior.
 *
 * Example:
 * ```ts
 * const manager = makeMockAgentManager({
 *   completeFn: async (_, __, opts) => ({ output: "stubbed", costUsd: 0, source: "primary" }),
 * });
 * ```
 */
export function makeMockAgentManager(opts: MockAgentManagerOptions = {}): IAgentManager {
  const unavailable = opts.unavailableAgents ?? new Set<string>();
  return {
    getDefault: () => opts.getDefaultAgent ?? "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: opts.runWithFallbackFn ?? (async () => ({ result: DEFAULT_RESULT, fallbacks: [] })),
    completeWithFallback: opts.completeWithFallbackFn ?? (async () => ({ result: DEFAULT_COMPLETE_RESULT, fallbacks: [] })),
    run: opts.runFn
      ? async (req: AgentRunRequest) => opts.runFn!(req.runOptions.agent, req.runOptions)
      : async () => ({ ...DEFAULT_RESULT, agentFallbacks: [] }),
    complete: opts.completeFn
      ? async (prompt, completeOpts) => opts.completeFn!("claude", prompt, completeOpts)
      : async () => ({ output: "", costUsd: 0, source: "primary" as const }),
    getAgent: opts.getAgentFn ?? ((name: string) => (unavailable.has(name) ? undefined : ({} as AgentAdapter))),
    events: { on: () => {} },
    runAs: opts.runFn
      ? async (agentName: string, request: AgentRunRequest) => opts.runFn!(agentName, request.runOptions)
      : async (name: string, _req: AgentRunRequest) => ({
          success: true,
          exitCode: 0,
          output: `output from ${name}`,
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0.01,
          agentFallbacks: [],
        }),
    completeAs: opts.completeFn
      ? async (name, prompt, completeOpts) => opts.completeFn!(name, prompt, completeOpts)
      : async (name, _p, _o) => ({ output: `output from ${name}`, costUsd: 0, source: "primary" as const }),
    plan: opts.planFn
      ? async (opts: PlanOptions) => opts.planFn!("claude", opts)
      : async () => ({ specContent: "" }),
    planAs: opts.planAsFn
      ? async (agentName: string, opts: PlanOptions) => opts.planAsFn!(agentName, opts)
      : opts.planFn
        ? async (agentName: string, opts: PlanOptions) => opts.planFn!("claude", opts)
        : async () => ({ specContent: "" }),
    decompose: opts.decomposeFn ?? (async () => ({ stories: [] })),
    decomposeAs: opts.decomposeAsFn ?? (async () => ({ stories: [] })),
  } as IAgentManager;
}

/** @deprecated Use {@link makeMockAgentManager} with options instead. */
export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return makeMockAgentManager({ getDefaultAgent: defaultAgent });
}
