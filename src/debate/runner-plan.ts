import { join } from "node:path";
import type { DebateConfig } from "../config/selectors";
import * as callModule from "../operations/call";
import type { DebatePlanInput } from "../operations/debate-plan";
import { planDebaterOp } from "../operations/debate-plan";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
import {
  buildPlanProposalPrompt,
  buildPlanRebuttalPrompt,
  finalizePlanRun,
  runPrePhase,
  scoreAndDispatchVerifierPick,
} from "./runner-plan-helpers";
import {
  _debateSessionDeps,
  buildFailedResult,
  type ResolvedDebater,
  type SuccessfulProposal,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";

interface PlanCtx extends DispatchContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly callContext: CallContext;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly timeoutSeconds?: number;
}

const DEFAULT_MAX_CONCURRENT_DEBATERS = 2;

// Re-export so existing callers (plan.ts, tests) can continue to import from this module.
export { _runPlanDeps } from "./runner-plan-helpers";

export async function runPlan(
  ctx: PlanCtx,
  taskContext: string,
  outputFormat: string,
  opts: {
    workdir: string;
    feature: string;
    outputDir: string;
    timeoutSeconds?: number;
    maxInteractionTurns?: number;
    specContent?: string;
    manifestSection?: string;
  },
): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const sessionManager = ctx.callContext.runtime.sessionManager;
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, "plan", config.autoPersona ?? false);
  const agentManager = ctx.agentManager;
  if (!agentManager || !sessionManager) {
    return buildFailedResult(ctx.storyId, ctx.stage, config, 0);
  }

  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`, {
        storyId: ctx.storyId,
        stage: ctx.stage,
        agent: debater.agent,
      });
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  let totalCostUsd = 0;
  let manifestSection = opts.manifestSection ?? "";
  if (config.preDebatePhase) {
    const preResult = await runPrePhase(ctx, config, {
      workdir: opts.workdir,
      feature: opts.feature,
      storyId: ctx.storyId,
      timeoutSeconds: opts.timeoutSeconds,
      specContent: opts.specContent,
    });
    if (preResult.block) {
      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }
    manifestSection = preResult.manifestSection;
    totalCostUsd += preResult.costUsd;
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((e) => e.debater.agent),
  });

  const concurrencyLimit = ctx.config?.debate?.maxConcurrentDebaters ?? DEFAULT_MAX_CONCURRENT_DEBATERS;
  const selectorKind = ctx.stageConfig.selector?.kind;
  const useStatefulSessions = config.sessionMode === "stateful";
  const includeHybridRebuttals = useStatefulSessions && config.mode === "hybrid";

  if (config.mode === "hybrid" && !useStatefulSessions) {
    logger?.warn("debate", "hybrid mode requires stateful sessions — falling back to panel (no rebuttal)", {
      storyId: ctx.storyId,
      stage: ctx.stage,
    });
  }

  const proposalBuilder = new DebatePromptBuilder(
    { taskContext, outputFormat, stage: "plan" },
    {
      debaters: resolved.map((e) => e.debater),
      sessionMode: ctx.stageConfig.sessionMode ?? "one-shot",
      proposers: ctx.stageConfig.proposers,
    },
  );
  const outputPaths = resolved.map((_, i) => join(opts.outputDir, `prd-debate-${i}.json`));

  const successful: Array<SuccessfulProposal & { resolvedIndex: number }> = [];
  let rebuttalList: Rebuttal[] | undefined;

  // ── Path A: verifier-pick → coordinator with N callOp + selection signals ────
  if (selectorKind === "verifier-pick") {
    // One selectionResolver and one rebuttalBarrier per debater (AC6)
    const selectionResolvers = resolved.map(() => Promise.withResolvers<{ patchPrompt?: string }>());
    const rebuttalBarriers = resolved.map(() => Promise.withResolvers<string>());
    const proposalBarriers = resolved.map(() => Promise.withResolvers<string>());

    const rebutBuilder = new DebatePromptBuilder(
      { taskContext, outputFormat: "", stage: "plan" },
      { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
    );

    // Launch N callOp invocations without awaiting them (AC6)
    const callOpPromises = resolved.map(({ debater, agentName }, index) => {
      const debaterCtx: CallContext = {
        ...ctx.callContext,
        agentName,
        sessionOverride: { role: `debate-plan-${index}` as SessionRole },
      };
      return callModule.callOp(debaterCtx, planDebaterOp, {
        debater,
        index,
        proposePrompt: buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection),
        buildRebutPrompt: (peerProposals) =>
          buildPlanRebuttalPrompt(
            rebutBuilder,
            index,
            outputPaths[index],
            peerProposals.map((output, i) => ({ debater: resolved[i]?.debater ?? debater, output })),
          ),
        proposalBarriers,
        rebuttalBarrier: rebuttalBarriers[index],
        selectionSignal: selectionResolvers[index].promise,
        signal: ctx.abortSignal ?? new AbortController().signal,
        storyId: ctx.storyId,
        outputPath: outputPaths[index],
        includeHybridRebuttals: false,
      } satisfies DebatePlanInput);
    });

    // Propagate callOp settlement to rebuttalBarriers (AC9).
    // In production, hopBody resolves the barrier before callOp returns — .then() is a no-op.
    // If callOp is mocked or fails before hopBody runs, this ensures barriers always settle.
    for (let i = 0; i < callOpPromises.length; i++) {
      callOpPromises[i].then(
        (result) => {
          rebuttalBarriers[i].resolve(result.rebut ?? "");
        },
        (err) => {
          rebuttalBarriers[i].reject(err);
        },
      );
    }

    const rebuttalSettled = await Promise.allSettled(rebuttalBarriers.map((b) => b.promise));
    await scoreAndDispatchVerifierPick(
      resolved,
      rebuttalSettled,
      ctx,
      opts,
      agentManager,
      selectionResolvers,
      outputPaths,
    );
    const settled = await Promise.allSettled(callOpPromises);

    for (let i = 0; i < settled.length; i++) {
      const res = settled[i];
      const succeeded = res.status === "fulfilled" && res.value.success;
      if (succeeded && res.status === "fulfilled") {
        successful.push({
          debater: resolved[i].debater,
          agentName: resolved[i].agentName,
          output: res.value.rebut,
          cost: 0,
          resolvedIndex: i,
        });
      } else {
        // Debater failed: use pre-patch rebuttal output if captured (AC9)
        const rb = rebuttalSettled[i];
        const rebutOutput = rb?.status === "fulfilled" ? rb.value : undefined;
        if (rebutOutput !== undefined) {
          successful.push({
            debater: resolved[i].debater,
            agentName: resolved[i].agentName,
            output: rebutOutput,
            cost: 0,
            resolvedIndex: i,
          });
        } else {
          logger?.warn("debate", "debate:debater-failed", {
            storyId: ctx.storyId,
            stage: ctx.stage,
            debaterIndex: i,
            agent: resolved[i].debater.agent,
            error:
              res.status === "rejected"
                ? res.reason instanceof Error
                  ? res.reason.message
                  : String(res.reason)
                : `debate op returned success:false — ${res.value.rebut}`,
          });
        }
      }
    }
  }

  // ── Path B: stateful (non-verifier-pick) → planDebaterOp via callOp ──────────
  else if (useStatefulSessions) {
    // Selection signals resolve immediately — no patch step for non-verifier-pick paths.
    const selectionResolvers = resolved.map(() => Promise.withResolvers<{ patchPrompt?: string }>());
    for (const resolver of selectionResolvers) resolver.resolve({});
    const proposalBarriers = resolved.map(() => Promise.withResolvers<string>());
    const rebuttalBarriers = resolved.map(() => Promise.withResolvers<string>());
    // Mark observed up front — a lone/early-failing debater's barrier can otherwise reject with no subscriber.
    for (const barrier of proposalBarriers) barrier.promise.catch(() => {});

    const rebutBuilder = new DebatePromptBuilder(
      { taskContext, outputFormat: "", stage: "plan" },
      { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
    );

    // Launch all N debaters concurrently — shared proposalBarriers require all
    // debaters to be in-flight simultaneously (same constraint as hybrid runner).
    const callOpPromisesB = resolved.map(({ debater, agentName }, index) => {
      const debaterCtx: CallContext = {
        ...ctx.callContext,
        agentName,
        sessionOverride: { role: `debate-plan-${index}` as SessionRole },
      };
      return callModule.callOp(debaterCtx, planDebaterOp, {
        debater,
        index,
        proposePrompt: buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection),
        buildRebutPrompt: (peerProposals) =>
          buildPlanRebuttalPrompt(
            rebutBuilder,
            index,
            outputPaths[index],
            peerProposals.map((output, i) => ({ debater: resolved[i]?.debater ?? debater, output })),
          ),
        proposalBarriers,
        rebuttalBarrier: rebuttalBarriers[index],
        selectionSignal: selectionResolvers[index].promise,
        signal: ctx.abortSignal ?? new AbortController().signal,
        storyId: ctx.storyId,
        outputPath: outputPaths[index],
        includeHybridRebuttals,
      } satisfies DebatePlanInput);
    });

    // Propagate callOp settlement to rebuttalBarriers (mirrors AC9 from Path A).
    // Also reject proposalBarriers[i] on failure — otherwise peers can block forever
    // in `Promise.all(proposalBarriers...)` waiting on a barrier that never settles (BUG-14).
    for (let i = 0; i < callOpPromisesB.length; i++) {
      callOpPromisesB[i].then(
        (result) => {
          rebuttalBarriers[i].resolve(result.rebut ?? "");
        },
        (err) => {
          proposalBarriers[i].reject(err);
          rebuttalBarriers[i].reject(err);
        },
      );
    }

    const rebuttalSettled = await Promise.allSettled(rebuttalBarriers.map((b) => b.promise));
    const settledB = await Promise.allSettled(callOpPromisesB);

    for (let i = 0; i < settledB.length; i++) {
      const res = settledB[i];
      if (res.status === "fulfilled" && res.value.success) {
        successful.push({
          debater: resolved[i].debater,
          agentName: resolved[i].agentName,
          output: res.value.rebut,
          cost: 0,
          resolvedIndex: i,
        });
      } else {
        logger?.warn("debate", "debate:debater-failed", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          debaterIndex: i,
          agent: resolved[i].debater.agent,
          error: res.status === "rejected" && res.reason instanceof Error ? res.reason.message : undefined,
        });
      }
    }

    if (includeHybridRebuttals) {
      rebuttalList = successful.flatMap((entry) => {
        const rb = rebuttalSettled[entry.resolvedIndex];
        return rb?.status === "fulfilled" ? [{ debater: entry.debater, round: 1, output: rb.value }] : [];
      });
    }
  }

  // ── Path C: one-shot (default) → planDebaterOp via callOp ───────────────────
  else {
    const selectionResolversC = resolved.map(() => Promise.withResolvers<{ patchPrompt?: string }>());
    for (const resolver of selectionResolversC) resolver.resolve({});
    const proposalBarriersC = resolved.map(() => Promise.withResolvers<string>());
    const rebuttalBarriersC = resolved.map(() => Promise.withResolvers<string>());
    // Path C never awaits rebuttalBarriers — pre-resolve so they always settle (barriers-must-settle rule).
    for (const barrier of rebuttalBarriersC) barrier.resolve("");

    const settled = await allSettledBounded(
      resolved.map(({ debater, agentName }, index) => async () => {
        const debaterCtx: CallContext = {
          ...ctx.callContext,
          agentName,
          sessionOverride: { role: `debate-plan-${index}` as SessionRole },
        };
        const result = await callModule.callOp(debaterCtx, planDebaterOp, {
          debater,
          index,
          proposePrompt: buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection),
          buildRebutPrompt: () => "",
          proposalBarriers: proposalBarriersC,
          rebuttalBarrier: rebuttalBarriersC[index],
          selectionSignal: selectionResolversC[index].promise,
          signal: ctx.abortSignal ?? new AbortController().signal,
          storyId: ctx.storyId,
          outputPath: outputPaths[index],
          includeHybridRebuttals: false,
        } satisfies DebatePlanInput);
        if (!result.success) throw new Error(result.rebut);
        return { debater, agentName, output: result.rebut, cost: 0, resolvedIndex: index };
      }),
      concurrencyLimit,
    );

    for (let i = 0; i < settled.length; i++) {
      const res = settled[i];
      if (res.status === "fulfilled") {
        successful.push(res.value);
      } else {
        logger?.warn("debate", "debate:debater-failed", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          debaterIndex: i,
          agent: resolved[i].debater.agent,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    }
  }

  for (const entry of successful) {
    logger?.info("debate", "debate:proposal", { storyId: ctx.storyId, stage: ctx.stage, agent: entry.debater.agent });
  }

  return finalizePlanRun(
    {
      storyId: ctx.storyId,
      stage: ctx.stage,
      stageConfig: ctx.stageConfig,
      config: ctx.config,
      callContext: ctx.callContext,
    },
    { workdir: opts.workdir, feature: opts.feature, specContent: opts.specContent },
    successful,
    rebuttalList,
    outputPaths,
    totalCostUsd,
    agentManager,
    selectorKind,
    includeHybridRebuttals,
  );
}
