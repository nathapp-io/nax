/**
 * runner-plan-helpers.ts
 *
 * Internal helpers for runPlan(): pre-phase invocation, stateful session lifecycle,
 * and tag-expert complexity rewrite.
 */

import { resolveDefaultAgent } from "../agents";
import type { SessionHandle } from "../agents/types";
import type { ConfiguredModel, ModelDef } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { CallContext } from "../operations/types";
import type { SessionRole } from "../runtime/session-role";
import type { ISessionManager } from "../session/types";
import type { PreDebatePhaseContext } from "./pre-phase";
import { resolvePreDebatePhase } from "./pre-phase";
import {
  _debateSessionDeps,
  modelTierFromDebater,
  pipelineStageForDebate,
  resolveModelDefForDebater,
} from "./session-helpers";
import type { ResolvedDebater, SuccessfulProposal } from "./session-helpers";
import type { DebateStageConfig } from "./types";
import { resolvePostDebateVerifier } from "./verifiers";

/** Injectable deps for testability — defined here to avoid circular imports with runner-plan. */
export const _runPlanDeps = {
  resolvePreDebatePhase: resolvePreDebatePhase as typeof resolvePreDebatePhase,
  resolvePostDebateVerifier: resolvePostDebateVerifier as typeof resolvePostDebateVerifier,
};

interface PlanPhaseOpts {
  workdir: string;
  feature: string;
  storyId: string;
  timeoutSeconds?: number;
  specContent?: string;
}

interface PlanCtxMinimal {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly callContext: CallContext;
  readonly abortSignal?: AbortSignal;
  readonly sessionManager?: ISessionManager;
}

/** Run the pre-debate phase, returning the manifest section and accumulated cost. */
export async function runPrePhase(
  ctx: PlanCtxMinimal,
  config: DebateStageConfig,
  opts: PlanPhaseOpts,
): Promise<{ manifestSection: string; costUsd: number; block: boolean }> {
  const logger = _debateSessionDeps.getSafeLogger();
  const prePhaseCtx: PreDebatePhaseContext = {
    ctx: ctx.callContext,
    stage: ctx.stage,
    stageConfig: config,
    workdir: opts.workdir,
    featureName: opts.feature,
    storyId: opts.storyId,
    specContent: opts.specContent,
  };
  try {
    const result = await _runPlanDeps.resolvePreDebatePhase(config.preDebatePhase?.kind ?? "")(prePhaseCtx);
    return { manifestSection: result.manifestSection, costUsd: result.costUsd, block: false };
  } catch (err) {
    const onFailure = config.preDebatePhase?.onFailure ?? "degrade";
    if (onFailure === "block") return { manifestSection: "", costUsd: 0, block: true };
    logger?.warn("debate", `pre-phase failed (degrade): ${err instanceof Error ? err.message : String(err)}`, {
      storyId: opts.storyId,
      stage: ctx.stage,
    });
    return { manifestSection: "", costUsd: 0, block: false };
  }
}

/** Pre-open one session per resolved debater for stateful plan mode. */
export async function openPlanSessions(
  resolved: ResolvedDebater[],
  config: DebateConfig,
  sessionManager: ISessionManager,
  opts: PlanPhaseOpts,
  stage: string,
  abortSignal?: AbortSignal,
): Promise<Array<SessionHandle | null>> {
  const handles: Array<SessionHandle | null> = [];
  for (let i = 0; i < resolved.length; i++) {
    const { debater: rd, agentName } = resolved[i];
    const roleKey = `debate-plan-${i}` as SessionRole;
    const modelTier = modelTierFromDebater(rd);
    const model: ConfiguredModel = { agent: rd.agent, model: rd.model ?? modelTier };
    const modelDef: ModelDef = resolveModelDefForDebater(rd, model, config.models, resolveDefaultAgent(config));
    const name = sessionManager.nameFor({
      workdir: opts.workdir,
      featureName: opts.feature,
      storyId: opts.storyId,
      role: roleKey,
    });
    try {
      const handle = await sessionManager.openSession(name, {
        agentName,
        role: roleKey,
        workdir: opts.workdir,
        pipelineStage: pipelineStageForDebate(stage),
        modelDef,
        timeoutSeconds: opts.timeoutSeconds ?? 600,
        featureName: opts.feature,
        storyId: opts.storyId,
        signal: abortSignal,
      });
      handles.push(handle);
    } catch {
      handles.push(null);
    }
  }
  return handles;
}

/** Run a stateful proposal turn and read its output from disk. */
export async function runStatefulPlanTurn(
  agentManager: import("../agents").IAgentManager,
  agentName: string,
  handle: SessionHandle,
  prompt: string,
  tempOutputPath: string,
  storyId: string,
  stage: string,
): Promise<string> {
  await agentManager.runAsSession(agentName, handle, prompt, {
    storyId,
    pipelineStage: pipelineStageForDebate(stage),
  });
  return _debateSessionDeps.readFile(tempOutputPath);
}

/** Rewrite every userStory.routing.complexity to "expert" in a PRD JSON string. */
export function rewriteComplexitiesToExpert(prdJson: string): string {
  try {
    const parsed = JSON.parse(prdJson);
    if (Array.isArray(parsed?.userStories)) {
      for (const story of parsed.userStories) {
        if (story.routing) story.routing.complexity = "expert";
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return prdJson;
  }
}

/** Close all non-null handles, swallowing errors. */
export async function closePlanSessions(
  handles: Array<SessionHandle | null>,
  sessionManager: ISessionManager,
): Promise<void> {
  for (const handle of handles) {
    if (handle) {
      try {
        await sessionManager.closeSession(handle);
      } catch {
        // Ignore close errors
      }
    }
  }
}

/** Build a SuccessfulProposal from a stateful turn result. */
export function makeStatefulProposal(
  debater: ResolvedDebater["debater"],
  agentName: string,
  output: string,
  handle: SessionHandle,
): SuccessfulProposal {
  return { debater, agentName, output, cost: 0, handle };
}
