import { join } from "node:path";
import type { DebateConfig } from "../config/selectors";
import * as callModule from "../operations/call";
import type { DebatePlanInput } from "../operations/debate-plan";
import { planDebaterOp } from "../operations/debate-plan";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
import {
  _runPlanDeps,
  buildPlanProposalPrompt,
  buildPlanRebuttalPrompt,
  finalizePlanRun,
  runPrePhase,
  scoreAndDispatchVerifierPick,
} from "./runner-plan-helpers";
import {
  closeDebaterSessions,
  executeStatefulRebuttal,
  executeStatefulTurn,
  openDebaterSessions,
  resolveDebaterModelDef,
} from "./runner-plan-stateful";
import {
  type ResolvedDebater,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  pipelineStageForDebate,
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
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: import("./session-helpers").ResolverContextInput;
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
  let openHandles: Array<import("../agents/types").SessionHandle | null> = [];
  let rebuttalList: Rebuttal[] | undefined;

  // ── Path A: verifier-pick → coordinator with N callOp + selection signals ────
  if (selectorKind === "verifier-pick") {
    // One selectionResolver and one rebuttalBarrier per debater (AC6)
    const selectionResolvers = resolved.map(() => Promise.withResolvers<{ patchPrompt?: string }>());
    const rebuttalBarriers = resolved.map(() => Promise.withResolvers<string>());
    const proposalBarriers = resolved.map(() => Promise.withResolvers<string>());

    // Launch N callOp invocations without awaiting them (AC6)
    const callOpPromises = resolved.map(({ debater, agentName }, index) => {
      const debaterCtx: CallContext = { ...ctx.callContext, agentName };
      const rebutBuilder = new DebatePromptBuilder(
        { taskContext, outputFormat: "", stage: "plan" },
        { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
      );
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
      if (res.status === "fulfilled") {
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
            error: res.reason instanceof Error ? res.reason.message : String(res.reason),
          });
        }
      }
    }
  }

  // ── Path B: stateful (non-verifier-pick) → open/run/close sessions ───────────
  else if (useStatefulSessions) {
    const phaseOpts = {
      workdir: opts.workdir,
      feature: opts.feature,
      storyId: ctx.storyId,
      timeoutSeconds: opts.timeoutSeconds,
    };
    openHandles = await openDebaterSessions(resolved, sessionManager, phaseOpts, ctx.stage, ctx.abortSignal);

    try {
      const proposalSettled = await allSettledBounded(
        resolved.map(({ debater, agentName }, index) => async () => {
          const handle = openHandles[index] ?? null;
          if (!handle) throw new Error(`[debate] no session handle for debater ${index}`);
          const prompt = buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection);
          const output = await executeStatefulTurn(
            agentManager,
            agentName,
            handle,
            prompt,
            outputPaths[index],
            ctx.storyId,
            ctx.stage,
          );
          return { debater, agentName, output, cost: 0, resolvedIndex: index };
        }),
        concurrencyLimit,
      );

      for (let i = 0; i < proposalSettled.length; i++) {
        const res = proposalSettled[i];
        if (res.status === "fulfilled") {
          successful.push(res.value);
        } else {
          logger?.warn("debate", "debate:debater-failed", {
            storyId: ctx.storyId,
            stage: ctx.stage,
            debaterIndex: i,
            agent: resolved[i].debater.agent,
          });
        }
      }

      if (includeHybridRebuttals && successful.length >= 2) {
        const rebutBuilder = new DebatePromptBuilder(
          { taskContext, outputFormat: "", stage: "plan" },
          { debaters: successful.map((p) => p.debater), sessionMode: "stateful" },
        );
        const priorRebuttals: Rebuttal[] = [];
        for (let round = 1; round <= config.rounds; round++) {
          const settledRound = await allSettledBounded(
            successful.map((entry, localIndex) => async () => {
              const handle = openHandles[entry.resolvedIndex] ?? null;
              if (!handle) return { debater: entry.debater, output: entry.output };
              const rebutPrompt = buildPlanRebuttalPrompt(
                rebutBuilder,
                localIndex,
                outputPaths[entry.resolvedIndex],
                successful.map((p) => ({ debater: p.debater, output: p.output })),
                priorRebuttals,
              );
              const rebutOutput = await executeStatefulRebuttal(
                agentManager,
                entry.agentName,
                handle,
                rebutPrompt,
                outputPaths[entry.resolvedIndex],
                ctx.storyId,
                ctx.stage,
              );
              return { debater: entry.debater, output: rebutOutput };
            }),
            concurrencyLimit,
          );
          const roundRebuttals = settledRound.flatMap((result, index) =>
            result.status === "fulfilled"
              ? [{ debater: successful[index].debater, round, output: result.value.output }]
              : [],
          );
          priorRebuttals.push(...roundRebuttals);
        }
        rebuttalList = priorRebuttals;
      }
    } finally {
      await closeDebaterSessions(openHandles, sessionManager);
    }
  }

  // ── Path C: one-shot (default) → sessionManager.runInSession ─────────────────
  else {
    const settled = await allSettledBounded(
      resolved.map(({ debater, agentName }, index) => async () => {
        const modelDef = resolveDebaterModelDef(debater);
        const sessionName = sessionManager.nameFor({
          workdir: opts.workdir,
          featureName: opts.feature,
          storyId: ctx.storyId,
          role: `debate-plan-${index}`,
        });
        const prompt = buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection);
        await sessionManager.runInSession(sessionName, prompt, {
          agentName,
          role: `debate-plan-${index}`,
          workdir: opts.workdir,
          pipelineStage: pipelineStageForDebate(ctx.stage),
          modelDef,
          timeoutSeconds: opts.timeoutSeconds ?? 600,
          featureName: opts.feature,
          storyId: ctx.storyId,
          signal: ctx.abortSignal,
        });
        const output = await _debateSessionDeps.readFile(outputPaths[index]);
        return { debater, agentName, output, cost: 0, resolvedIndex: index };
      }),
      concurrencyLimit,
    );

    for (let i = 0; i < settled.length; i++) {
      const res = settled[i];
      if (res.status === "fulfilled") {
        successful.push(res.value);
        totalCostUsd += res.value.cost;
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
      reviewerSession: ctx.reviewerSession,
      resolverContextInput: ctx.resolverContextInput,
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
