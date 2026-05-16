import { join } from "node:path";
import type { DebateConfig } from "../config/selectors";
import * as callModule from "../operations/call";
import { type DebatePlanInput, planDebaterOp } from "../operations/debate-plan";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import { resolvePersonas } from "./personas";
import {
  _runPlanDeps,
  buildFinalizedProposals,
  buildPlanProposalPrompt,
  buildPlanRebuttalPrompt,
  buildPlanSynthesisSuffix,
  finalizePlanSelection,
  readWinnerOutput,
  rewriteComplexitiesToExpert,
  runPrePhase,
} from "./runner-plan-helpers";
import {
  buildResolverContext,
  createDebaterCallContext,
  createOneShotDebaterCallContext,
  createProposalBarrier,
  rejectUnresolvedBarriers,
  resolveStatefulSignal,
  runStatefulBounded,
} from "./runner-stateful-helpers";
import { type ScoredProposal, computeScore, extractManifestFromContext } from "./selectors/verifier-pick";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Proposal } from "./types";
import type { PostDebateVerifierContext } from "./verifiers";

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
  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
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
    debaters: resolved.map((entry) => entry.debater.agent),
  });

  const concurrencyLimit = ctx.config?.debate?.maxConcurrentDebaters ?? DEFAULT_MAX_CONCURRENT_DEBATERS;
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext, outputFormat, stage: "plan" },
    {
      debaters: resolved.map((entry) => entry.debater),
      sessionMode: ctx.stageConfig.sessionMode ?? "one-shot",
      proposers: ctx.stageConfig.proposers,
    },
  );
  const rebuttalBuilder = new DebatePromptBuilder(
    { taskContext, outputFormat, stage: "plan" },
    { debaters: resolved.map((entry) => entry.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
  );
  const barrierStates = resolved.map(() => createProposalBarrier());
  const rebuttalStates = resolved.map(() => createProposalBarrier());
  const selectionSignals = resolved.map(() => Promise.withResolvers<{ readonly patchPrompt?: string }>());
  const outputPaths = resolved.map((_, index) => join(opts.outputDir, `prd-debate-${index}.json`));
  const coordinatorCtx = {
    storyId: ctx.storyId,
    stage: ctx.stage,
    workdir: opts.workdir,
    featureName: opts.feature,
    callContext: ctx.callContext,
    abortSignal: ctx.abortSignal,
    ...(ctx.resolverContextInput ? { resolverContextInput: ctx.resolverContextInput } : {}),
  };
  const signal = resolveStatefulSignal(coordinatorCtx);
  const failureError = new Error(`[debate] Plan debate aborted for story ${ctx.storyId}`);
  const debaterCosts = new Array<number>(resolved.length).fill(0);
  const useStatefulSessions = config.sessionMode === "stateful";
  const includeHybridRebuttals = useStatefulSessions && config.mode === "hybrid";

  if (config.mode === "hybrid" && !useStatefulSessions) {
    logger?.warn("debate", "hybrid mode requires stateful sessions — falling back to panel (no rebuttal)", {
      storyId: ctx.storyId,
      stage: ctx.stage,
    });
  }

  const planSettledPromise = runStatefulBounded(
    resolved.map(({ debater, agentName }, index) => () => {
      const baseDebaterCallCtx: CallContext = useStatefulSessions
        ? {
            ...createDebaterCallContext(coordinatorCtx, agentName),
            sessionOverride: { role: `debate-plan-${index}` as import("../session/types").SessionRole },
          }
        : {
            ...createOneShotDebaterCallContext(coordinatorCtx, agentName),
            sessionOverride: { role: `debate-plan-${index}` as import("../session/types").SessionRole },
          };
      const debaterCallCtx: CallContext = {
        ...baseDebaterCallCtx,
        onCostAccumulated: (costUsd) => {
          debaterCosts[index] += costUsd;
        },
      };
      return callModule
        .callOp(debaterCallCtx, planDebaterOp, {
          debater,
          index,
          proposePrompt: buildPlanProposalPrompt(proposalBuilder, index, outputPaths[index], manifestSection),
          buildRebutPrompt: (peerProposals) =>
            buildPlanRebuttalPrompt(
              rebuttalBuilder,
              index,
              outputPaths[index],
              peerProposals.map((output, peerIndex) => ({
                debater: resolved[peerIndex]?.debater ?? debater,
                output,
              })),
            ),
          proposalBarriers: barrierStates.map((state) => state.barrier),
          rebuttalBarrier: rebuttalStates[index].barrier,
          selectionSignal: selectionSignals[index].promise,
          signal,
          storyId: ctx.storyId,
          outputPath: outputPaths[index],
          includeHybridRebuttals,
        } satisfies DebatePlanInput)
        .then(
          (result) => {
            if (result.success) {
              if (!barrierStates[index].isSettled()) {
                barrierStates[index].barrier.resolve(result.rebut);
              }
              if (!rebuttalStates[index].isSettled()) {
                rebuttalStates[index].barrier.resolve(result.rebut);
              }
            }
            if (!result.success && !rebuttalStates[index].isSettled()) {
              rejectUnresolvedBarriers(barrierStates, failureError);
              rejectUnresolvedBarriers(rebuttalStates, failureError);
            }
            return result;
          },
          (error) => {
            rejectUnresolvedBarriers(barrierStates, failureError);
            rejectUnresolvedBarriers(rebuttalStates, failureError);
            throw error;
          },
        );
    }),
    barrierStates,
    concurrencyLimit,
  );

  const rebuttalSettled = await Promise.allSettled(rebuttalStates.map((state) => state.barrier.promise));
  const rebuttalOutputs = rebuttalSettled.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [{ debater: resolved[index].debater, agentName: resolved[index].agentName, output: result.value }]
      : [],
  );

  for (const result of rebuttalOutputs) {
    logger?.info("debate", "debate:proposal", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      agent: result.debater.agent,
    });
  }

  if (rebuttalOutputs.length === 0) {
    for (const selection of selectionSignals) selection.resolve({});
    return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
  }

  if (rebuttalOutputs.length === 1) {
    for (const selection of selectionSignals) selection.resolve({});
    totalCostUsd += debaterCosts.reduce((sum, cost) => sum + cost, 0);
    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: "passed",
      rounds: 1,
      debaters: [rebuttalOutputs[0].debater.agent],
      resolverType: config.resolver.type,
      proposals: [{ debater: rebuttalOutputs[0].debater, output: rebuttalOutputs[0].output }],
      output: rebuttalOutputs[0].output,
      totalCostUsd,
    };
  }

  const selectorCtx = {
    storyId: ctx.storyId,
    stage: ctx.stage,
    stageConfig: ctx.stageConfig,
    config: ctx.config,
    proposals: rebuttalOutputs.map((proposal) => ({
      debater: proposal.debater,
      agentName: proposal.agentName,
      output: proposal.output,
      cost: 0,
    })),
    critiques: [],
    workdir: opts.workdir,
    featureName: opts.feature,
    timeoutMs: (ctx.stageConfig.timeoutSeconds ?? 600) * 1000,
    agentManager,
    debaters: rebuttalOutputs.map((proposal) => proposal.debater),
    callContext: ctx.callContext,
    ...(ctx.reviewerSession ? { reviewerSession: ctx.reviewerSession } : {}),
    ...(ctx.resolverContextInput ? { resolverContextInput: ctx.resolverContextInput } : {}),
  } satisfies Parameters<typeof extractManifestFromContext>[0];
  const manifest = extractManifestFromContext(selectorCtx);
  const scored: ScoredProposal[] = await Promise.all(
    selectorCtx.proposals.map(async (proposal) => ({ proposal, score: await computeScore(proposal, manifest) })),
  );
  scored.sort((a, b) => b.score.total - a.score.total);

  const patchConfig = ctx.stageConfig.selector?.kind === "verifier-pick" ? ctx.stageConfig.selector.patch : undefined;
  const selectionSummary = await finalizePlanSelection(
    scored,
    patchConfig,
    selectionSignals,
    outputPaths,
    selectorCtx.proposals,
    selectorCtx,
  );
  const planSettled = await planSettledPromise;
  totalCostUsd += debaterCosts.reduce((sum, cost) => sum + cost, 0);

  const firstRejected = planSettled.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (firstRejected) {
    throw firstRejected.reason as Error;
  }

  const finalizedProposals = buildFinalizedProposals(resolved, planSettled, rebuttalSettled);

  const proposalOutputs = finalizedProposals.map((proposal) => proposal.output);
  const critiques = rebuttalOutputs.map((proposal) => proposal.output);
  const resolverTimeoutMs = (ctx.stageConfig.timeoutSeconds ?? 600) * 1000;
  const selectorKind = ctx.stageConfig.selector?.kind;
  const outcome: ResolveOutcome =
    selectorKind === "verifier-pick"
      ? {
          outcome: "passed",
          resolverCostUsd: 0,
          output: selectionSummary.winnerOutput ?? finalizedProposals[0]?.output,
        }
      : await resolveOutcome(
          proposalOutputs,
          critiques,
          ctx.stageConfig,
          ctx.config,
          ctx.callContext,
          ctx.storyId,
          resolverTimeoutMs,
          opts.workdir,
          opts.feature,
          ctx.reviewerSession,
          buildResolverContext(
            finalizedProposals.map((proposal) => ({
              debater: proposal.debater,
              agentName: proposal.agentName,
              output: proposal.output,
              cost: 0,
            })),
            ctx.resolverContextInput,
          ),
          buildPlanSynthesisSuffix(opts.specContent),
          finalizedProposals.map((proposal) => proposal.debater),
          agentManager,
        );

  let finalOutcome = outcome.outcome;
  let winningOutput: string | undefined = outcome.output ?? finalizedProposals[0]?.output;

  winningOutput = await readWinnerOutput(selectionSummary.winnerOutputPath ?? outputPaths[0], winningOutput);

  if (config.postDebateVerifier && winningOutput) {
    const verifierCtx: PostDebateVerifierContext = {
      storyId: ctx.storyId,
      stage: ctx.stage,
      stageConfig: config,
      selectorResult: { outcome: outcome.outcome, output: winningOutput, resolverCostUsd: outcome.resolverCostUsd },
      workdir: opts.workdir,
      ctx: ctx as unknown as import("../operations/types").CallContext,
    };
    const verifierResult = await _runPlanDeps.resolvePostDebateVerifier(config.postDebateVerifier.kind)(verifierCtx);
    totalCostUsd += verifierResult.costUsd;
    finalOutcome = verifierResult.outcome;

    const isTagExpert =
      config.postDebateVerifier.onBlocker === "tag-expert" &&
      (verifierResult.findings as Array<{ severity: string }> | undefined)?.some(
        (finding) => finding.severity === "blocker",
      ) === true;
    if (isTagExpert) {
      winningOutput = rewriteComplexitiesToExpert(winningOutput);
      finalOutcome = "passed";
    }
  }

  const proposals: Proposal[] = finalizedProposals.map((proposal) => ({
    debater: proposal.debater,
    output: proposal.output,
  }));

  logger?.info("debate", "debate:result", { storyId: ctx.storyId, stage: ctx.stage, outcome: finalOutcome });
  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: finalOutcome,
    rounds: 1,
    debaters: finalizedProposals.map((proposal) => proposal.debater.agent),
    resolverType: config.resolver.type,
    proposals,
    output: winningOutput,
    totalCostUsd,
    ...(includeHybridRebuttals
      ? {
          rebuttals: rebuttalOutputs.map((proposal) => ({
            debater: proposal.debater,
            round: 1,
            output: proposal.output,
          })),
        }
      : {}),
  };
}
