/**
 * Dispatch-event builders for `AgentManager`.
 *
 * Extracted from `manager.ts` so the event shape — in particular the cost
 * attribution fields added by #1433 — lives in one reviewable place rather than
 * duplicated across the `runAsSession` and `completeAs` call sites.
 *
 * These builders are pure: they take what the caller already has and return an
 * event. All I/O (emitting, timing) stays with the manager.
 */

import { trackedSpawnDeadlines } from "@/config";
import type { AgentManagerConfig } from "@/config/selectors";
import { type PipelineStage, type ResolvedPermissions, resolvePermissions } from "../config/permissions";
import type { ModelDef, ModelTier } from "../config/schema";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "../runtime/dispatch-events";
import { formatSessionName } from "../runtime/session-name";
import type { SessionRole } from "../runtime/session-role";
import { errorMessage } from "../utils/errors";
import { parseModelSpec } from "./acp/model-spec";
import type { AgentFallbackRecord, RunAsSessionOpts } from "./manager-types";
import type { CompleteOptions, ResolvedCompleteOptions, SessionHandle, TurnResult } from "./types";

/**
 * Model attribution fields for a dispatch event (#1433, #1464).
 *
 * All keys are omitted rather than set to `undefined` when unknown: a cost row
 * that says `model: "unknown"` because nothing resolved a model must stay
 * distinguishable from one that was never attributed at all.
 *
 * `modelTier` is absent whenever an explicit `{ agent, model }` pin bypassed
 * tier resolution — reporting a tier there would claim a tier that never
 * selected the model.
 *
 * `model` is decomposed via `parseModelSpec` before it is stamped, so the
 * event always carries the bare model id — never the `model[effort]`
 * composite nax profiles use to name codex reasoning effort. `effort` carries
 * the suffix when the spec had one, and is omitted (not `undefined`) when it
 * did not, for the same reason `modelTier` is omitted rather than nulled.
 */
function modelAttribution(src: { modelDef?: ModelDef; modelTier?: ModelTier }): {
  model?: string;
  effort?: string;
  modelTier?: string;
} {
  const spec = src.modelDef?.model !== undefined ? parseModelSpec(src.modelDef.model) : undefined;
  return {
    ...(spec !== undefined ? { model: spec.model } : {}),
    ...(spec?.effort !== undefined ? { effort: spec.effort } : {}),
    ...(src.modelTier !== undefined ? { modelTier: src.modelTier } : {}),
  };
}

/** Build the `session-turn` event emitted after a successful turn. */
export function buildSessionTurnEvent(input: {
  handle: SessionHandle;
  sessionRole: SessionRole;
  prompt: string;
  result: TurnResult;
  agentName: string;
  stage: PipelineStage;
  opts: RunAsSessionOpts;
  resolvedPermissions: ResolvedPermissions;
  /** Resolved profile-chain display string from config; "default" when none. */
  profile?: string;
  startedAt: number;
}): SessionTurnDispatchEvent {
  const { handle, result, opts, startedAt } = input;
  return {
    kind: "session-turn",
    sessionName: handle.id,
    sessionRole: input.sessionRole,
    prompt: input.prompt,
    response: result.output,
    agentName: input.agentName,
    ...modelAttribution(handle),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    stage: input.stage,
    storyId: opts.storyId,
    featureName: opts.featureName,
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    resolvedPermissions: input.resolvedPermissions,
    tokenUsage: result.tokenUsage,
    estimatedCostUsd: result.estimatedCostUsd,
    exactCostUsd: result.exactCostUsd,
    durationMs: Date.now() - startedAt,
    timestamp: Date.now(),
    turn: result.internalRoundTrips ?? 1,
    protocolIds: {
      sessionId: handle.protocolIds?.sessionId ?? null,
      recordId: handle.protocolIds?.recordId ?? null,
    },
    ...(result.interactions?.length ? { interactions: result.interactions } : {}),
    origin: "runAsSession",
    ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
    ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
  };
}

/** Build the `complete` event emitted after a successful completion. */
export function buildCompleteEvent(input: {
  sessionName: string;
  prompt: string;
  response: string;
  agentName: string;
  stage: PipelineStage;
  options: CompleteOptions;
  resolvedPermissions: ResolvedPermissions;
  tokenUsage: TurnResult["tokenUsage"];
  estimatedCostUsd?: number;
  exactCostUsd?: number;
  /** Resolved profile-chain display string from config; "default" when none. */
  profile?: string;
  startedAt: number;
}): CompleteDispatchEvent {
  const { options } = input;
  return {
    kind: "complete",
    sessionName: input.sessionName,
    sessionRole: options.sessionRole ?? "auto",
    prompt: input.prompt,
    response: input.response,
    agentName: input.agentName,
    ...modelAttribution(options),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    stage: input.stage,
    storyId: options.storyId,
    featureName: options.featureName,
    workdir: options.workdir,
    resolvedPermissions: input.resolvedPermissions,
    tokenUsage: input.tokenUsage,
    estimatedCostUsd: input.estimatedCostUsd,
    exactCostUsd: input.exactCostUsd,
    durationMs: Date.now() - input.startedAt,
    timestamp: Date.now(),
    ...(options.callId !== undefined ? { callId: options.callId } : {}),
    ...(options.scopeId !== undefined ? { scopeId: options.scopeId } : {}),
  };
}

/** Build the error event emitted when a dispatch throws. */
export function buildDispatchErrorEvent(input: {
  origin: DispatchErrorEvent["origin"];
  agentName: string;
  stage: PipelineStage;
  storyId?: string;
  /** The thrown value. Code and message are derived here so both call sites agree. */
  error: unknown;
  prompt?: string;
  resolvedPermissions: ResolvedPermissions;
  callId?: string;
  scopeId?: string;
  startedAt: number;
}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: input.origin,
    agentName: input.agentName,
    stage: input.stage,
    storyId: input.storyId,
    errorCode: input.error instanceof NaxError ? input.error.code : "DISPATCH_ERROR",
    errorMessage: errorMessage(input.error),
    prompt: input.prompt,
    durationMs: Date.now() - input.startedAt,
    timestamp: Date.now(),
    resolvedPermissions: input.resolvedPermissions,
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
  };
}

/**
 * Build the per-call preamble `completeAsWithFallback` needs: resolved permissions,
 * the augmented options handed to the adapter, and the session name.
 *
 * Lives here rather than inline in AgentManager because manager.ts is over its
 * size limit and this is the same concern manager-dispatch already owns — turning
 * a CompleteOptions into the shape the dispatch layer reports on.
 */
export function buildCompleteCallPreamble(input: {
  options: CompleteOptions;
  config: AgentManagerConfig;
  stage: PipelineStage;
}): { resolvedPermissions: ResolvedPermissions; augmented: ResolvedCompleteOptions; sessionName: string } {
  const { options, config, stage } = input;
  const resolvedPermissions = resolvePermissions(options.config ?? config, stage);
  return {
    resolvedPermissions,
    augmented: {
      ...options,
      resolvedPermissions,
      promptRetries: config.agent?.acp?.promptRetries,
      ...trackedSpawnDeadlines(config),
    },
    sessionName:
      options.sessionName ??
      formatSessionName({
        workdir: options.workdir ?? "",
        featureName: options.featureName,
        storyId: options.storyId,
        role: options.sessionRole,
      }),
  };
}

/**
 * Resolve the CompleteOptions for one hop of `completeWithFallback`.
 *
 * nax#1739: `options.modelDef` was resolved by the caller for the PRIMARY agent.
 * Reusing it after a swap dispatches `acpx --model <primary's model> <new agent>`,
 * which the ACP agent rejects — it never advertised that model. The manager cannot
 * re-resolve on its own (`agentManagerConfigSelector` picks no `models` slice), so
 * the caller injects `modelDefFor` and this reads it.
 *
 * Mirrors the run() path's `pinnedModelAgent` (build-hop-callback.ts): the primary
 * keeps the model it was resolved with — so an explicit `{ agent, model }` pin
 * survives — and only a swapped-to agent re-resolves. A missing or undefined
 * resolution leaves `modelDef` untouched, preserving pre-#1739 behaviour.
 *
 * `tier` is the fallback target's named tier (Task 6); when supplied it is passed
 * through to `modelDefFor`, so the swapped hop dispatches the model the operator
 * asked for rather than the caller's own effective tier. Absent means exactly
 * today's behaviour.
 */
export function resolveHopCompleteOptions(
  options: ResolvedCompleteOptions,
  currentAgent: string,
  primaryAgent: string,
  tier?: string,
): ResolvedCompleteOptions {
  if (currentAgent === primaryAgent) return options;
  return { ...options, modelDef: options.modelDefFor?.(currentAgent, tier) ?? options.modelDef };
}

/**
 * Attribute a finished `completeWithFallback` operation to the hop that actually ran.
 *
 * `buildCompleteEvent` used to receive the primary's agent name and the primary's
 * `modelDef`, so after a swap the cost row credited the primary for the fallback
 * agent's spend. That was invisible while nax#1739 dispatched the primary's model
 * regardless; once the dispatch is correct, the event must follow it. The last
 * fallback record names the final agent — same-agent fail-stale retries record
 * `newAgent === priorAgent`, so it holds for those too.
 *
 * `finalTier` is the tier the final hop actually ran at (Task 6), carried out of
 * `completeWithFallback` rather than re-derived — re-resolving without it would
 * record a model that never ran, reintroducing the same divergence in the tier
 * dimension.
 */
export function resolveFinalDispatch(
  options: ResolvedCompleteOptions,
  primaryAgent: string,
  fallbacks: readonly AgentFallbackRecord[],
  finalTier?: string,
): { agentName: string; options: ResolvedCompleteOptions } {
  const agentName = fallbacks.at(-1)?.newAgent ?? primaryAgent;
  return { agentName, options: resolveHopCompleteOptions(options, agentName, primaryAgent, finalTier) };
}

/**
 * Build an AgentFallbackRecord.
 *
 * nax#1712: completeWithFallback used to build its same-agent retry record and its
 * swap record inline, and they disagreed — only the retry record carried storyId.
 * toFallbackHops backfills the id from the store key, so the divergence was latent,
 * but it would bite the first consumer reading the raw records. One builder for both
 * makes them unable to drift again.
 */
export function buildFallbackRecord(input: {
  storyId: string | undefined;
  priorAgent: string;
  newAgent: string;
  hop: number;
  failure: Pick<AdapterFailure, "outcome" | "category">;
  costUsd: number;
}): AgentFallbackRecord {
  return {
    storyId: input.storyId,
    priorAgent: input.priorAgent,
    newAgent: input.newAgent,
    hop: input.hop,
    outcome: input.failure.outcome,
    category: input.failure.category,
    timestamp: new Date().toISOString(),
    costUsd: input.costUsd,
  };
}
