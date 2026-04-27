import { mock } from "bun:test";
import type { AgentAdapter, IAgentManager } from "../../src/agents";
import type { AgentRunRequest, RunAsSessionOpts } from "../../src/agents/manager-types";
import type { SessionHandle, TurnResult } from "../../src/agents/types";
import type { AgentRunOptions, CompleteOptions, CompleteResult } from "../../src/agents/types";
import { makeAgentAdapter } from "./mock-agent-adapter";

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
  runAsFn?: (agentName: string, opts: AgentRunOptions) => Promise<{ success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCost: number; agentFallbacks: unknown[] }>;
  completeAsFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  runAsSessionFn?: (agentName: string, handle: SessionHandle, prompt: string, opts: RunAsSessionOpts) => Promise<TurnResult>;
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
  const defaultAdapter = makeAgentAdapter();

  const runFn = opts.runWithFallbackFn
    ? mock(async (req: AgentRunRequest) => {
        const outcome = await opts.runWithFallbackFn!(req);
        return { ...outcome.result, agentFallbacks: outcome.fallbacks };
      })
    : opts.runFn
      ? mock((req: AgentRunRequest) => opts.runFn!(req.runOptions.agent, req.runOptions))
      : mock(() => Promise.resolve({ ...DEFAULT_RESULT, agentFallbacks: [] }));

  const completeFn = opts.completeFn
    ? mock((prompt: string, completeOpts?: CompleteOptions) => opts.completeFn!("claude", prompt, completeOpts))
    : mock(() => Promise.resolve({ output: "", costUsd: 0, source: "primary" as const }));

  return {
    getDefault: () => opts.getDefaultAgent ?? "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: opts.runWithFallbackFn ? mock((req: AgentRunRequest) => opts.runWithFallbackFn!(req)) : mock(() => Promise.resolve({ result: DEFAULT_RESULT, fallbacks: [] })),
    completeWithFallback: opts.completeWithFallbackFn ? mock((prompt: string, completeOpts?: CompleteOptions) => opts.completeWithFallbackFn!(prompt, completeOpts)) : mock(() => Promise.resolve({ result: DEFAULT_COMPLETE_RESULT, fallbacks: [] })),
    run: runFn,
    complete: completeFn,
    getAgent: opts.getAgentFn ?? ((name: string) => (unavailable.has(name) ? undefined : defaultAdapter)),
    events: { on: () => {} },
    runAs: opts.runAsFn
      ? mock((agentName: string, request: AgentRunRequest) => opts.runAsFn!(agentName, request.runOptions))
      : opts.runFn
        ? mock((agentName: string, request: AgentRunRequest) => opts.runFn!(agentName, request.runOptions))
        : mock((name: string, _req: AgentRunRequest) => Promise.resolve({
            success: true,
            exitCode: 0,
            output: `output from ${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
            agentFallbacks: [],
          })),
    completeAs: opts.completeAsFn
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) => opts.completeAsFn!(name, prompt, completeOpts))
      : opts.completeFn
        ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) => opts.completeFn!(name, prompt, completeOpts))
        : mock((name: string, _p: string, _o?: CompleteOptions) => Promise.resolve({ output: `output from ${name}`, costUsd: 0, source: "primary" as const })),
    runAsSession: opts.runAsSessionFn
      ? mock((agentName: string, handle: SessionHandle, prompt: string, sessionOpts: RunAsSessionOpts) =>
          opts.runAsSessionFn!(agentName, handle, prompt, sessionOpts),
        )
      : mock((_agentName: string, _handle: SessionHandle, _prompt: string, _sessionOpts: RunAsSessionOpts) =>
          Promise.resolve({
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            internalRoundTrips: 0,
          } satisfies TurnResult),
        ),
  } as IAgentManager;
}

/** @deprecated Use {@link makeMockAgentManager} with options instead. */
export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return makeMockAgentManager({ getDefaultAgent: defaultAgent });
}
