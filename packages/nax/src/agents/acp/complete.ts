/**
 * One-shot complete() on the ACP SDK transport (S4b spec §6.6, B3, D3-a). Each
 * call is a throwaway session (acpx force-closed its one-shot session too):
 * memory transcript, no tools, no tool audit, the profile from
 * resolvedPermissions, one prompt through the same turn loop (so the stream,
 * deadlines, promptRetries and spend are shared with sessions), then a forced
 * close. A timeout is NaxError AGENT_TIMEOUT; a watchdog cancel returns
 * cancelled with the burned tokens priced; a run abort and every other failure
 * are thrown pre-classified, open failures as SessionFailureError (D3-a).
 */
import { NO_OP_INTERACTION_HANDLER, type OpenSessionOpts } from "@nathapp/nax-agent";
import type { AcpAgentName } from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { priceCall, type RateCard } from "../cost";
import { toSessionModel } from "../session-model-mapping";
import { computeAcpHandle } from "../session-naming";
import {
  CompleteError,
  type CompleteResult,
  type ResolvedCompleteOptions,
  SessionFailureError,
  SessionTurnError,
  type TurnResult,
} from "../types";
import { classifyTurnFailure, RunAborted } from "./failure-map";
import { type AcpSession, closeDeadlineMs, createSession, shutdownSession } from "./session";
import { runTurnLoop } from "./turn-loop";

const STAGE = "acp";
/** acpx's complete() default (adapter-complete-flow.ts). */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1_000;

function sessionOptsFor(adapterName: string, options: ResolvedCompleteOptions, timeoutMs: number): OpenSessionOpts {
  return {
    agentName: adapterName,
    workdir: options.workdir,
    resolvedPermissions: options.resolvedPermissions,
    modelDef: toSessionModel(options.modelDef),
    ...(options.modelTier === undefined ? {} : { modelTier: options.modelTier }),
    timeoutSeconds: timeoutMs / MS_PER_SECOND,
    ...(options.promptRetries === undefined ? {} : { promptRetries: options.promptRetries }),
    ...(options.trackedSpawnDeadlineMs === undefined ? {} : { trackedSpawnDeadlineMs: options.trackedSpawnDeadlineMs }),
    ...(options.trackedSpawnStartupDeadlineMs === undefined
      ? {}
      : { trackedSpawnStartupDeadlineMs: options.trackedSpawnStartupDeadlineMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onPidSpawned === undefined ? {} : { onPidSpawned: options.onPidSpawned }),
    ...(options.onPidExited === undefined ? {} : { onPidExited: options.onPidExited }),
    ...(options.onActiveCall === undefined ? {} : { onActiveCall: options.onActiveCall }),
    ...(options.onStreamActivity === undefined ? {} : { onStreamActivity: options.onStreamActivity }),
  };
}

function successResult(result: TurnResult, sessionId: string | null | undefined): CompleteResult {
  const output = result.output.trim();
  if (output === "") throw new CompleteError("complete() returned empty output");
  return {
    output,
    tokenUsage: result.tokenUsage,
    estimatedCostUsd: result.estimatedCostUsd,
    ...(result.exactCostUsd === undefined ? {} : { exactCostUsd: result.exactCostUsd }),
    ...(sessionId === null || sessionId === undefined ? {} : { sessionId }),
    ...(result.pricingSource === undefined ? {} : { pricingSource: result.pricingSource }),
    ...(result.rates === undefined ? {} : { rates: result.rates }),
  };
}

/** acpx's cancelled path: no adapterFailure (the wiring layer names fail-stale), burned tokens priced (BUG-57). */
function cancelledResult(err: SessionTurnError, rateCard: RateCard): CompleteResult {
  const tokenUsage = err.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
  const hasUsage = tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0;
  const priced = hasUsage ? priceCall(tokenUsage, rateCard.rates) : undefined;
  return {
    output: "",
    tokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    ...(err.exactCostUsd === undefined ? {} : { exactCostUsd: err.exactCostUsd }),
    cancelled: true,
    pricingSource: rateCard.source,
    ...(priced?.resolvedRates === undefined ? {} : { rates: priced.resolvedRates }),
  };
}

export async function runComplete(
  adapterName: string,
  agent: AcpAgentName,
  prompt: string,
  options: ResolvedCompleteOptions,
): Promise<CompleteResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;
  const name =
    options.sessionName ?? computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
  if (options.maxTokens !== undefined) {
    getSafeLogger()?.debug(STAGE, "maxTokens has no ACP equivalent; ignored", { sessionName: name });
  }
  const session = await openClassified(name, agent, sessionOptsFor(adapterName, options, timeoutMs));
  try {
    const result = await runTurnLoop(session, prompt, {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      maxInteractions: 1,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.timedOut === true) {
      throw new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp", timeoutMs });
    }
    return successResult(result, session.handle.protocolIds?.sessionId);
  } catch (err) {
    // Only the watchdog's cancel is a cancelled result; a run abort stays fail-aborted (D3-a, D2-c).
    if (err instanceof SessionTurnError && err.adapterFailure?.outcome === "fail-stale") {
      return cancelledResult(err, session.rateCard);
    }
    throw err;
  } finally {
    await shutdownSession(session, { waitMs: closeDeadlineMs(session.opts), force: true });
  }
}

/** Opens the throwaway session; an open failure is classified like a turn's (§7.1) and thrown pre-classified (D3-a). */
async function openClassified(name: string, agent: AcpAgentName, opts: OpenSessionOpts): Promise<AcpSession> {
  try {
    return await createSession(name, agent, opts);
  } catch (err) {
    const cause = opts.signal?.aborted === true ? new RunAborted(opts.signal.reason) : undefined;
    const failure = classifyTurnFailure(err, cause);
    throw new SessionFailureError(failure.message, failure.adapterFailure);
  }
}
