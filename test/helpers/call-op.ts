/**
 * A `callOp` stand-in for `_storyOrchestratorDeps.callOp` and `CallOpFn` slots.
 *
 * The real `callOp<I, O, C>(ctx, op, input): Promise<O>` is generic, and the
 * stubs return a fixed agent envelope for non-deterministic ops. That envelope
 * is not `O`, so every stub's return type widens to a union and the assignment
 * fails (#1514 §5.3). No test-side value can prove the envelope is `O` — the
 * caller picks `O` — so this keeps the one cast here rather than at each site.
 *
 * Deterministic ops are still dispatched to their real `execute`, which is what
 * the stubs did and what the orchestrator tests rely on.
 */
import type { CallContext, Operation } from "@/operations";

/** The envelope the agent-backed ops resolve to in these tests. */
export const DEFAULT_AGENT_ENVELOPE = {
  success: true,
  filesChanged: [] as string[],
  estimatedCostUsd: 0,
  durationMs: 0,
};

export interface CallOpStubOptions {
  /** Value returned for non-deterministic ops. Defaults to a successful envelope. */
  fallback?: unknown;
  /**
   * Called for every dispatch with both the op and the call context — use it
   * to record `op.name`, count calls, or capture `ctx.scopeId` for assertions
   * about how the orchestrator threads scope IDs through to callOp.
   */
  onDispatch?: (op: { name: string; kind: string }, ctx: CallContext) => void;
}

/**
 * ```ts
 * const dispatched: string[] = [];
 * _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });
 * ```
 */
export function makeCallOp(options: CallOpStubOptions = {}) {
  const { fallback = DEFAULT_AGENT_ENVELOPE, onDispatch } = options;
  return async <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    onDispatch?.(op, ctx);
    if (op.kind === "deterministic") return op.execute(input, ctx);
    return fallback as unknown as O; // test-ratchet-allow: as-unknown-as
  };
}
