import { mock } from "bun:test";
import type { AgentAdapter, IAgentManager } from "@/agents";
import type { AgentRunRequest, RunAsSessionOpts } from "@/agents/manager-types";
import type { SessionHandle, TurnResult } from "@/agents/types";
import type { AgentResult, AgentRunOptions, CompleteOptions, CompleteResult } from "@/agents/types";
import { makeAgentAdapter } from "./mock-agent-adapter";

const DEFAULT_RESULT = {
  success: true,
  exitCode: 0,
  output: "",
  rateLimited: false,
  durationMs: 0,
  estimatedCostUsd: 0,
};

const DEFAULT_COMPLETE_RESULT: CompleteResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
};

/**
 * Callback-style runAsSession override.
 * `req` is the AgentRunOptions passed to runWithFallback (carries sessionRole, etc.).
 * `onSuccess` is a passthrough — call it with a TurnResult to produce the turn output.
 */
export type RunAsSessionOverrideFn = (
  req: AgentRunOptions,
  onSuccess: (turn: TurnResult) => TurnResult,
) => Promise<TurnResult>;

/**
 * Optional override for session opening. Receives the AgentRunOptions that
 * triggered the open. The return value is ignored by the mock — it exists so
 * tests can observe which sessions were opened and with what role.
 */
export type OpenSessionOverrideFn = (req: AgentRunOptions) => Promise<{
  sessionHandle: SessionHandle;
  sessionManager: unknown;
}>;

export interface MockAgentManagerOptions {
  getDefaultAgent?: string;
  unavailableAgents?: Set<string>;
  getAgentFn?: (name: string) => AgentAdapter | undefined;
  runFn?: (agentName: string, opts: AgentRunOptions) => Promise<{ success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCostUsd: number; agentFallbacks: unknown[] }>;
  completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  runWithFallbackFn?: (req: AgentRunRequest, primaryAgentOverride?: string) => Promise<{ result: { success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCostUsd: number; agentFallbacks: unknown[] }; fallbacks: unknown[] }>;
  completeWithFallbackFn?: (prompt: string, opts?: CompleteOptions) => Promise<{ result: CompleteResult; fallbacks: unknown[] }>;
  runAsFn?: (agentName: string, opts: AgentRunOptions) => Promise<{ success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCostUsd: number; agentFallbacks: unknown[] }>;
  completeAsFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  /**
   * Callback-style runAsSession override. When provided, the mock's runWithFallback
   * calls this instead of returning DEFAULT_RESULT. Receives runOptions (with sessionRole)
   * and an identity onSuccess callback.
   *
   * Takes priority over runWithFallbackFn when both are set.
   */
  runAsSessionFn?: RunAsSessionOverrideFn;
  /**
   * Optional session-open observer. Receives the runOptions that triggered the open.
   * Return value is unused by the mock — set sessionIds from within the callback.
   */
  openSessionFn?: OpenSessionOverrideFn;
}

/**
 * Creates a minimal IAgentManager mock. Pass options to customize behavior.
 *
 * Example:
 * ```ts
 * const manager = makeMockAgentManager({
 *   completeFn: async (_, __, opts) => ({ output: "stubbed", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
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
    : mock(() => Promise.resolve({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 } satisfies CompleteResult));

  // buildRunWithFallback priority: runWithFallbackFn > runAsSessionFn > default.
  // runWithFallbackFn must take priority because it wires req.executeHop, which
  // is required for callOp's retry logic. runAsSessionFn is only used as the
  // hop transport when no explicit runWithFallbackFn is set.
  const buildRunWithFallback = () => {
    if (opts.runWithFallbackFn) {
      return mock((req: AgentRunRequest, primaryAgentOverride?: string) =>
        opts.runWithFallbackFn!(req, primaryAgentOverride),
      );
    }
    if (opts.runAsSessionFn) {
      return mock(async (req: AgentRunRequest) => {
        if (opts.openSessionFn) {
          // Notify observer (return value is ignored).
          await opts.openSessionFn(req.runOptions).catch(() => {});
        }
        const turn = await opts.runAsSessionFn!(req.runOptions, (t: TurnResult) => t);
        const result: AgentResult = {
          success: true,
          exitCode: 0,
          output: turn.output ?? "",
          rateLimited: false,
          durationMs: turn.durationMs ?? 0,
          estimatedCostUsd: turn.estimatedCostUsd ?? 0,
          agentFallbacks: [],
        };
        return { result, fallbacks: [] };
      });
    }
    return mock(() => Promise.resolve({ result: DEFAULT_RESULT, fallbacks: [] }));
  };

  return {
    getDefault: () => opts.getDefaultAgent ?? "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: buildRunWithFallback(),
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
            estimatedCostUsd: 0.01,
            agentFallbacks: [],
          })),
    completeAs: opts.completeAsFn
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) => opts.completeAsFn!(name, prompt, completeOpts))
      : opts.completeFn
        ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) => opts.completeFn!(name, prompt, completeOpts))
        : mock((name: string, _p: string, _o?: CompleteOptions) => Promise.resolve({ output: `output from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 } satisfies CompleteResult)),
    runAsSession: opts.runAsSessionFn
      ? mock((agentName: string, handle: SessionHandle, prompt: string, sessionOpts: RunAsSessionOpts) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (opts.runAsSessionFn as any)(agentName, handle, prompt, sessionOpts),
        )
      : mock(
          (_agentName: string, _handle: SessionHandle, _prompt: string, _sessionOpts: RunAsSessionOpts) =>
            Promise.resolve({
              output: "",
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
              estimatedCostUsd: 0,
              internalRoundTrips: 0,
            } satisfies TurnResult),
        ),
  } as IAgentManager;
}

/** @deprecated Use {@link makeMockAgentManager} with options instead. */
export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return makeMockAgentManager({ getDefaultAgent: defaultAgent });
}
