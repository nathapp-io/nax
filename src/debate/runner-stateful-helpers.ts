import * as callModule from "../operations/call";
import { type DebateStatefulInput, statefulDebaterOp } from "../operations/debate-stateful";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import { buildDebaterLabel } from "./personas";
import type { ResolvedDebater, ResolverContextInput, SuccessfulProposal } from "./session-helpers";
import type { Debater } from "./types";

const DEFAULT_ABORT_SIGNAL = new AbortController().signal;

export interface ProposalBarrierState {
  readonly barrier: PromiseWithResolvers<string>;
  readonly isSettled: () => boolean;
}

export interface StatefulCoordinatorCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly workdir: string;
  readonly featureName: string;
  readonly callContext: CallContext;
  readonly resolverContextInput?: ResolverContextInput;
  readonly abortSignal?: AbortSignal;
}

export type DebateDebaterExecutionMode = "stateful" | "one-shot";

export function createProposalBarrier(): ProposalBarrierState {
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

export function rejectUnresolvedBarriers(barriers: ProposalBarrierState[], reason: Error): void {
  for (const barrier of barriers) {
    if (!barrier.isSettled()) {
      barrier.barrier.reject(reason);
    }
  }
}

export async function runStatefulBounded<T>(
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

  const allActiveDebatersReachedBarrier = (): boolean => {
    if (active === 0) return false;
    for (let index = 0; index < nextIndex; index++) {
      if (!finished[index] && !proposalReached[index]) return false;
    }
    return true;
  };

  const scheduleOverflowLaunch = (): void => {
    if (overflowScheduled || nextIndex >= tasks.length) return;
    overflowScheduled = true;
    queueMicrotask(() => {
      overflowScheduled = false;
      if (nextIndex >= tasks.length || !allActiveDebatersReachedBarrier()) return;
      startTask(nextIndex++);
      scheduleOverflowLaunch();
    });
  };

  const finishTask = (currentIndex: number): void => {
    active -= 1;
    completed += 1;
    finished[currentIndex] = true;
    if (completed === tasks.length) {
      completion.resolve(results);
      return;
    }
    launchNext();
  };

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

    void tasks[currentIndex]().then(
      (value) => {
        results[currentIndex] = { status: "fulfilled", value };
        finishTask(currentIndex);
      },
      (reason) => {
        results[currentIndex] = { status: "rejected", reason };
        finishTask(currentIndex);
      },
    );
  };

  const launchNext = (): void => {
    while (active < concurrency && nextIndex < tasks.length) {
      startTask(nextIndex++);
    }
  };

  launchNext();
  return completion.promise;
}

export function buildProposalRecords(
  resolved: ResolvedDebater[],
  proposalSettled: PromiseSettledResult<string>[],
): SuccessfulProposal[] {
  return proposalSettled.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [{ debater: resolved[index].debater, agentName: resolved[index].agentName, output: result.value, cost: 0 }]
      : [],
  );
}

export function buildRebuttalPromptBuilder(stage: string, prompt: string, debaters: Debater[]): DebatePromptBuilder {
  return new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage },
    { debaters, sessionMode: "stateful" },
  );
}

export function resolveStatefulSignal(ctx: StatefulCoordinatorCtx): AbortSignal {
  return ctx.callContext.runtime.signal ?? ctx.abortSignal ?? DEFAULT_ABORT_SIGNAL;
}

export function createDebaterCallContext(ctx: StatefulCoordinatorCtx, agentName: string): CallContext {
  const baseAgentManager = ctx.callContext.runtime.agentManager;
  const runtimeAgentManager = {
    ...baseAgentManager,
    runWithFallback: async (
      request: import("../agents/manager-types").AgentRunRequest,
      primaryAgentOverride?: string,
    ) => {
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

export function createOneShotDebaterCallContext(ctx: StatefulCoordinatorCtx, agentName: string): CallContext {
  const baseAgentManager = ctx.callContext.runtime.agentManager;
  const runtimeAgentManager = {
    ...baseAgentManager,
    runWithFallback: async (
      request: import("../agents/manager-types").AgentRunRequest,
      primaryAgentOverride?: string,
    ) => {
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
    runAsSession: (
      runAgentName: string,
      handle: import("../agents/types").SessionHandle,
      prompt: string,
      opts: import("../agents/manager-types").RunAsSessionOpts,
    ) => baseAgentManager.runAsSession(runAgentName, handle, prompt, opts),
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

export function hasStructuredPassedField(output: string): boolean {
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    return (
      typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).passed === "boolean"
    );
  } catch {
    return false;
  }
}

export function buildResolverContext(
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

export async function runZeroSuccessFallback(
  ctx: StatefulCoordinatorCtx,
  prompt: string,
  firstDebater: ResolvedDebater | undefined,
): Promise<SuccessfulProposal | null> {
  if (!firstDebater) return null;

  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: [firstDebater.debater], sessionMode: "stateful" },
  );
  const barrierState = createProposalBarrier();
  const signal = resolveStatefulSignal(ctx);

  try {
    await callModule.callOp(createDebaterCallContext(ctx, firstDebater.agentName), statefulDebaterOp, {
      debater: firstDebater.debater,
      index: 0,
      proposePrompt: proposalBuilder.buildProposalPrompt(0),
      buildRebutPrompt: (peerProposals) =>
        buildRebuttalPromptBuilder(ctx.stage, prompt, [firstDebater.debater]).buildCritiquePrompt(
          0,
          peerProposals.map((output) => ({ debater: firstDebater.debater, output })),
        ),
      proposalBarriers: [barrierState.barrier],
      signal,
      storyId: ctx.storyId,
    } satisfies DebateStatefulInput);

    const output = await barrierState.barrier.promise;
    return { debater: firstDebater.debater, agentName: firstDebater.agentName, output, cost: 0 };
  } catch {
    return null;
  }
}
