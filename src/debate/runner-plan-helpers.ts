/**
 * runner-plan-helpers.ts
 *
 * Internal helpers for runPlan(): pre-phase invocation, stateful session lifecycle,
 * rebuttal loop, and tag-expert complexity rewrite.
 */

import { resolveDefaultAgent } from "../agents";
import type { SessionHandle } from "../agents/types";
import type { ConfiguredModel, ModelDef } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { CallContext } from "../operations/types";
import type { DebatePromptBuilder } from "../prompts";
import type { SessionRole } from "../runtime/session-role";
import type { ISessionManager } from "../session/types";
import type { PreDebatePhaseContext } from "./pre-phase";
import { resolvePreDebatePhase } from "./pre-phase";
import type { HybridCtx } from "./runner-hybrid";
import {
  _debateSessionDeps,
  modelTierFromDebater,
  pipelineStageForDebate,
  resolveModelDefForDebater,
} from "./session-helpers";
import type { ResolvedDebater, SuccessfulProposal } from "./session-helpers";
import type { DebateStageConfig, Rebuttal } from "./types";
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

export interface RebuttalLoopResult {
  rebuttals: Rebuttal[];
  costUsd: number;
}

export async function runRebuttalLoop(
  ctx: HybridCtx,
  proposals: SuccessfulProposal[],
  builder: DebatePromptBuilder,
  sessionRolePrefix: `debate-${string}`,
): Promise<RebuttalLoopResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const rebuttals: Rebuttal[] = [];
  let costUsd = 0;
  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return { rebuttals: [], costUsd: 0 };
  }

  const proposalList = proposals.map((s) => ({ debater: s.debater, output: s.output }));
  const sessionManager = ctx.sessionManager;

  const internalHandles: Array<SessionHandle | null> = [];
  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const sessionRole = `${sessionRolePrefix}-${i}` as SessionRole;
    if (proposal.handle) {
      internalHandles.push(null);
    } else if (sessionManager) {
      const modelTier = modelTierFromDebater(proposal.debater);
      const model = { agent: proposal.debater.agent, model: proposal.debater.model ?? modelTier };
      const modelDef = resolveModelDefForDebater(
        proposal.debater,
        model,
        ctx.config.models,
        resolveDefaultAgent(ctx.config),
      );
      const name = sessionManager.nameFor({
        workdir: ctx.workdir,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
        role: sessionRole,
      });
      const handle = await sessionManager.openSession(name, {
        agentName: proposal.agentName,
        role: sessionRole,
        workdir: ctx.workdir,
        pipelineStage: pipelineStageForDebate(ctx.stage),
        modelDef,
        timeoutSeconds: ctx.timeoutSeconds,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
        signal: ctx.abortSignal,
      });
      internalHandles.push(handle);
    } else {
      internalHandles.push(null);
    }
  }

  try {
    for (let round = 1; round <= config.rounds; round++) {
      const priorRebuttals = rebuttals.filter((r) => r.round < round);

      for (let debaterIdx = 0; debaterIdx < proposals.length; debaterIdx++) {
        const proposal = proposals[debaterIdx];
        const effectiveHandle = proposal.handle ?? internalHandles[debaterIdx];
        if (!effectiveHandle) continue;

        logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
          storyId: ctx.storyId,
          round,
          debaterIndex: debaterIdx,
        });

        const rebuttalPrompt = builder.buildRebuttalPrompt(debaterIdx, proposalList, priorRebuttals);

        try {
          const turnResult = await agentManager.runAsSession(proposal.agentName, effectiveHandle, rebuttalPrompt, {
            storyId: ctx.storyId,
            pipelineStage: pipelineStageForDebate(ctx.stage),
          });
          costUsd += turnResult.estimatedCostUsd ?? 0;
          rebuttals.push({ debater: proposal.debater, round, output: turnResult.output });
        } catch (err) {
          logger?.warn("debate", "debate:rebuttal-failed", {
            storyId: ctx.storyId,
            round,
            debaterIndex: debaterIdx,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } finally {
    for (const handle of internalHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // ignore close errors
        }
      }
    }
  }

  return { rebuttals, costUsd };
}
