/**
 * Tool-call correlation identifiers, shared by the tap, the Observation and
 * the durable row.
 *
 * Shadow rows could not be joined to tool-audit (review #12) because none of
 * these reached them. Each field is optional and is copied only when its
 * source defines it: an absent source yields an object WITHOUT the key, never
 * one holding `undefined` -- the same rule runtime.ts's tool-audit record
 * follows, so a shadow row and its audit row join on identical values.
 */

export interface CallIdentifiers {
  /** The `callOp` invocation this call happened under (1:N over turns). */
  readonly callId?: string;
  /** Caller-defined region spanning many `callOp` invocations. */
  readonly scopeId?: string;
  /** The turn this call happened in. Native sessions only. */
  readonly turnId?: string;
  /** Model round-trip index WITHIN the turn, 1-based. Native sessions only. */
  readonly roundTrips?: number;
  /** Provider-assigned `tool_use` id, verbatim. ACP calls carry none. */
  readonly toolCallId?: string;
}

/** The defined subset of `source`, key by key. Nothing is defaulted. */
export function callIdentifiers(source: CallIdentifiers): CallIdentifiers {
  return {
    ...(source.callId !== undefined ? { callId: source.callId } : {}),
    ...(source.scopeId !== undefined ? { scopeId: source.scopeId } : {}),
    ...(source.turnId !== undefined ? { turnId: source.turnId } : {}),
    ...(source.roundTrips !== undefined ? { roundTrips: source.roundTrips } : {}),
    ...(source.toolCallId !== undefined ? { toolCallId: source.toolCallId } : {}),
  };
}
