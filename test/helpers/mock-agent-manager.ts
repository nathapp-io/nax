import { mock } from "bun:test";
import type { AgentAdapter, IAgentManager } from "@/agents";
import type { AgentFallbackRecord, AgentRunRequest, RunAsSessionOpts } from "@/agents/manager-types";
import type {
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  CompleteResult,
  SessionHandle,
  TurnResult,
} from "@/agents/types";
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
 * Override for `IAgentManager.runAsSession`. Mirrors the real method's signature,
 * so a callback written here receives exactly what production code passes.
 *
 * The mock also uses this as the hop transport for `runWithFallback` when no
 * `runWithFallbackTransportFn` is set — see buildRunWithFallback, which adapts
 * the AgentRunRequest into these four arguments so the callback sees a string
 * agent name on both paths.
 */
export type RunAsSessionOverrideFn = (
  agentName: string,
  handle: SessionHandle,
  prompt: string,
  opts: RunAsSessionOpts,
) => Promise<TurnResult>;

/**
 * Callback-style `runWithFallback` transport override.
 * `req` is the AgentRunOptions passed to runWithFallback (carries sessionRole, etc.).
 * `onSuccess` is a passthrough — call it with a TurnResult to produce the turn output.
 *
 * Use this when the assertion needs the request (e.g. `req.sessionRole`); use
 * `runAsSessionFn` when it needs the agent name, handle, or prompt.
 */
export type RunWithFallbackTransportFn = (
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

/**
 * Adapt a runWithFallback request into the four runAsSession arguments, so a
 * `runAsSessionFn` callback sees the same shape on both dispatch paths. The
 * handle is synthetic — the mock never opens a real session.
 */
function runAsSessionHop(fn: RunAsSessionOverrideFn, req: AgentRunRequest, agentName: string): Promise<TurnResult> {
  const handle: SessionHandle = { id: `mock-session-${agentName}`, agentName };
  return fn(agentName, handle, req.runOptions.prompt, { workdir: req.runOptions.workdir });
}

export interface MockAgentManagerOptions {
  getDefaultAgent?: string;
  unavailableAgents?: Set<string>;
  getAgentFn?: (name: string) => AgentAdapter | undefined;
  runFn?: (
    agentName: string,
    opts: AgentRunOptions,
  ) => Promise<{
    success: boolean;
    exitCode: number;
    output: string;
    rateLimited: boolean;
    durationMs: number;
    estimatedCostUsd: number;
    agentFallbacks: unknown[];
  }>;
  completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  runWithFallbackFn?: (
    req: AgentRunRequest,
    primaryAgentOverride?: string,
  ) => Promise<{
    result: {
      success: boolean;
      exitCode: number;
      output: string;
      rateLimited: boolean;
      durationMs: number;
      estimatedCostUsd: number;
      agentFallbacks: unknown[];
    };
    fallbacks: unknown[];
  }>;
  completeWithFallbackFn?: (
    prompt: string,
    opts?: CompleteOptions,
  ) => Promise<{ result: CompleteResult; fallbacks: unknown[] }>;
  runAsFn?: (
    agentName: string,
    opts: AgentRunOptions,
  ) => Promise<{
    success: boolean;
    exitCode: number;
    output: string;
    rateLimited: boolean;
    durationMs: number;
    estimatedCostUsd: number;
    agentFallbacks: unknown[];
  }>;
  completeAsFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  /**
   * Override for `IAgentManager.completeAsWithFallback` (nax#1712). Use this when a test
   * needs the complete() path to report agent-swap records; without it the mock derives
   * the outcome from `completeAs` and reports no hops.
   */
  completeAsWithFallbackFn?: (
    agentName: string,
    prompt: string,
    opts?: CompleteOptions,
  ) => Promise<{ result: CompleteResult; fallbacks: AgentFallbackRecord[] }>;
  /**
   * runAsSession override, in the real method's shape: (agentName, handle, prompt, opts).
   * When provided, the mock's runWithFallback also routes hops through it (with the
   * request adapted to those four arguments) instead of returning DEFAULT_RESULT.
   *
   * runWithFallbackFn takes priority over this when both are set.
   */
  runAsSessionFn?: RunAsSessionOverrideFn;
  /**
   * runWithFallback hop transport, receiving the AgentRunOptions and an identity
   * onSuccess callback. Takes priority over runAsSessionFn on the runWithFallback
   * path; it does not affect runAsSession.
   */
  runWithFallbackTransportFn?: RunWithFallbackTransportFn;
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
      ? mock((req: AgentRunRequest) => opts.runFn!(opts.getDefaultAgent ?? "claude", req.runOptions))
      : mock(() => Promise.resolve({ ...DEFAULT_RESULT, agentFallbacks: [] }));

  const completeFn = opts.completeFn
    ? mock((prompt: string, completeOpts?: CompleteOptions) => opts.completeFn!("claude", prompt, completeOpts))
    : mock(() =>
        Promise.resolve({
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        } satisfies CompleteResult),
      );

  // buildRunWithFallback priority:
  //   runWithFallbackFn > runWithFallbackTransportFn > runAsSessionFn > default.
  // runWithFallbackFn must take priority because it wires req.executeHop, which
  // is required for callOp's retry logic. The transport callbacks are only used
  // as the hop transport when no explicit runWithFallbackFn is set.
  const buildRunWithFallback = () => {
    if (opts.runWithFallbackFn) {
      return mock((req: AgentRunRequest, primaryAgentOverride?: string) =>
        opts.runWithFallbackFn!(req, primaryAgentOverride),
      );
    }
    const transport = opts.runWithFallbackTransportFn;
    const asSession = opts.runAsSessionFn;
    if (transport || asSession) {
      return mock(async (req: AgentRunRequest, primaryAgentOverride?: string) => {
        if (opts.openSessionFn) {
          // Notify observer (return value is ignored).
          await opts.openSessionFn(req.runOptions).catch(() => {});
        }
        const turn = transport
          ? await transport(req.runOptions, (t: TurnResult) => t)
          : await runAsSessionHop(asSession!, req, primaryAgentOverride ?? opts.getDefaultAgent ?? "claude");
        const result: AgentResult = {
          success: true,
          exitCode: 0,
          output: turn.output ?? "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: turn.estimatedCostUsd ?? 0,
          agentFallbacks: [],
        };
        return { result, fallbacks: [] };
      });
    }
    return mock(() => Promise.resolve({ result: DEFAULT_RESULT, fallbacks: [] }));
  };

  const mgr = {
    getDefault: () => opts.getDefaultAgent ?? "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: buildRunWithFallback(),
    completeWithFallback: opts.completeWithFallbackFn
      ? mock((prompt: string, completeOpts?: CompleteOptions) => opts.completeWithFallbackFn!(prompt, completeOpts))
      : mock(() => Promise.resolve({ result: DEFAULT_COMPLETE_RESULT, fallbacks: [] })),
    run: runFn,
    complete: completeFn,
    getAgent: opts.getAgentFn ?? ((name: string) => (unavailable.has(name) ? undefined : defaultAdapter)),
    events: { on: () => {} },
    runAs: opts.runAsFn
      ? mock((agentName: string, request: AgentRunRequest) => opts.runAsFn!(agentName, request.runOptions))
      : opts.runFn
        ? mock((agentName: string, request: AgentRunRequest) => opts.runFn!(agentName, request.runOptions))
        : mock((name: string, _req: AgentRunRequest) =>
            Promise.resolve({
              success: true,
              exitCode: 0,
              output: `output from ${name}`,
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0.01,
              agentFallbacks: [],
            }),
          ),
    // nax#1712: derived from completeAs so every existing caller of this helper keeps
    // working unchanged. This literal is returned through a widening type assertion, so
    // omitting the method would not fail typecheck — it would fail at runtime, as an
    // undefined call, inside callOp's complete branch.
    completeAsWithFallback: opts.completeAsWithFallbackFn
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
          opts.completeAsWithFallbackFn!(name, prompt, completeOpts),
        )
      : mock(async (name: string, prompt: string, completeOpts: CompleteOptions) => ({
          result: await mgr.completeAs(name, prompt, completeOpts),
          fallbacks: [],
        })),
    completeAs: opts.completeAsFn
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
          opts.completeAsFn!(name, prompt, completeOpts),
        )
      : opts.completeFn
        ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
            opts.completeFn!(name, prompt, completeOpts),
          )
        : mock((name: string, _p: string, _o?: CompleteOptions) =>
            Promise.resolve({
              output: `output from ${name}`,
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
              estimatedCostUsd: 0,
            } satisfies CompleteResult),
          ),
    runAsSession: opts.runAsSessionFn
      ? mock((agentName: string, handle: SessionHandle, prompt: string, sessionOpts: RunAsSessionOpts) =>
          opts.runAsSessionFn!(agentName, handle, prompt, sessionOpts),
        )
      : mock((_agentName: string, _handle: SessionHandle, _prompt: string, _sessionOpts: RunAsSessionOpts) =>
          Promise.resolve({
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
          } satisfies TurnResult),
        ),
    close: () => {},
  } as IAgentManager;
  return mgr;
}

/** @deprecated Use {@link makeMockAgentManager} with options instead. */
export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return makeMockAgentManager({ getDefaultAgent: defaultAgent });
}
