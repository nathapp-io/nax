import * as callModule from "../operations/call";
import { type DebateStatefulInput, type DebateStatefulOutput, statefulDebaterOp } from "../operations/debate-stateful";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { ResolvedDebater, SuccessfulProposal } from "./session-helpers";
import type { Debater } from "./types";

const DEFAULT_ABORT_SIGNAL = new AbortController().signal;

/**
 * Injectable dependencies for the stateful debate runners (runner-stateful.ts
 * and runner-stateful-helpers.ts) — allows tests to mock without mock.module().
 */
export const _statefulDeps: {
  /**
   * Monomorphic on purpose: this module dispatches exactly one op, so the
   * inferred generic signature over-stated the seam and no stub could satisfy
   * it without a cast (#1514 callop-seam).
   */
  callOp: (ctx: CallContext, op: typeof statefulDebaterOp, input: DebateStatefulInput) => Promise<DebateStatefulOutput>;
} = {
  callOp: callModule.callOp,
};

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

export async function runZeroSuccessFallback(
  ctx: StatefulCoordinatorCtx,
  prompt: string,
  firstDebater: ResolvedDebater | undefined,
): Promise<SuccessfulProposal | null> {
  if (!firstDebater) return null;

  const barrierState = createProposalBarrier();
  const signal = resolveStatefulSignal(ctx);

  try {
    await _statefulDeps.callOp(createDebaterCallContext(ctx, firstDebater.agentName), statefulDebaterOp, {
      debater: firstDebater.debater,
      index: 0,
      proposePrompt: prompt,
      buildRebutPrompt: () => "",
      proposalBarriers: [barrierState.barrier],
      signal,
      storyId: ctx.storyId,
      skipRebuttal: true,
    } satisfies DebateStatefulInput);

    const output = await barrierState.barrier.promise;
    return { debater: firstDebater.debater, agentName: firstDebater.agentName, output, cost: 0 };
  } catch {
    return null;
  }
}
