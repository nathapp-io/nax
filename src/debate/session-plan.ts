/**
 * session-plan.ts
 *
 * Extracted runPlan() implementation for DebateSession.
 */

import { join } from "node:path";
import type { IAgentManager } from "../agents";
import type { NaxConfig } from "../config";
import type { ModelDef } from "../config";
import { DebatePromptBuilder } from "../prompts";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
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
import { type HybridCtx, runRebuttalLoop } from "./session-hybrid";
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";

interface PlanCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly agentManager?: IAgentManager;
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
    dangerouslySkipPermissions?: boolean;
    maxInteractionTurns?: number;
    /** Original spec content — anchors synthesis to prevent AC hallucination. */
    specContent?: string;
  },
): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, "plan", config.autoPersona ?? false);
  // Mutable: plan debater costs accumulated below; hybrid rebuttal loop adds cost via adapter.run().
  let totalCostUsd = 0;

  const agentManager: IAgentManager = ctx.agentManager ?? _debateSessionDeps.createManager(ctx.config);

  // Resolve agents — skip unavailable
  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((r) => r.debater.agent),
  });

  // Run plan() bounded parallel
  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext, outputFormat, stage: "plan" },
    { debaters: resolved.map((r) => r.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
  );
  const settled = await allSettledBounded(
    resolved.map(({ debater: rd, agentName }, i) => async () => {
      const tempOutputPath = join(opts.outputDir, `prd-debate-${i}.json`);
      const debaterPrompt = `${proposalBuilder.buildProposalPrompt(i)}\n\nWrite the PRD JSON directly to this file path: ${tempOutputPath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`;

      const modelTier = modelTierFromDebater(rd);
      const modelDef: ModelDef = resolveModelDefForDebater(rd, modelTier, ctx.config);

      const planResult = await agentManager.planAs(agentName, {
        prompt: debaterPrompt,
        workdir: opts.workdir,
        interactive: false,
        timeoutSeconds: opts.timeoutSeconds,
        config: ctx.config,
        modelTier,
        modelDef,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        maxInteractionTurns: opts.maxInteractionTurns,
        featureName: opts.feature,
        storyId: ctx.storyId,
        sessionRole: `plan-${i}`,
      });

      const output = await _debateSessionDeps.readFile(tempOutputPath);
      return { debater: rd, agentName, output, cost: planResult.costUsd ?? 0 };
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

  // Single success — use directly (no resolver needed)
  if (successful.length === 1) {
    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "only 1 plan debater succeeded — using as solo",
    });
    logger?.info("debate", "debate:result", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: "passed",
    });
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

  // Multiple proposals — run hybrid rebuttal loop if configured, then resolve
  const proposalOutputs = successful.map((p) => p.output);

  // Hybrid rebuttal loop — delegates to session-hybrid.ts (SSOT)
  const mode = ctx.stageConfig.mode ?? "panel";
  const sessionMode = ctx.stageConfig.sessionMode ?? "one-shot";
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
    };
    const rebuttalBuilder = new DebatePromptBuilder(
      { taskContext, outputFormat: "", stage: "plan" },
      { debaters: successful.map((p) => p.debater), sessionMode },
    );
    const { rebuttals, costUsd } = await runRebuttalLoop(hybridCtx, successful, rebuttalBuilder, "plan-hybrid");
    critiqueOutputs = rebuttals.map((r) => r.output);
    rebuttalList = rebuttals;
    totalCostUsd += costUsd;
  } else if (mode === "hybrid") {
    logger?.warn("debate", "hybrid mode requires sessionMode: stateful for plan — running as panel");
  }

  // Pass the full outer session timeout so the resolver gets the same budget
  // as the debate session itself. Using 0 bypassed the outer timeout entirely,
  // causing the inner acpx call to use a 120s default and get killed.
  const resolverTimeoutMs = (ctx.stageConfig.timeoutSeconds ?? 600) * 1000;
  const specAnchor = opts.specContent
    ? `\n\n## Original Spec\n\n${opts.specContent}\n\n## Synthesis Rules — Acceptance Criteria\n\nThe spec above is the authoritative source for acceptance criteria.\n- Each story's \`acceptanceCriteria\` array MUST contain only criteria that are explicitly stated or directly implied by the spec.\n- If a debater proposed criteria beyond the spec (observable edge cases, error-path behaviors), place those in a separate \`suggestedCriteria\` array on the same story object. Each element of \`suggestedCriteria\` MUST be a plain string — never an object or structured value.\n- \`suggestedCriteria\` MUST contain only behavioral acceptance criteria — observable outputs, return values, state changes, or error conditions a test can assert. DO NOT include: implementation details (imports, internal structure), design suggestions ("consider X"), "not required" notes, or any criterion that cannot be expressed as a test assertion.\n- Never silently merge debater-invented criteria into \`acceptanceCriteria\`. The distinction matters: \`acceptanceCriteria\` drives automated testing; \`suggestedCriteria\` gates a hardening pass.\n- Preserve the spec's AC wording. You may refine for clarity but must not change semantics.\n- Preserve each story's \`routing\` object unchanged — especially \`routing.complexity\` and \`routing.testStrategy\`. These are required by the schema and must not be dropped or modified during synthesis.`
    : "";
  const planSynthesisSuffix = `IMPORTANT: Your response must be a single valid JSON object in PRD format (with project, feature, branchName, userStories array, etc.). Do NOT wrap it in markdown fences. Output raw JSON only.${specAnchor}`;
  const outcome: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    critiqueOutputs,
    ctx.stageConfig,
    ctx.config,
    ctx.storyId,
    resolverTimeoutMs,
    opts.workdir,
    opts.feature,
    /* reviewerSession */ undefined,
    /* resolverContext */ undefined,
    planSynthesisSuffix,
    successful.map((p) => p.debater),
    agentManager,
  );

  // Winning output: synthesis/custom resolver returns a combined PRD — use it when available.
  // For majority resolver, outcome.output is undefined; fall back to first proposal.
  const winningOutput = outcome.output ?? successful[0].output;

  const proposals = successful.map((p) => ({ debater: p.debater, output: p.output }));

  logger?.info("debate", "debate:result", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome,
  });
  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: outcome.outcome,
    rounds: rebuttalList ? config.rounds : 1,
    debaters: successful.map((p) => p.debater.agent),
    resolverType: config.resolver.type,
    proposals,
    rebuttals: rebuttalList,
    output: winningOutput,
    totalCostUsd,
  };
}
