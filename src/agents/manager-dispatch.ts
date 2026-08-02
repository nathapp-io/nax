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

import type { ResolvedPermissions } from "../config/permissions";
import type { PipelineStage } from "../config/permissions";
import type { ModelDef, ModelTier } from "../config/schema";
import { NaxError } from "../errors";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "../runtime/dispatch-events";
import type { SessionRole } from "../runtime/session-role";
import { errorMessage } from "../utils/errors";
import type { RunAsSessionOpts } from "./manager-types";
import type { CompleteOptions, SessionHandle, TurnResult } from "./types";

/**
 * Model attribution fields for a dispatch event (#1433).
 *
 * Both keys are omitted rather than set to `undefined` when unknown: a cost row
 * that says `model: "unknown"` because nothing resolved a model must stay
 * distinguishable from one that was never attributed at all.
 *
 * `modelTier` is absent whenever an explicit `{ agent, model }` pin bypassed
 * tier resolution — reporting a tier there would claim a tier that never
 * selected the model.
 */
function modelAttribution(src: {
  modelDef?: ModelDef;
  modelTier?: ModelTier;
}): { model?: string; modelTier?: string } {
  return {
    ...(src.modelDef?.model !== undefined ? { model: src.modelDef.model } : {}),
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
