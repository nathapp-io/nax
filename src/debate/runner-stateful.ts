import type { IAgentManager } from "../agents";
import type { SessionHandle } from "../agents/types";
import * as callModule from "../operations/call";
import type { CallContext } from "../operations/types";
import {
  type DebateStatefulInput,
  type DebateStatefulOutput,
  statefulDebaterOp,
} from "../operations/debate-stateful";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  pipelineStageForDebate,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Debater, Proposal } from "./types";

const DEFAULT_MAX_CONCURRENT_DEBATERS = 2;

interface StatefulCtx extends DispatchContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: import("../config/selectors").DebateConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly callContext: CallContext;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

interface ProposalBarrierState {
  readonly barrier: PromiseWithResolvers<string>;
  readonly isSettled: () => boolean;
}

export async function runStatefulTurn(
  ctx: StatefulCtx,
  agentManager: IAgentManager,
  agentName: string,
  debater: Debater,
  prompt: string,
  handle: SessionHandle,
): Promise<SuccessfulProposal> {
  const runAsSession = agentManager["runAsSession"].bind(agentManager);
  const turnResult = await runAsSession(agentName, handle, prompt, {
    storyId: ctx.storyId,
    pipelineStage: pipelineStageForDebate(ctx.stage),
  });

  return {
    debater,
    agentName,
    output: turnResult.output,
    cost: turnResult.estimatedCostUsd ?? 0,
    handle,
  };
}

function createProposalBarrier(): ProposalBarrierState {
  const barrier = Promise.withResolvers<string>();
  let settled = false;

  return {
    barrier: {
      promise: barrier.promise,
      resolve(value) {
        if (settled) return;
        settled = true;
        barrier.resolve(value);
      },
      reject(reason) {
        if (settled) return;
        settled = true;
        barrier.reject(reason);
      },
    },
    isSettled: () => settled,
  };
}

function rejectUnresolvedBarriers(barriers: ProposalBarrierState[], reason: Error): void {
  for (const barrier of barriers) {
    if (!barrier.isSettled()) {
      barrier.barrier.reject(reason);
    }
  }
}

async function runStatefulBounded<T>(
  tasks: Array<() => Promise<T>>,
  barrierStates: ProposalBarrierState[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  const completion = Promise.withResolvers<PromiseSettledResult<T>[]>();
  const concurrency = Math.max(1, Math.min(limit, tasks.length));
  let active = 0;
  let nextIndex = 0;
  let completed = 0;
  let overflowScheduled = false;
  const finished = new Array(tasks.length).fill(false);
  const proposalReached = new Array(tasks.length).fill(false);

  const startTask = (currentIndex: number): void => {
    active += 1;
    void barrierStates[currentIndex].barrier.promise.then(
      () => {
        proposalReached[currentIndex] = true;
        scheduleOverflowLaunch();
      },
      () => {
        proposalReached[currentIndex] = true;
        scheduleOverflowLaunch();
      },
    );

    const finishCurrentTask = (): void => {
      active -= 1;
      completed += 1;
      finished[currentIndex] = true;
      if (completed === tasks.length) {
        completion.resolve(results);
        return;
      }
      process.nextTick(launchNext);
    };

    void tasks[currentIndex]().then(
      (value) => {
        results[currentIndex] = { status: "fulfilled", value };
        finishCurrentTask();
      },
      (reason) => {
        results[currentIndex] = { status: "rejected", reason };
        finishCurrentTask();
      },
    );
  };

  const allActiveDebatersReachedBarrier = (): boolean => {
    if (active === 0) return false;
    for (let index = 0; index < nextIndex; index++) {
      if (!finished[index] && !proposalReached[index]) {
        return false;
      }
    }
    return true;
  };

  const scheduleOverflowLaunch = (): void => {
    if (overflowScheduled || nextIndex >= tasks.length) return;
    overflowScheduled = true;
    queueMicrotask(() => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            overflowScheduled = false;
            if (nextIndex >= tasks.length || !allActiveDebatersReachedBarrier()) {
              return;
            }
            startTask(nextIndex++);
          });
        });
      });
    });
  };

  const launchNext = (): void => {
    while (active < concurrency && nextIndex < tasks.length) {
      startTask(nextIndex++);
    }
  };

  launchNext();
  return completion.promise;
}

function buildProposalRecords(
  resolved: ResolvedDebater[],
  proposalSettled: PromiseSettledResult<string>[],
): SuccessfulProposal[] {
  return proposalSettled.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [{ debater: resolved[index].debater, agentName: resolved[index].agentName, output: result.value, cost: 0 }]
      : [],
  );
}

function buildRebuttalPromptBuilder(stage: string, prompt: string, debaters: Debater[]): DebatePromptBuilder {
  return new DebatePromptBuilder({ taskContext: prompt, outputFormat: "", stage }, { debaters, sessionMode: "stateful" });
}

function createDebaterCallContext(ctx: StatefulCtx, agentName: string): CallContext {
  const baseAgentManager = ctx.callContext.runtime.agentManager;
  const runtimeAgentManager = {
    ...baseAgentManager,
    runWithFallback: async (request: import("../agents/manager-types").AgentRunRequest, primaryAgentOverride?: string) => {
      if (!request.executeHop) {
        return baseAgentManager.runWithFallback(request, primaryAgentOverride);
      }

      const finalAgent = primaryAgentOverride ?? agentName;
      const hop = await request.executeHop(finalAgent, request.bundle, { kind: "primary" }, request.runOptions);
      return {
        result: hop.result,
        fallbacks: [],
        finalAgent,
        finalBundle: hop.bundle,
        finalPrompt: hop.prompt,
      };
    },
  };

  return {
    ...ctx.callContext,
    agentName,
    runtime: {
      ...ctx.callContext.runtime,
      agentManager: runtimeAgentManager,
    },
  };
}

function hasStructuredPassedField(output: string): boolean {
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).passed === "boolean";
  } catch {
    return false;
  }
}

function buildResolverContext(
  successfulProposals: SuccessfulProposal[],
  resolverContextInput: ResolverContextInput | undefined,
) {
  if (!resolverContextInput) return undefined;
  return {
    ...resolverContextInput,
    labeledProposals: successfulProposals.map((proposal) => ({
      debater: buildDebaterLabel(proposal.debater),
      output: proposal.output,
    })),
  };
}

async function runZeroSuccessFallback(
  ctx: StatefulCtx,
  prompt: string,
  firstDebater: ResolvedDebater | undefined,
): Promise<SuccessfulProposal | null> {
  if (!firstDebater) return null;

  const builder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: [firstDebater.debater], sessionMode: "stateful" },
  );
  const barrierState = createProposalBarrier();
  const signal = ctx.callContext.runtime.signal ?? ctx.abortSignal;

  try {
    await callModule.callOp(createDebaterCallContext(ctx, firstDebater.agentName), statefulDebaterOp, {
      debater: firstDebater.debater,
      index: 0,
      proposePrompt: builder.buildProposalPrompt(0),
      buildRebutPrompt: (peerProposals) =>
        buildRebuttalPromptBuilder(ctx.stage, prompt, [firstDebater.debater]).buildCritiquePrompt(
          0,
          peerProposals.map((output) => ({ debater: firstDebater.debater, output })),
        ),
      proposalBarriers: [barrierState.barrier],
      signal,
      storyId: ctx.storyId,
    });

    const output = await barrierState.barrier.promise;
    return { debater: firstDebater.debater, agentName: firstDebater.agentName, output, cost: 0 };
  } catch {
    return null;
  }
}

export async function runStateful(ctx: StatefulCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const debaters = resolvePersonas(ctx.stageConfig.debaters ?? [], personaStage, ctx.stageConfig.autoPersona ?? false);
  const resolved = debaters.flatMap((debater) =>
    ctx.agentManager.getAgent(debater.agent) ? [{ debater, agentName: debater.agent }] : [],
  );

  for (const debater of debaters) {
    if (!ctx.agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
    }
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((entry) => entry.debater.agent),
  });

  const concurrencyLimit =
    ctx.callContext.runtime.configLoader.current().debate?.maxConcurrentDebaters ?? DEFAULT_MAX_CONCURRENT_DEBATERS;
  const barrierStates = resolved.map(() => createProposalBarrier());
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((entry) => entry.debater), sessionMode: "stateful" },
  );
  const rebuttalBuilder = buildRebuttalPromptBuilder(
    ctx.stage,
    prompt,
    resolved.map((entry) => entry.debater),
  );
  const signal = ctx.callContext.runtime.signal ?? ctx.abortSignal;
  const failureError = new Error(`[debate] Stateful debate aborted for story ${ctx.storyId}`);

  const rebuttalSettled = await runStatefulBounded(
    resolved.map(({ debater, agentName }, index) => () =>
      callModule
        .callOp(createDebaterCallContext(ctx, agentName), statefulDebaterOp, {
          debater,
          index,
          proposePrompt: proposalBuilder.buildProposalPrompt(index),
          buildRebutPrompt: (peerProposals) =>
            rebuttalBuilder.buildCritiquePrompt(
              index,
              peerProposals.map((output, proposalIndex) => ({
                debater: resolved[proposalIndex].debater,
                output,
              })),
            ),
          proposalBarriers: barrierStates.map((barrier) => barrier.barrier),
          signal,
          storyId: ctx.storyId,
        } satisfies DebateStatefulInput)
        .then(
          (result) => {
            if (!result.success) {
              rejectUnresolvedBarriers(barrierStates, failureError);
            }
            return result;
          },
          (error) => {
            rejectUnresolvedBarriers(barrierStates, failureError);
            throw error;
          },
        ),
    ),
    barrierStates,
    concurrencyLimit,
  );

  const proposalSettled = await Promise.allSettled(barrierStates.map((barrier) => barrier.barrier.promise));
  const successfulProposals = buildProposalRecords(resolved, proposalSettled);

  for (let index = 0; index < successfulProposals.length; index++) {
    logger?.info("debate", "debate:proposal", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      debaterIndex: index,
      agent: successfulProposals[index].debater.agent,
    });
  }

  if (successfulProposals.length < 2) {
    if (successfulProposals.length === 1) {
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "only 1 debater succeeded",
      });
      return {
        storyId: ctx.storyId,
        stage: ctx.stage,
        outcome: "passed",
        rounds: 1,
        debaters: [successfulProposals[0].debater.agent],
        resolverType: ctx.stageConfig.resolver.type,
        proposals: [{ debater: successfulProposals[0].debater, output: successfulProposals[0].output }],
        totalCostUsd: 0,
      };
    }

    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "all debaters failed — retrying with first adapter",
    });

    const fallback = await runZeroSuccessFallback(ctx, prompt, resolved[0]);
    if (fallback) {
      return {
        storyId: ctx.storyId,
        stage: ctx.stage,
        outcome: "passed",
        rounds: 1,
        debaters: [fallback.debater.agent],
        resolverType: ctx.stageConfig.resolver.type,
        proposals: [{ debater: fallback.debater, output: fallback.output }],
        totalCostUsd: 0,
      };
    }

    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "fewer than 2 proposal rounds succeeded",
    });
    return buildFailedResult(ctx.storyId, ctx.stage, ctx.stageConfig, 0);
  }

  const rebuttals = rebuttalSettled.flatMap((result, index) =>
    result.status === "fulfilled" && result.value.success
      ? [{ debater: resolved[index].debater, round: 1, output: result.value.rebut }]
      : [],
  );
  const proposalOutputs = successfulProposals.map((proposal) => proposal.output);
  const shouldPassOpaqueMajority =
    ctx.stageConfig.resolver.type !== "synthesis" &&
    ctx.stageConfig.resolver.type !== "custom" &&
    proposalOutputs.every((output) => !hasStructuredPassedField(output));
  const outcome: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    rebuttals.map((rebuttal) => rebuttal.output),
    ctx.stageConfig,
    ctx.config,
    ctx.callContext,
    ctx.storyId,
    ctx.timeoutSeconds * 1000,
    ctx.workdir,
    ctx.featureName,
    ctx.reviewerSession,
    buildResolverContext(successfulProposals, ctx.resolverContextInput),
    undefined,
    successfulProposals.map((proposal) => proposal.debater),
    ctx.agentManager,
  );

  logger?.info("debate", "debate:result", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: outcome.outcome,
  });

  const proposals: Proposal[] = successfulProposals.map((proposal) => ({
    debater: proposal.debater,
    output: proposal.output,
  }));

  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: shouldPassOpaqueMajority ? "passed" : outcome.outcome,
    rounds: ctx.stageConfig.rounds,
    debaters: successfulProposals.map((proposal) => proposal.debater.agent),
    resolverType: ctx.stageConfig.resolver.type,
    proposals,
    rebuttals,
    totalCostUsd: outcome.resolverCostUsd,
  };
}
