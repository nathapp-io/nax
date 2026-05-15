/**
 * runner-plan.ts
 *
 * runPlan() implementation for DebateRunner.
 */

import { join } from "node:path";
import { resolveDefaultAgent } from "../agents";
import type { ConfiguredModel, ModelDef } from "../config";
import type { DebateConfig } from "../config/selectors";
import { NaxError } from "../errors";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../runtime/session-role";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
import type { HybridCtx } from "./runner-hybrid";
import {
  _runPlanDeps,
  closePlanSessions,
  makeStatefulProposal,
  openPlanSessions,
  rewriteComplexitiesToExpert,
  runPrePhase,
  runRebuttalLoop,
  runStatefulPlanTurn,
} from "./runner-plan-helpers";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  modelTierFromDebater,
  resolveModelDefForDebater,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";
import type { PostDebateVerifierContext } from "./verifiers";

// Re-export so existing callers (plan.ts, tests) can continue to import from this module.
export { _runPlanDeps, runRebuttalLoop } from "./runner-plan-helpers";
export type { RebuttalLoopResult } from "./runner-plan-helpers";

interface PlanCtx extends DispatchContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly callContext: CallContext;
}

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
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, "plan", config.autoPersona ?? false);
  let totalCostUsd = 0;

  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
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

  // Pre-debate phase
  let manifestSection = opts.manifestSection ?? "";
  if (config.preDebatePhase) {
    const phaseOpts = {
      workdir: opts.workdir,
      feature: opts.feature,
      storyId: ctx.storyId,
      timeoutSeconds: opts.timeoutSeconds,
      specContent: opts.specContent,
    };
    const preResult = await runPrePhase(ctx, config, phaseOpts);
    if (preResult.block) return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    manifestSection = preResult.manifestSection;
    totalCostUsd += preResult.costUsd;
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((r) => r.debater.agent),
  });

  const sessionMode = ctx.stageConfig.sessionMode ?? "one-shot";
  const isStateful = sessionMode === "stateful";
  const sessionManager = ctx.sessionManager;

  // Pre-open sessions for stateful mode
  const phaseOpts = {
    workdir: opts.workdir,
    feature: opts.feature,
    storyId: ctx.storyId,
    timeoutSeconds: opts.timeoutSeconds,
  };
  const openHandles =
    isStateful && sessionManager
      ? await openPlanSessions(resolved, ctx.config, sessionManager, phaseOpts, ctx.stage, ctx.abortSignal)
      : [];

  try {
    const concurrencyLimit = ctx.config?.debate?.maxConcurrentDebaters ?? 2;
    const proposalBuilder = new DebatePromptBuilder(
      { taskContext, outputFormat, stage: "plan" },
      { debaters: resolved.map((r) => r.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
    );
    const manifestPrefix = manifestSection ? `${manifestSection}\n\n` : "";
    const settled = await allSettledBounded(
      resolved.map(({ debater: rd, agentName }, i) => async () => {
        const tempOutputPath = join(opts.outputDir, `prd-debate-${i}.json`);
        const debaterPrompt = `${manifestPrefix}${proposalBuilder.buildProposalPrompt(i)}\n\nWrite the PRD JSON directly to this file path: ${tempOutputPath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`;

        if (isStateful) {
          const handle = openHandles[i] ?? null;
          if (!handle) {
            throw new NaxError(
              "[debate] stateful plan mode: no session handle for debater",
              "DEBATE_MISSING_SESSION_HANDLE",
              { stage: "plan", storyId: ctx.storyId, debaterIndex: i },
            );
          }
          const output = await runStatefulPlanTurn(
            agentManager,
            agentName,
            handle,
            debaterPrompt,
            tempOutputPath,
            ctx.storyId,
            ctx.stage,
          );
          return makeStatefulProposal(rd, agentName, output, handle);
        }

        if (!sessionManager) {
          throw new NaxError(
            "[debate] plan mode requires sessionManager; got undefined",
            "DEBATE_MISSING_SESSION_MANAGER",
            { stage: "plan", storyId: ctx.storyId },
          );
        }
        const modelTier = modelTierFromDebater(rd);
        const model: ConfiguredModel = { agent: rd.agent, model: rd.model ?? modelTier };
        const modelDef: ModelDef = resolveModelDefForDebater(
          rd,
          model,
          ctx.config.models,
          resolveDefaultAgent(ctx.config),
        );
        const sessionName = sessionManager.nameFor({
          workdir: opts.workdir,
          featureName: opts.feature,
          storyId: ctx.storyId,
          role: `debate-plan-${i}` as SessionRole,
        });
        await sessionManager.runInSession(sessionName, debaterPrompt, {
          agentName,
          role: `debate-plan-${i}` as SessionRole,
          workdir: opts.workdir,
          pipelineStage: "plan",
          modelDef,
          timeoutSeconds: opts.timeoutSeconds ?? 600,
          featureName: opts.feature,
          storyId: ctx.storyId,
          signal: ctx.abortSignal,
        });
        const output = await _debateSessionDeps.readFile(tempOutputPath);
        return { debater: rd, agentName, output, cost: 0 } as SuccessfulProposal;
      }),
      concurrencyLimit,
    );

    const successful: SuccessfulProposal[] = [];
    for (let i = 0; i < settled.length; i++) {
      const res = settled[i];
      if (res.status === "fulfilled") {
        successful.push(res.value);
        totalCostUsd += res.value.cost;
      } else {
        const { debater } = resolved[i];
        logger?.warn("debate", "debate:debater-failed", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          debaterIndex: i,
          agent: debater.agent,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    }

    for (let i = 0; i < successful.length; i++) {
      logger?.info("debate", "debate:proposal", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        debaterIndex: i,
        agent: successful[i].debater.agent,
      });
    }

    if (successful.length === 0) {
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "all plan debaters failed",
      });
      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }

    if (successful.length === 1) {
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "only 1 plan debater succeeded — using as solo",
      });
      logger?.info("debate", "debate:result", { storyId: ctx.storyId, stage: ctx.stage, outcome: "passed" });
      return {
        storyId: ctx.storyId,
        stage: ctx.stage,
        outcome: "passed",
        rounds: 1,
        debaters: [successful[0].debater.agent],
        resolverType: config.resolver.type,
        proposals: [{ debater: successful[0].debater, output: successful[0].output }],
        output: successful[0].output,
        totalCostUsd,
      };
    }

    const proposalOutputs = successful.map((p) => p.output);
    const mode = ctx.stageConfig.mode ?? "panel";
    let critiqueOutputs: string[] = [];
    let rebuttalList: Rebuttal[] | undefined;

    if (mode === "hybrid" && sessionMode === "stateful") {
      const hybridCtx: HybridCtx = {
        storyId: ctx.storyId,
        stage: ctx.stage,
        stageConfig: ctx.stageConfig,
        config: ctx.config,
        workdir: opts.workdir,
        featureName: opts.feature,
        timeoutSeconds: opts.timeoutSeconds ?? 600,
        callContext: ctx.callContext,
        agentManager,
        sessionManager: ctx.sessionManager,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      };
      const rebuttalBuilder = new DebatePromptBuilder(
        { taskContext, outputFormat: "", stage: "plan" },
        { debaters: successful.map((p) => p.debater), sessionMode },
      );
      const { rebuttals, costUsd } = await runRebuttalLoop(
        hybridCtx,
        successful,
        rebuttalBuilder,
        "debate-plan-hybrid",
      );
      critiqueOutputs = rebuttals.map((r) => r.output);
      rebuttalList = rebuttals;
      totalCostUsd += costUsd;
    } else if (mode === "hybrid") {
      logger?.warn("debate", "hybrid mode requires sessionMode: stateful for plan — running as panel");
    }

    const resolverTimeoutMs = (ctx.stageConfig.timeoutSeconds ?? 600) * 1000;
    const specAnchor = opts.specContent
      ? `\n\n## Original Spec\n\n${opts.specContent}\n\n## Synthesis Rules — Descriptions\n\nThe spec above is the authoritative source for story descriptions.\n- When the spec contains a design subsection for a story (e.g. \`### N. <Topic>\` under \`## Design\`), the story's \`description\` MUST embed that subsection's interface declarations, algorithms, and design notes verbatim — do NOT paraphrase or collapse to one sentence.\n- A one-sentence description is almost always too short for implementation stories that have spec design content. Prefer the structured format: Goal → Motivation → Interface → Approach.\n- The implementer receives only this description — no access to the original spec. Design decisions lost here are permanently invisible.\n\n## Synthesis Rules — Acceptance Criteria\n\nThe spec above is the authoritative source for acceptance criteria.\n- Each story's \`acceptanceCriteria\` array MUST contain only criteria that are explicitly stated or directly implied by the spec.\n- If a debater proposed criteria beyond the spec (observable edge cases, error-path behaviors), place those in a separate \`suggestedCriteria\` array on the same story object. Each element of \`suggestedCriteria\` MUST be a plain string — never an object or structured value.\n- \`suggestedCriteria\` MUST contain only behavioral acceptance criteria — observable outputs, return values, state changes, or error conditions a test can assert. DO NOT include: implementation details (imports, internal structure), design suggestions ("consider X"), "not required" notes, or any criterion that cannot be expressed as a test assertion.\n- Never silently merge debater-invented criteria into \`acceptanceCriteria\`. The distinction matters: \`acceptanceCriteria\` drives automated testing; \`suggestedCriteria\` gates a hardening pass.\n- Preserve the spec's AC wording. You may refine for clarity but must not change semantics.\n- Preserve each story's \`routing\` object unchanged — especially \`routing.complexity\` and \`routing.testStrategy\`. These are required by the schema and must not be dropped or modified during synthesis.`
      : "";
    const planSynthesisSuffix = `IMPORTANT: Your response must be a single valid JSON object in PRD format (with project, feature, branchName, userStories array, etc.). Do NOT wrap it in markdown fences. Output raw JSON only.${specAnchor}`;
    const outcome: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      ctx.stageConfig,
      ctx.config,
      ctx.callContext,
      ctx.storyId,
      resolverTimeoutMs,
      opts.workdir,
      opts.feature,
      undefined,
      undefined,
      planSynthesisSuffix,
      successful.map((p) => p.debater),
      agentManager,
    );

    // Post-debate verifier
    let finalOutcome = outcome.outcome;
    let winningOutput = outcome.output ?? successful[0].output;
    if (config.postDebateVerifier) {
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
        (verifierResult.findings as Array<{ severity: string }> | undefined)?.some((f) => f.severity === "blocker") ===
          true;
      if (isTagExpert) {
        winningOutput = rewriteComplexitiesToExpert(winningOutput);
        finalOutcome = "passed";
      }
    }

    const proposals = successful.map((p) => ({ debater: p.debater, output: p.output }));
    logger?.info("debate", "debate:result", { storyId: ctx.storyId, stage: ctx.stage, outcome: finalOutcome });
    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: finalOutcome,
      rounds: rebuttalList ? config.rounds : 1,
      debaters: successful.map((p) => p.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      rebuttals: rebuttalList,
      output: winningOutput,
      totalCostUsd,
    };
  } finally {
    if (sessionManager) {
      await closePlanSessions(openHandles, sessionManager);
    }
  }
}
