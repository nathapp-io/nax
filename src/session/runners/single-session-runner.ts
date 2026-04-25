/**
 * SingleSessionRunner — one agent session per user story (test-after /
 * no-test strategies). Delegates to AgentManager.runWithFallback for
 * cross-agent swap on availability failure, wrapped in
 * SessionManager.runInSession for lifecycle bookkeeping.
 *
 * Extracted verbatim from src/pipeline/stages/execution.ts — no behaviour
 * change in this phase. The extraction exists so TDD's ThreeSessionRunner
 * (Phase 2) can share the same `ISessionRunner` contract instead of
 * re-implementing cross-cutting concerns.
 */

import type { AgentAdapter } from "../../agents";
import { wrapAdapterAsManager } from "../../agents";
import type { AgentRunRequest, IAgentManager } from "../../agents/manager-types";
import type { AgentResult, AgentRunOptions } from "../../agents/types";
import { resolveModelForAgent } from "../../config";
import type { NaxConfig } from "../../config";
import { ContextOrchestrator, createContextToolRuntime } from "../../context/engine";
import type { AdapterFailure, ContextBundle, RunCallCounter } from "../../context/engine";
import { writeRebuildManifest } from "../../context/engine/manifest-store";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import type { ISessionRunner, SessionRunnerContext, StoryRunOutcome } from "../session-runner";
import type { ISessionManager, SessionDescriptor } from "../types";

/**
 * Additional per-story context that SingleSessionRunner needs beyond the
 * generic SessionRunnerContext (for bundle rebuild + swap-handoff prompt
 * rewrite). Kept separate so the `ISessionRunner` interface remains narrow
 * and future runners (ThreeSessionRunner) don't have to carry fields they
 * don't use.
 */
export interface SingleSessionRunnerContext extends SessionRunnerContext {
  /** Full nax config — needed for resolveModelForAgent during swap hops. */
  config: NaxConfig;
  /** Effective model tier for this story (after validateAgentForTier clamping). */
  effectiveTier: Parameters<typeof resolveModelForAgent>[2];
  /** Story the runner is executing — used for swap manifest + logging. */
  story: UserStory;
  /** Feature name for rebuild manifest writes. */
  featureName: string;
  /** Absolute path to repo root where .nax/ lives. */
  projectDir?: string;
  /** Workdir for the story (may differ from projectDir in monorepos). */
  workdir: string;
  /** Per-run context-tool call counter (for tool budgets). */
  contextToolRunCounter?: RunCallCounter;
  /** Protocol-aware agent resolver — falls back to standalone getAgent. */
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}

/**
 * Swappable dependencies — matches the _executionDeps pattern in
 * pipeline/stages/execution.ts so tests can inject mocks without touching
 * globals.
 */
export const _singleSessionRunnerDeps = {
  rebuildForAgent: (
    prior: ContextBundle,
    newAgentId: string,
    failure: AdapterFailure,
    storyId?: string,
  ): ContextBundle => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
  writeRebuildManifest,
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  createContextToolRuntime,
};

/** Parameters for the per-hop agent runner helper. */
interface HopParams {
  agentGetFn?: (name: string) => AgentAdapter | undefined;
  primaryOptions: AgentRunOptions;
  story: UserStory;
  config: NaxConfig;
  projectDir?: string;
  featureName: string;
  sessionManager?: ISessionManager;
  sessionId?: string;
  sessionDescriptor?: SessionDescriptor;
  effectiveTier: Parameters<typeof resolveModelForAgent>[2];
  defaultAgent: string;
  workdir: string;
  contextToolRunCounter?: RunCallCounter;
}

/** Return shape of executeHopFn — matches AgentRunRequest["executeHop"] return type. */
type HopResult = { result: AgentResult; bundle: ContextBundle | undefined; prompt: string };

/**
 * Drives per-hop bundle rebuild + swap-handoff prompt rewrite.
 * Called by the executeHop closure for every hop (primary + fallback).
 * Pure helper — does not mutate outer state; callers update finalBundle/finalPrompt.
 */
async function executeHopFn(
  params: HopParams,
  agentName: string,
  hopBundle: ContextBundle | undefined,
  failure: AdapterFailure | undefined,
): Promise<HopResult> {
  const {
    agentGetFn,
    primaryOptions,
    story,
    config,
    projectDir,
    featureName,
    sessionManager,
    sessionId,
    sessionDescriptor,
    effectiveTier,
    defaultAgent,
    workdir,
    contextToolRunCounter,
  } = params;

  const logger = getLogger();
  const hopAgent = (agentGetFn ?? _singleSessionRunnerDeps.getAgent)(agentName) ?? undefined;
  if (!hopAgent) {
    return {
      result: {
        success: false,
        exitCode: 1,
        output: `Agent "${agentName}" not found`,
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      } satisfies AgentResult,
      bundle: hopBundle,
      prompt: primaryOptions.prompt,
    };
  }

  let workingBundle = hopBundle;
  let prompt: string = primaryOptions.prompt;

  if (failure && hopBundle) {
    workingBundle = _singleSessionRunnerDeps.rebuildForAgent(hopBundle, agentName, failure, story.id);
    if (projectDir && featureName && workingBundle.manifest.rebuildInfo) {
      try {
        await _singleSessionRunnerDeps.writeRebuildManifest(projectDir, featureName, story.id, {
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
    prompt = RectifierPromptBuilder.swapHandoff(primaryOptions.prompt, workingBundle.pushMarkdown);
  }

  const session: SessionDescriptor | undefined =
    failure && sessionManager && sessionId
      ? sessionManager.handoff?.(sessionId, agentName, failure.outcome)
      : sessionDescriptor;

  const hopResult = await hopAgent.run({
    ...primaryOptions,
    prompt,
    modelDef: resolveModelForAgent(config.models, agentName, effectiveTier, defaultAgent),
    contextPullTools: workingBundle?.pullTools,
    contextToolRuntime: workingBundle
      ? _singleSessionRunnerDeps.createContextToolRuntime({
          bundle: workingBundle,
          story,
          config,
          repoRoot: workdir,
          runCounter: contextToolRunCounter,
        })
      : undefined,
    ...(session && { session }),
  });

  // Per-hop bindHandle so intermediate swaps update the descriptor before
  // runInSession's final bind; resumes land on the right ACP record.
  if (hopResult.protocolIds && sessionManager && sessionId) {
    const desc = sessionManager.get(sessionId);
    if (desc) {
      sessionManager.bindHandle(sessionId, hopAgent.deriveSessionName(desc), hopResult.protocolIds);
    }
  }

  return { result: hopResult, bundle: workingBundle, prompt };
}

export class SingleSessionRunner implements ISessionRunner {
  readonly name = "single-session";

  async run(context: SingleSessionRunnerContext): Promise<StoryRunOutcome> {
    const {
      sessionId,
      sessionManager,
      agentManager,
      agent,
      defaultAgent,
      runOptions,
      bundle,
      config,
      effectiveTier,
      story,
      featureName,
      projectDir,
      workdir,
      contextToolRunCounter,
      agentGetFn,
    } = context;

    const sessionDescriptor = sessionManager && sessionId ? (sessionManager.get(sessionId) ?? undefined) : undefined;

    const primaryOptions: AgentRunOptions = {
      ...runOptions,
      contextPullTools: bundle?.pullTools,
      contextToolRuntime: bundle
        ? _singleSessionRunnerDeps.createContextToolRuntime({
            bundle,
            story,
            config,
            repoRoot: workdir,
            runCounter: contextToolRunCounter,
          })
        : undefined,
      ...(sessionDescriptor && { session: sessionDescriptor }),
    };

    // finalBundle/finalPrompt track the last hop's bundle + prompt via side effects.
    // IAgentManager.run() returns only AgentResult, so these are captured here and
    // updated after each executeHopFn call. Retained as primary-agent values if no
    // hop ran (no agentManager / no swap).
    let finalBundle: ContextBundle | undefined = bundle;
    let finalPrompt: string | undefined = runOptions.prompt;

    const hopParams: HopParams = {
      agentGetFn,
      primaryOptions,
      story,
      config,
      projectDir,
      featureName,
      sessionManager,
      sessionId,
      sessionDescriptor,
      effectiveTier,
      defaultAgent,
      workdir,
      contextToolRunCounter,
    };

    // executeHop: thin wrapper that delegates to executeHopFn and captures the
    // last hop's bundle/prompt for StoryRunOutcome. Called by runWithFallback.
    const executeHop: AgentRunRequest["executeHop"] = async (agentName, hopBundle, failure, resolvedRunOptions) => {
      const hop = await executeHopFn(
        { ...hopParams, primaryOptions: resolvedRunOptions },
        agentName,
        hopBundle,
        failure,
      );
      finalBundle = hop.bundle ?? finalBundle;
      finalPrompt = hop.prompt;
      return hop;
    };

    // ADR-013 Phase 1: agentManager is passed directly to runInSession.
    // When agentManager is absent (test / bootstrap paths), wrap the agent
    // adapter so runInSession always receives an IAgentManager.
    const effectiveManager: IAgentManager = agentManager ?? wrapAdapterAsManager(agent);

    // Always pass executeHop so any IAgentManager implementation (real or wrapped)
    // has access to the hop rebuild + handoff logic if it chooses to invoke it.
    // wrapAdapterAsManager ignores executeHop safely (no fallback logic).
    const request: AgentRunRequest = {
      runOptions: primaryOptions,
      bundle,
      signal: primaryOptions.abortSignal,
      executeHop,
    };

    // Route through runInSession for lifecycle bookkeeping when a descriptor is
    // present; otherwise call run() directly (test / bootstrap paths).
    const result =
      sessionManager && sessionId
        ? await sessionManager.runInSession(sessionId, effectiveManager, request)
        : await effectiveManager.run(request);

    return {
      success: result.success,
      primaryResult: result,
      totalCost: result.estimatedCost ?? 0,
      totalTokenUsage: result.tokenUsage
        ? {
            inputTokens: result.tokenUsage.inputTokens ?? 0,
            outputTokens: result.tokenUsage.outputTokens ?? 0,
            ...(result.tokenUsage.cacheReadInputTokens !== undefined && {
              cacheReadInputTokens: result.tokenUsage.cacheReadInputTokens,
            }),
            ...(result.tokenUsage.cacheCreationInputTokens !== undefined && {
              cacheCreationInputTokens: result.tokenUsage.cacheCreationInputTokens,
            }),
          }
        : undefined,
      fallbacks: result.agentFallbacks ?? [],
      finalBundle,
      finalPrompt,
      adapterFailure: result.adapterFailure,
    };
  }
}
