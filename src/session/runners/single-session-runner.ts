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
import { getAgent } from "../../agents";
import type { AgentFallbackRecord, AgentRunOutcome } from "../../agents/manager-types";
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
import type { SessionAgentRunner, SessionDescriptor } from "../types";

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
  getAgent,
  createContextToolRuntime,
};

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

    const logger = getLogger();
    const sessionDescriptor = sessionManager && sessionId ? (sessionManager.get(sessionId) ?? undefined) : undefined;

    // Primary-hop context-tool runtime (recreated per swap hop below).
    const primaryContextToolRuntime = bundle
      ? _singleSessionRunnerDeps.createContextToolRuntime({
          bundle,
          story,
          config,
          repoRoot: workdir,
          runCounter: contextToolRunCounter,
        })
      : undefined;

    const primaryOptions: AgentRunOptions = {
      ...runOptions,
      contextPullTools: bundle?.pullTools,
      contextToolRuntime: primaryContextToolRuntime,
      ...(sessionDescriptor && { session: sessionDescriptor }),
    };

    // Swap tracking — populated by runWithFallback's closure when the manager path is used.
    let fallbacks: AgentFallbackRecord[] = [];
    let finalBundle: ContextBundle | undefined = bundle;
    let finalPrompt: string | undefined = runOptions.prompt;

    const runFn: SessionAgentRunner = agentManager
      ? async (opts) => {
          const outcome: AgentRunOutcome = await agentManager.runWithFallback({
            runOptions: opts,
            bundle,
            signal: opts.abortSignal,
            executeHop: async (agentName, hopBundle, failure) => {
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
                  prompt: opts.prompt,
                };
              }

              let workingBundle = hopBundle;
              let prompt: string = opts.prompt;

              // On swap, rebuild bundle for the new agent and rewrite the prompt with the handoff preamble.
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
                prompt = RectifierPromptBuilder.swapHandoff(opts.prompt, workingBundle.pushMarkdown);
              }

              // Handoff the session descriptor to the new agent so adapter correlates with the right record.
              const session: SessionDescriptor | undefined =
                failure && sessionManager && sessionId
                  ? sessionManager.handoff?.(sessionId, agentName, failure.outcome)
                  : sessionDescriptor;

              const hopResult = await hopAgent.run({
                ...opts,
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

              // Per-hop bindHandle — runInSession will do the final bind, but intermediate
              // hops update the descriptor with the hop's protocolIds too so resumes land correctly.
              if (hopResult.protocolIds && sessionManager && sessionId) {
                const desc = sessionManager.get(sessionId);
                if (desc) {
                  sessionManager.bindHandle(sessionId, hopAgent.deriveSessionName(desc), hopResult.protocolIds);
                }
              }

              return { result: hopResult, bundle: workingBundle, prompt };
            },
          });
          fallbacks = outcome.fallbacks;
          finalBundle = outcome.finalBundle ?? finalBundle;
          finalPrompt = outcome.finalPrompt ?? finalPrompt;
          return outcome.result;
        }
      : async (opts) => {
          return agent.run(opts);
        };

    // When sessionManager + sessionId are both present, go through the per-session
    // lifecycle primitive for full bookkeeping. Otherwise fall back to a direct
    // runner call — tests and bootstrap paths that don't use SessionManager can
    // still execute without a descriptor.
    const result =
      sessionManager && sessionId
        ? await sessionManager.runInSession(sessionId, runFn, primaryOptions)
        : await runFn(primaryOptions);

    return {
      success: result.success,
      primaryResult: result,
      totalCost: result.estimatedCost ?? 0,
      totalTokenUsage: result.tokenUsage
        ? {
            inputTokens: result.tokenUsage.inputTokens ?? 0,
            outputTokens: result.tokenUsage.outputTokens ?? 0,
            ...(result.tokenUsage.cache_read_input_tokens !== undefined && {
              cache_read_input_tokens: result.tokenUsage.cache_read_input_tokens,
            }),
            ...(result.tokenUsage.cache_creation_input_tokens !== undefined && {
              cache_creation_input_tokens: result.tokenUsage.cache_creation_input_tokens,
            }),
          }
        : undefined,
      fallbacks,
      finalBundle,
      finalPrompt,
      adapterFailure: result.adapterFailure,
    };
  }
}
