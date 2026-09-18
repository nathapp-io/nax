/**
 * Builds the AgentRunOptions literal callOp hands to runWithFallback for a
 * run-kind dispatch.
 *
 * Extracted out of call.ts (single-frame redesign PR1,
 * docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md) so
 * call.ts — already at the 600-line hard cap — has room to thread the two
 * new PR1 fields (`projectDir`, `codingToolPackageDir`) without growing
 * past it.
 */

import type { ModelDef, ModelTier, NaxConfig } from "../config";
import { DEFAULT_CONFIG } from "../config";
import type { PipelineStage } from "../config/permissions";
import { packageWorkdir, storyExecRoot } from "../runtime/packages";
import type { SessionRole } from "../session/types";
import type { CodingToolName, ToolPatternNarrowing } from "../tools";
import type { CallContext } from "./types";

export interface RunDispatchOptionsParams {
  readonly prompt: string;
  readonly effectiveTier: ModelTier;
  readonly dispatchModelDef: ModelDef;
  readonly timeoutMs?: number;
  readonly config: NaxConfig;
  readonly sessionRole?: SessionRole;
  readonly callId: string;
  readonly pipelineStage: PipelineStage;
  readonly declaredTools: readonly CodingToolName[];
  readonly toolPatterns?: ToolPatternNarrowing;
  readonly fileOutputPath?: string;
  readonly keepOpen: boolean;
}

/**
 * @param ctx - The dispatching CallContext; supplies packageView/runtime/story fields.
 * @param params - Call-site-local values callOp already resolved for this dispatch.
 */
export function buildRunDispatchOptions(ctx: CallContext, params: RunDispatchOptionsParams) {
  const {
    prompt,
    effectiveTier,
    dispatchModelDef,
    timeoutMs,
    config,
    sessionRole,
    callId,
    pipelineStage,
    declaredTools,
    toolPatterns,
    fileOutputPath,
    keepOpen,
  } = params;
  return {
    prompt,
    workdir: ctx.packageDir,
    modelTier: effectiveTier,
    modelDef: dispatchModelDef,
    timeoutSeconds:
      timeoutMs !== undefined
        ? Math.ceil(timeoutMs / 1000)
        : (config.execution?.sessionTimeoutSeconds ?? DEFAULT_CONFIG.execution.sessionTimeoutSeconds),
    pipelineStage,
    config,
    sessionRole,
    featureName: ctx.featureName,
    storyId: ctx.storyId,
    callId,
    declaredTools,
    // Both hops resolve providers from this one object (build-hop-callback and
    // session-run-hop each take their options from here), so injecting once
    // cannot leave the two paths advertising different tool sets — the drift
    // both hops' comments warn about.
    ...(ctx.runtime.toolProviders.length > 0 ? { providers: ctx.runtime.toolProviders } : {}),
    ...(toolPatterns !== undefined ? { toolPatterns } : {}),
    codingToolRoot: packageWorkdir(ctx.packageView),
    ...(fileOutputPath !== undefined ? { codingToolFileOutput: fileOutputPath } : {}),
    codingToolRepoRoot: storyExecRoot(ctx.packageView),
    // PR1 (single-frame redesign): thread the repo root and the story's
    // RELATIVE package dir independently of codingToolRoot, so
    // resolveCodingToolSupport can resolve declared commands' execution cwd
    // and per-package config without depending on what codingToolRoot means
    // at dispatch time (PR2 repoints it at storyExecRoot).
    projectDir: ctx.runtime.projectDir,
    codingToolPackageDir: ctx.packageView.packageDir,
    outputDir: ctx.runtime.outputDir,
    ...(keepOpen ? { keepOpen: true } : {}),
    ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
    ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
    ...(ctx.maxInteractionTurns !== undefined ? { maxInteractionTurns: ctx.maxInteractionTurns } : {}),
  };
}
