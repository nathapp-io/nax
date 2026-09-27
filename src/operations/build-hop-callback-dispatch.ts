/**
 * The dispatch half of the buildHopCallback hop: run one turn and settle the session.
 *
 * Split out of build-hop-callback-hop.ts (A5) because the whole per-hop machinery did
 * not fit a new file under the 600-line cap — the same three-way split A1/A3 needed.
 * `build-hop-callback-hop.ts` owns composing the hop (prompt, tooling, session, handoff);
 * this file owns the try/catch/finally that dispatches through the `send` closure,
 * classifies a thrown turn, and applies the keepOpen/timedOut close decision.
 *
 * Everything here is behaviour line-for-line from the pre-extraction closure. The
 * `send` closure substitutes every turn prompt it is handed with the advertised tools
 * (US-002/AC8) and mirrors session-run-hop.ts — the two must not drift.
 */

import { applyDiffAccessForAgentProtocol } from "../agents/tool-preamble";
import type { AgentResult, SessionHandle, TurnResult } from "../agents/types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import { getLogger } from "../logger";
import {
  type HopInvocation,
  type HopOutcome,
  type HopTooling,
  turnResultToAgentResult,
} from "./build-hop-callback-hop";
import type { HopEndpoint } from "./hop-endpoint";

/**
 * Classify a thrown turn into the failure AgentResult the fallback loop sees.
 *
 * Preserve typed adapter failure on SessionFailureError so runWithFallback's
 * swap policy sees the real outcome (rate-limit, auth, quota) instead of
 * a generic "fail-adapter-error" reclassification. Mirrors session-run-hop.ts.
 *
 * nax#1840: native's sendTurn throws SessionTurnError (not
 * SessionFailureError) so it can also carry the cost fields, so
 * classification falls back to SessionTurnError.adapterFailure when the
 * error is not a SessionFailureError.
 */
function classifyThrownTurn(err: unknown, agentName: string): { result: AgentResult; timedOut: boolean } {
  const turnError = err instanceof SessionTurnError ? err : undefined;
  const sessionFailure =
    (err instanceof SessionFailureError ? err.adapterFailure : undefined) ?? turnError?.adapterFailure;
  const errMessage = err instanceof Error ? err.message : String(err);
  return {
    timedOut: sessionFailure?.outcome === "fail-timeout",
    result: {
      success: false,
      exitCode: 1,
      // Always prefix with agent name so downstream logs can attribute the
      // failure even when the underlying error message doesn't carry it
      // (e.g. bare `new Error("timeout")`).
      output: `Agent "${agentName}" failed: ${errMessage}`,
      rateLimited: sessionFailure?.outcome === "fail-rate-limit",
      durationMs: 0,
      // BUG-57: a SessionTurnError (e.g. mid-flight cancel) can carry real
      // tokens already burned before the failure — read them instead of
      // hardcoding zero, or the spend silently disappears from cost accounting.
      estimatedCostUsd: turnError?.estimatedCostUsd ?? 0,
      exactCostUsd: turnError?.exactCostUsd,
      tokenUsage: turnError?.tokenUsage,
      adapterFailure: sessionFailure ?? {
        category: "availability",
        outcome: "fail-adapter-error",
        retriable: turnError?.retryable ?? false,
        message: errMessage.slice(0, 500),
      },
    },
  };
}

/** The finally block: best-effort audit flush, then the keepOpen/timedOut close decision. */
async function settleHopSession(args: {
  input: HopInvocation;
  tooling: HopTooling;
  handle: SessionHandle;
  timedOut: boolean;
}): Promise<void> {
  const { input, tooling, handle, timedOut } = args;
  const logger = getLogger();
  // Best-effort ledger write (mirrors review-audit doctrine): a flush
  // failure logs a warning and never replaces the hop's return value.
  try {
    await tooling.codingSupport?.auditSink.flush();
  } catch (flushErr) {
    logger.warn("tools", "coding-tool audit flush failed", {
      storyId: input.ctx.story.id,
      error: flushErr instanceof Error ? flushErr.message : String(flushErr),
    });
  }
  // STALE-RETRY: keep the handle open for the next attempt. The session stays
  // cached in _liveHandles; the subsequent hop (success, swap, or exhaustion)
  // either closes it in its own finally or SessionManager teardown handles it.
  // keepOpen: callers that need session continuity across pipeline stages (e.g.
  // execution.ts with review/rectification enabled, or warm-lifetime callOp ops
  // like implementerRectifyOp) set this flag so downstream stages can reuse the
  // same ACP session via sessionManager.getLiveHandle().
  // Timeout overrides keepOpen: a wall-clock-timed-out session is dead —
  // leaving it cached would hand the retry a non-functional handle.
  if (input.hopKind.kind !== "stale-retry" && (!input.resolvedRunOptions.keepOpen || timedOut)) {
    await input.ctx.sessionManager.closeSession(handle);
  }
}

/** Everything `dispatchHopTurn` needs to run one turn and settle the session. */
export interface HopDispatchArgs {
  input: HopInvocation;
  tooling: HopTooling;
  handle: SessionHandle;
  endpoint: HopEndpoint | undefined;
}

/**
 * Dispatch one turn (via a caller-supplied hopBody or the default single send) and
 * settle the session in the finally. The `send` closure dispatches one turn through
 * AgentManager (so middleware fires) against the current hop's handle; it is reused
 * by both the default single-prompt path and any caller-supplied hopBody.
 */
export async function dispatchHopTurn(args: HopDispatchArgs): Promise<HopOutcome> {
  const { input, tooling, handle, endpoint } = args;
  const { ctx, agentName, resolvedRunOptions } = input;
  let timedOut = false;
  try {
    // US-002 — the closure substitutes every turn prompt it is handed, so a
    // hopBody's follow-up turn is gated on the same advertised tools the
    // initial prompt was. Without this, the substitution that happens for
    // the initial prompt is the only one and a region-bearing prompt sent
    // from inside the body would reach the agent verbatim — the very
    // failure AC8 guards against.
    const send = (turnPrompt: string): Promise<TurnResult> =>
      ctx.agentManager.runAsSession(
        agentName,
        handle,
        applyDiffAccessForAgentProtocol(agentName, turnPrompt, tooling.advertisedTools),
        {
          storyId: ctx.story.id,
          featureName: ctx.featureName,
          workdir: ctx.workdir,
          projectDir: ctx.projectDir,
          pipelineStage: input.stage,
          // SEC-3: thread per-package config so monorepo permissionProfile is honored.
          config: ctx.config,
          sessionRole: resolvedRunOptions.sessionRole,
          signal: resolvedRunOptions.abortSignal,
          contextPullTools: tooling.contextPullTools,
          contextToolRuntime: tooling.contextToolRuntime,
          codingTools: tooling.codingSupport?.tools,
          ...(resolvedRunOptions.callId !== undefined ? { callId: resolvedRunOptions.callId } : {}),
          ...(resolvedRunOptions.scopeId !== undefined ? { scopeId: resolvedRunOptions.scopeId } : {}),
          ...(tooling.interactionHandler ? { interactionHandler: tooling.interactionHandler } : {}),
          // Context tools need at least one extra round-trip to answer a call;
          // the adapter default of a single turn leaves no room. Mirrors
          // session-run-hop.ts. Bridge-only callers keep their prior behaviour.
          // Mirrors session-run-hop.ts — the two must not drift. Forwarded as
          // the Q&A budget it is documented to be; the native loop no longer
          // spends it on round-trips.
          ...(tooling.hasContextTools
            ? { maxInteractions: ctx.maxInteractionTurns ?? 10 }
            : ctx.maxInteractionTurns !== undefined
              ? { maxInteractions: ctx.maxInteractionTurns }
              : {}),
        },
      );

    const turnResult = ctx.hopBody
      ? await ctx.hopBody(tooling.prompt, { send, input: ctx.hopBodyInput })
      : await send(tooling.prompt);
    // Capture timedOut from the TurnResult so the finally block can force-close
    // the session when keepOpen is true. classifyEmptyOutputFailure (called by
    // sendWithFileOutput → hopBody) synthesises a fail-timeout adapterFailure for
    // timedOut turns but the hop returns normally — the catch block never executes.
    if (turnResult.timedOut) timedOut = true;
    // US-001: a turn was returned (even empty). Distinct from the catch path
    // below, which synthesises a failure from a thrown runAsSession.
    return {
      result: turnResultToAgentResult(turnResult),
      bundle: tooling.workingBundle,
      prompt: tooling.prompt,
      endpoint,
      dispatched: true,
    };
  } catch (err) {
    const classified = classifyThrownTurn(err, agentName);
    timedOut = classified.timedOut;
    return {
      result: classified.result,
      bundle: tooling.workingBundle,
      prompt: tooling.prompt,
      // US-001: catch path synthesises a failure from a thrown runAsSession —
      // no model was reached. `runWithFallback` reads this to count dispatches.
      dispatched: false,
    };
  } finally {
    await settleHopSession({ input, tooling, handle, timedOut });
  }
}
