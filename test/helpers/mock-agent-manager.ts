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

  // Hoisted into consts so the ternary guards below narrow inside the mock
  // closures — narrowing does not survive a property access captured by a
  // closure, but it does survive a const.
  const runWithFallbackOverride = opts.runWithFallbackFn;
  const runOverride = opts.runFn;
  const completeOverride = opts.completeFn;

  const runFn = runWithFallbackOverride
    ? mock(async (req: AgentRunRequest) => {
        const outcome = await runWithFallbackOverride(req);
        return { ...outcome.result, agentFallbacks: outcome.fallbacks };
      })
    : runOverride
      ? mock((req: AgentRunRequest) => runOverride(opts.getDefaultAgent ?? "claude", req.runOptions))
      : mock(() => Promise.resolve({ ...DEFAULT_RESULT, agentFallbacks: [] }));

  const completeFn = completeOverride
    ? mock((prompt: string, completeOpts?: CompleteOptions) => completeOverride("claude", prompt, completeOpts))
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
    if (runWithFallbackOverride) {
      return mock((req: AgentRunRequest, primaryAgentOverride?: string) =>
        runWithFallbackOverride(req, primaryAgentOverride),
      );
    }
    const transport = opts.runWithFallbackTransportFn;
    const asSession = opts.runAsSessionFn;
    // Sequential ifs (not `if (transport || asSession)`): each arm needs its
    // own closure-stable narrowing, which a compound guard cannot give.
    const notifyOpenSession = async (req: AgentRunRequest) => {
      if (opts.openSessionFn) {
        // Notify observer (return value is ignored).
        await opts.openSessionFn(req.runOptions).catch(() => {});
      }
    };
    const hopOutcome = (turn: TurnResult): { result: AgentResult; fallbacks: unknown[] } => ({
      result: {
        success: true,
        exitCode: 0,
        output: turn.output ?? "",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: turn.estimatedCostUsd ?? 0,
        agentFallbacks: [],
      },
      fallbacks: [],
    });
    if (transport) {
      return mock(async (req: AgentRunRequest) => {
        await notifyOpenSession(req);
        return hopOutcome(await transport(req.runOptions, (t: TurnResult) => t));
      });
    }
    if (asSession) {
      return mock(async (req: AgentRunRequest, primaryAgentOverride?: string) => {
        await notifyOpenSession(req);
        return hopOutcome(
          await runAsSessionHop(asSession, req, primaryAgentOverride ?? opts.getDefaultAgent ?? "claude"),
        );
      });
    }
    return mock(() => Promise.resolve({ result: DEFAULT_RESULT, fallbacks: [] }));
  };

  const runAsOverride = opts.runAsFn;
  const completeAsOverride = opts.completeAsFn;
  const completeAsWithFallbackOverride = opts.completeAsWithFallbackFn;
  const completeWithFallbackOverride = opts.completeWithFallbackFn;
  const runAsSessionOverride = opts.runAsSessionFn;

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
    completeWithFallback: completeWithFallbackOverride
      ? mock((prompt: string, completeOpts?: CompleteOptions) => completeWithFallbackOverride(prompt, completeOpts))
      : mock(() => Promise.resolve({ result: DEFAULT_COMPLETE_RESULT, fallbacks: [] })),
    run: runFn,
    complete: completeFn,
    getAgent: opts.getAgentFn ?? ((name: string) => (unavailable.has(name) ? undefined : defaultAdapter)),
    events: { on: () => {} },
    runAs: runAsOverride
      ? mock((agentName: string, request: AgentRunRequest) => runAsOverride(agentName, request.runOptions))
      : runOverride
        ? mock((agentName: string, request: AgentRunRequest) => runOverride(agentName, request.runOptions))
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
    completeAsWithFallback: completeAsWithFallbackOverride
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
          completeAsWithFallbackOverride(name, prompt, completeOpts),
        )
      : mock(async (name: string, prompt: string, completeOpts: CompleteOptions) => ({
          result: await mgr.completeAs(name, prompt, completeOpts),
          fallbacks: [],
        })),
    completeAs: completeAsOverride
      ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
          completeAsOverride(name, prompt, completeOpts),
        )
      : completeOverride
        ? mock((name: string, prompt: string, completeOpts?: CompleteOptions) =>
            completeOverride(name, prompt, completeOpts),
          )
        : mock((name: string, _p: string, _o?: CompleteOptions) =>
            Promise.resolve({
              output: `output from ${name}`,
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
              estimatedCostUsd: 0,
            } satisfies CompleteResult),
          ),
    runAsSession: runAsSessionOverride
      ? mock((agentName: string, handle: SessionHandle, prompt: string, sessionOpts: RunAsSessionOpts) =>
          runAsSessionOverride(agentName, handle, prompt, sessionOpts),
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
