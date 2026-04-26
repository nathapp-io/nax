/**
 * buildHopCallback — per-hop bundle-rebuild + session-dispatch factory (Phase C).
 *
 * Returned closure matches AgentRunRequest["executeHop"] and is passed
 * directly to runWithFallback.
 */

import type { AgentRunRequest, IAgentManager } from "../agents/manager-types";
import type { AgentResult, AgentRunOptions, TurnResult } from "../agents/types";
import { resolveModelForAgent } from "../config";
import type { NaxConfig } from "../config";
import { ContextOrchestrator, createContextToolRuntime } from "../context/engine";
import type { AdapterFailure, ContextBundle, RunCallCounter } from "../context/engine";
import { writeRebuildManifest } from "../context/engine/manifest-store";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { ISessionManager } from "../session";

export const _buildHopCallbackDeps = {
  rebuildForAgent: (
    prior: ContextBundle,
    newAgentId: string,
    failure: AdapterFailure,
    storyId?: string,
  ): ContextBundle => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
  writeRebuildManifest,
  createContextToolRuntime,
};

export interface BuildHopCallbackContext {
  sessionManager: ISessionManager;
  agentManager: IAgentManager;
  story: UserStory;
  config: NaxConfig;
  projectDir?: string;
  featureName: string;
  workdir: string;
  effectiveTier: Parameters<typeof resolveModelForAgent>[2];
  defaultAgent: string;
  contextToolRunCounter?: RunCallCounter;
  pipelineStage?: import("../config/permissions").PipelineStage;
}

function turnResultToAgentResult(r: TurnResult): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: r.output,
    rateLimited: false,
    durationMs: 0,
    estimatedCost: r.cost?.total ?? 0,
    tokenUsage: r.tokenUsage,
  };
}

export function buildHopCallback(
  ctx: BuildHopCallbackContext,
  sessionId: string | undefined,
  _initialOptions: AgentRunOptions,
): NonNullable<AgentRunRequest["executeHop"]> {
  const {
    sessionManager,
    agentManager,
    story,
    config,
    projectDir,
    featureName,
    workdir,
    effectiveTier,
    defaultAgent,
    contextToolRunCounter,
    pipelineStage,
  } = ctx;

  const stage = pipelineStage ?? "run";

  return async (
    agentName,
    hopBundle,
    failure,
    resolvedRunOptions,
  ): Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }> => {
    const logger = getLogger();
    let workingBundle = hopBundle;
    let prompt: string = resolvedRunOptions.prompt;

    // On failure hops: rebuild bundle for the new agent and rewrite the prompt
    if (failure && hopBundle) {
      workingBundle = _buildHopCallbackDeps.rebuildForAgent(hopBundle, agentName, failure, story.id);
      if (projectDir && featureName && workingBundle.manifest.rebuildInfo) {
        try {
          await _buildHopCallbackDeps.writeRebuildManifest(projectDir, featureName, story.id, {
            requestId: workingBundle.manifest.requestId,
            stage: "execution",
            priorAgentId: workingBundle.manifest.rebuildInfo.priorAgentId,
            newAgentId: workingBundle.manifest.rebuildInfo.newAgentId,
            failureCategory: workingBundle.manifest.rebuildInfo.failureCategory,
            failureOutcome: workingBundle.manifest.rebuildInfo.failureOutcome,
            priorChunkIds: workingBundle.manifest.rebuildInfo.priorChunkIds,
            newChunkIds: workingBundle.manifest.rebuildInfo.newChunkIds,
            chunkIdMap: workingBundle.manifest.rebuildInfo.chunkIdMap,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          logger.warn("execution", "Failed to write rebuild manifest", {
            storyId: story.id,
            error: String(err),
          });
        }
      }
      prompt = RectifierPromptBuilder.swapHandoff(resolvedRunOptions.prompt, workingBundle.pushMarkdown);
    }

    // Update descriptor metadata for failure hops
    if (failure && sessionId) {
      sessionManager.handoff?.(sessionId, agentName, failure.outcome);
    }

    const contextToolRuntime = workingBundle
      ? _buildHopCallbackDeps.createContextToolRuntime({
          bundle: workingBundle,
          story,
          config,
          repoRoot: workdir,
          runCounter: contextToolRunCounter,
        })
      : undefined;
    const contextPullTools = workingBundle?.pullTools;

    const sessionName = sessionManager.nameFor({
      workdir,
      featureName,
      storyId: story.id,
      role: resolvedRunOptions.sessionRole ?? "implementer",
      pipelineStage: stage,
    });
    const modelDef = resolveModelForAgent(config.models, agentName, effectiveTier, defaultAgent);
    const timeoutSeconds = config.execution.sessionTimeoutSeconds;

    // openSession errors propagate naturally — no handle, no closeSession needed
    const handle = await sessionManager.openSession(sessionName, {
      agentName,
      role: resolvedRunOptions.sessionRole ?? "implementer",
      workdir,
      pipelineStage: stage,
      modelDef,
      timeoutSeconds,
      featureName,
      storyId: story.id,
      signal: resolvedRunOptions.abortSignal,
    });

    try {
      const turnResult = await agentManager.runAsSession(agentName, handle, prompt, {
        storyId: story.id,
        pipelineStage: stage,
        signal: resolvedRunOptions.abortSignal,
        contextPullTools,
        contextToolRuntime,
      });
      return { result: turnResultToAgentResult(turnResult), bundle: workingBundle, prompt };
    } catch (err) {
      return {
        result: {
          success: false,
          exitCode: 1,
          output: `Agent "${agentName}" failed: ${String(err)}`,
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
          adapterFailure: {
            category: "availability",
            outcome: "fail-adapter-error",
            retriable: false,
            message: String(err).slice(0, 500),
          },
        },
        bundle: workingBundle,
        prompt,
      };
    } finally {
      await sessionManager.closeSession(handle);
    }
  };
}
