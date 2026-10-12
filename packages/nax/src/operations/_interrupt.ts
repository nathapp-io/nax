/** A turn ended by a soft interrupt (finish A, A5 step limits): the session is still warm. */
import { SessionFailureError } from "@/agents";
import type { TurnResult } from "@/agents/types";
import type { HopBodyContext } from "./types";
import { WORKFLOW_INTERRUPT_MARKER } from "./workflow-replies";

export function isInterruptedStale(err: unknown): boolean {
  return (
    err instanceof SessionFailureError &&
    err.adapterFailure.outcome === "fail-stale" &&
    err.adapterFailure.reason === "interrupted"
  );
}

const EMPTY_TURN: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 0,
};

/**
 * One write turn under a soft interrupt at the step limit (A5, P2-R4). An interrupted
 * turn leaves the session and its edits in place and comes back as the marker — never
 * rethrown, so the stale-retry never re-runs a stopped turn.
 */
export async function softInterruptTurn<I extends { readonly timeoutMs: number }>(
  prompt: string,
  ctx: HopBodyContext<I>,
): Promise<TurnResult> {
  const interrupt = AbortSignal.timeout(ctx.input.timeoutMs);
  try {
    return await ctx.send(prompt, { interrupt });
  } catch (err) {
    if (!interrupt.aborted || !isInterruptedStale(err)) throw err;
    return { ...EMPTY_TURN, output: WORKFLOW_INTERRUPT_MARKER };
  }
}
