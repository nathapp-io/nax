/**
 * runner-plan-helpers.ts
 *
 * Internal helpers for runPlan(): pre-phase invocation, prompt shaping,
 * verifier-pick selection, and post-debate utilities.
 */

import type { IAgentManager } from "../agents";
import type { DebateConfig } from "../config/selectors";
import type { CallContext } from "../operations/types";
import type { DebatePromptBuilder } from "../prompts";
import type { PreDebatePhaseContext } from "./pre-phase";
import { resolvePreDebatePhase } from "./pre-phase";
import {
  acOverlap,
  computeScore,
  extractManifestFromContext,
  runPatchStep,
  type ScoredProposal,
} from "./selectors/verifier-pick";
import {
  _debateSessionDeps,
  type ResolvedDebater,
  type ResolveOutcome,
  resolveOutcome,
  type SuccessfulProposal,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Proposal, Rebuttal } from "./types";
import type { PostDebateVerifierContext } from "./verifiers";
import { resolvePostDebateVerifier } from "./verifiers";

/** Injectable deps for testability — defined here to avoid circular imports with runner-plan. */
export const _runPlanDeps = {
  resolvePreDebatePhase: resolvePreDebatePhase as typeof resolvePreDebatePhase,
  resolvePostDebateVerifier: resolvePostDebateVerifier as typeof resolvePostDebateVerifier,
};

interface PlanPhaseOpts {
  workdir: string;
  feature: string;
  storyId: string;
  timeoutSeconds?: number;
  specContent?: string;
}

interface PlanCtxMinimal {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly callContext: CallContext;
  readonly abortSignal?: AbortSignal;
}

/** Run the pre-debate phase, returning the manifest section and accumulated cost. */
export async function runPrePhase(
  ctx: PlanCtxMinimal,
  config: DebateStageConfig,
  opts: PlanPhaseOpts,
): Promise<{ manifestSection: string; costUsd: number; block: boolean }> {
  const logger = _debateSessionDeps.getSafeLogger();
  const prePhaseCtx: PreDebatePhaseContext = {
    ctx: ctx.callContext,
    stage: ctx.stage,
    stageConfig: config,
    workdir: opts.workdir,
    featureName: opts.feature,
    storyId: opts.storyId,
    specContent: opts.specContent,
  };
  try {
    const result = await _runPlanDeps.resolvePreDebatePhase(config.preDebatePhase?.kind ?? "")(prePhaseCtx);
    return { manifestSection: result.manifestSection, costUsd: result.costUsd, block: false };
  } catch (err) {
    const onFailure = config.preDebatePhase?.onFailure ?? "degrade";
    if (onFailure === "block") return { manifestSection: "", costUsd: 0, block: true };
    logger?.warn("debate", `pre-phase failed (degrade): ${err instanceof Error ? err.message : String(err)}`, {
      storyId: opts.storyId,
      stage: ctx.stage,
    });
    return { manifestSection: "", costUsd: 0, block: false };
  }
}

const FILE_OUTPUT_INSTRUCTION =
  "Write the complete PRD JSON to this file path and then reply with a short confirmation:";

function appendFileOutputInstruction(prompt: string, outputPath: string): string {
  return `${prompt}\n\n${FILE_OUTPUT_INSTRUCTION}\n${outputPath}`;
}

export function buildPlanProposalPrompt(
  builder: DebatePromptBuilder,
  debaterIndex: number,
  outputPath: string,
  manifestSection?: string,
): string {
  const prompt = builder.buildProposalPrompt(debaterIndex);
  const basePrompt = manifestSection ? `${manifestSection}\n\n${prompt}` : prompt;
  return appendFileOutputInstruction(basePrompt, outputPath);
}

export function buildPlanRebuttalPrompt(
  builder: DebatePromptBuilder,
  debaterIndex: number,
  outputPath: string,
  peerProposals: import("./types").Proposal[],
  priorRebuttals: import("./types").Rebuttal[] = [],
): string {
  return appendFileOutputInstruction(
    builder.buildRebuttalPrompt(debaterIndex, peerProposals, priorRebuttals),
    outputPath,
  );
}

export function buildPlanPatchPrompt(patchPrompt: string, outputPath: string): string {
  return appendFileOutputInstruction(patchPrompt, outputPath);
}

export function buildPlanSynthesisSuffix(specContent: string | undefined): string {
  const specAnchor = specContent
    ? `\n\n## Original Spec\n\n${specContent}\n\n## Synthesis Rules — Descriptions\n\nThe spec above is the authoritative source for story descriptions.\n- When the spec contains a design subsection for a story (e.g. \`### N. <Topic>\` under \`## Design\`), the story's \`description\` MUST embed that subsection's interface declarations, algorithms, and design notes verbatim — do NOT paraphrase or collapse to one sentence.\n- A one-sentence description is almost always too short for implementation stories that have spec design content. Prefer the structured format: Goal → Motivation → Interface → Approach.\n- The implementer receives only this description — no access to the original spec. Design decisions lost here are permanently invisible.\n\n## Synthesis Rules — Acceptance Criteria\n\nThe spec above is the authoritative source for acceptance criteria.\n- Each story's \`acceptanceCriteria\` array MUST contain only criteria that are explicitly stated or directly implied by the spec.\n- If a debater proposed criteria beyond the spec (observable edge cases, error-path behaviors), place those in a separate \`suggestedCriteria\` array on the same story object. Each element of \`suggestedCriteria\` MUST be a plain string — never an object or structured value.\n- \`suggestedCriteria\` MUST contain only behavioral acceptance criteria — observable outputs, return values, state changes, or error conditions a test can assert. DO NOT include: implementation details (imports, internal structure), design suggestions ("consider X"), "not required" notes, or any criterion that cannot be expressed as a test assertion.\n- Never silently merge debater-invented criteria into \`acceptanceCriteria\`. The distinction matters: \`acceptanceCriteria\` drives automated testing; \`suggestedCriteria\` gates a hardening pass.\n- Preserve the spec's AC wording, including any trailing clause that qualifies the single assertion (phrasing like \`matching\`, \`unchanged\`, \`existing\`, \`as before\`, \`already\`, or \`preserving\`, marking the AC as a regression anchor) — that clause is part of the assertion's semantics, not a second assertion, and must not be trimmed. You may refine for clarity but must not change semantics.\n- Preserve each story's \`routing\` object unchanged — especially \`routing.complexity\` and \`routing.testStrategy\`. These are required by the schema and must not be dropped or modified during synthesis.`
    : "";
  return `IMPORTANT: Your response must be a single valid JSON object in PRD format (with project, feature, branchName, userStories array, etc.). Do NOT wrap it in markdown fences. Output raw JSON only.${specAnchor}`;
}

export async function finalizePlanSelection(
  scored: ScoredProposal[],
  patchConfig: { enabled: boolean; overlapThreshold?: number; maxDeltas?: number } | undefined,
  patchPrompts: PromiseWithResolvers<{ readonly patchPrompt?: string }>[],
  outputPaths: string[],
  proposalOrder: Array<{ readonly output: string }>,
  selectorCtx: Parameters<typeof runPatchStep>[0],
): Promise<{ winnerOutput?: string; winnerOutputPath?: string }> {
  if (scored.length === 0) {
    for (const selection of patchPrompts) selection.resolve({});
    return {};
  }

  const winner = scored[0];
  const runnerUp = scored[1];
  const winnerIndex = proposalOrder.indexOf(winner.proposal);
  const winnerOutputPath = outputPaths[winnerIndex >= 0 ? winnerIndex : 0];

  if (!patchConfig?.enabled || !runnerUp || acOverlap(winner, runnerUp) >= (patchConfig.overlapThreshold ?? 0.8)) {
    for (const selection of patchPrompts) selection.resolve({});
    return { winnerOutput: winner.proposal.output, winnerOutputPath };
  }

  if (patchPrompts.length === 0) {
    return { winnerOutput: winner.proposal.output, winnerOutputPath };
  }

  const prompt = await runPatchStep(selectorCtx, winner, runnerUp, patchConfig.maxDeltas ?? 5);
  for (let index = 0; index < patchPrompts.length; index++) {
    patchPrompts[index].resolve(
      index === winnerIndex ? { patchPrompt: buildPlanPatchPrompt(prompt, outputPaths[index] ?? "") } : {},
    );
  }
  return { winnerOutput: winner.proposal.output, winnerOutputPath };
}

export async function scoreAndDispatchVerifierPick(
  resolved: ResolvedDebater[],
  rebuttalSettled: PromiseSettledResult<string>[],
  ctx: PlanCtxMinimal,
  opts: { workdir: string; feature: string },
  agentManager: IAgentManager,
  selectionResolvers: PromiseWithResolvers<{ patchPrompt?: string }>[],
  outputPaths: string[],
): Promise<void> {
  const rebutProposals = resolved.map((r, i) => {
    const rb = rebuttalSettled[i];
    return { debater: r.debater, agentName: r.agentName, output: rb?.status === "fulfilled" ? rb.value : "", cost: 0 };
  });
  const scoringCtx = {
    storyId: ctx.storyId,
    stage: ctx.stage,
    stageConfig: ctx.stageConfig,
    config: ctx.config,
    proposals: rebutProposals,
    critiques: [],
    workdir: opts.workdir,
    featureName: opts.feature,
    timeoutMs: (ctx.stageConfig.timeoutSeconds ?? 600) * 1000,
    agentManager,
    debaters: resolved.map((e) => e.debater),
    callContext: ctx.callContext,
  } satisfies Parameters<typeof extractManifestFromContext>[0];
  const manifest = extractManifestFromContext(scoringCtx);
  const scored: ScoredProposal[] = await Promise.all(
    rebutProposals.map(async (p) => ({ proposal: p, score: await computeScore(p, manifest) })),
  );
  scored.sort((a, b) => b.score.total - a.score.total);
  const patchConfig = ctx.stageConfig.selector?.kind === "verifier-pick" ? ctx.stageConfig.selector.patch : undefined;
  await finalizePlanSelection(scored, patchConfig, selectionResolvers, outputPaths, rebutProposals, scoringCtx);
}

export async function readWinnerOutput(
  winnerOutputPath: string | undefined,
  fallbackOutput: string | undefined,
): Promise<string | undefined> {
  if (fallbackOutput === undefined || !winnerOutputPath) return fallbackOutput;
  try {
    return await _debateSessionDeps.readFile(winnerOutputPath);
  } catch {
    return fallbackOutput;
  }
}

/** Rewrite every userStory.routing.complexity to "expert" in a PRD JSON string. */
export function rewriteComplexitiesToExpert(prdJson: string): string {
  try {
    const parsed = JSON.parse(prdJson);
    if (Array.isArray(parsed?.userStories)) {
      for (const story of parsed.userStories) {
        if (story.routing) story.routing.complexity = "expert";
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return prdJson;
  }
}

interface PlanFinCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly callContext: CallContext;
}

export async function finalizePlanRun(
  ctx: PlanFinCtx,
  opts: { workdir: string; feature: string; specContent?: string },
  successful: Array<SuccessfulProposal & { resolvedIndex: number }>,
  rebuttalList: Rebuttal[] | undefined,
  outputPaths: string[],
  totalCostUsd: number,
  agentManager: IAgentManager,
  selectorKind: string | undefined,
  includeHybridRebuttals: boolean,
): Promise<DebateResult> {
  const config = ctx.stageConfig;
  const logger = _debateSessionDeps.getSafeLogger();

  if (successful.length === 0) {
    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: "failed",
      rounds: 0,
      debaters: [],
      resolverType: config.resolver.type,
      proposals: [],
      totalCostUsd,
    };
  }

  if (successful.length === 1) {
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

  const finalizedProposals = successful.map((p) => ({ debater: p.debater, agentName: p.agentName, output: p.output }));
  let selectionSummary: { winnerOutput?: string; winnerOutputPath?: string } = {};

  if (selectorKind === "verifier-pick") {
    const selectorCtx = {
      storyId: ctx.storyId,
      stage: ctx.stage,
      stageConfig: ctx.stageConfig,
      config: ctx.config,
      proposals: finalizedProposals.map((p) => ({
        debater: p.debater,
        agentName: p.agentName,
        output: p.output,
        cost: 0,
      })),
      critiques: [],
      workdir: opts.workdir,
      featureName: opts.feature,
      timeoutMs: (ctx.stageConfig.timeoutSeconds ?? 600) * 1000,
      agentManager,
      debaters: finalizedProposals.map((p) => p.debater),
      callContext: ctx.callContext,
    } satisfies Parameters<typeof extractManifestFromContext>[0];
    const manifest = extractManifestFromContext(selectorCtx);
    const scored: ScoredProposal[] = await Promise.all(
      selectorCtx.proposals.map(async (proposal) => ({ proposal, score: await computeScore(proposal, manifest) })),
    );
    scored.sort((a, b) => b.score.total - a.score.total);
    const patchConfig = ctx.stageConfig.selector?.kind === "verifier-pick" ? ctx.stageConfig.selector.patch : undefined;
    selectionSummary = await finalizePlanSelection(
      scored,
      patchConfig,
      [],
      outputPaths,
      selectorCtx.proposals,
      selectorCtx,
    );
  }

  const proposalOutputs = finalizedProposals.map((p) => p.output);
  const critiqueOutputs = rebuttalList?.map((r) => r.output) ?? [];
  const resolverTimeoutMs = (ctx.stageConfig.timeoutSeconds ?? 600) * 1000;
  const outcome: ResolveOutcome =
    selectorKind === "verifier-pick"
      ? {
          outcome: "passed",
          output: selectionSummary.winnerOutput ?? finalizedProposals[0]?.output,
        }
      : await resolveOutcome(
          proposalOutputs,
          critiqueOutputs,
          ctx.stageConfig,
          ctx.config,
          ctx.callContext,
          ctx.storyId,
          resolverTimeoutMs,
          opts.workdir,
          opts.feature,
          buildPlanSynthesisSuffix(opts.specContent),
          finalizedProposals.map((p) => p.debater),
          agentManager,
        );

  let finalOutcome = outcome.outcome;
  let winningOutput: string | undefined = outcome.output ?? finalizedProposals[0]?.output;
  // Only read the winner FILE when the verifier-pick selector actually named one.
  // Falling back to outputPaths[0] here would silently swap the synthesized/merged
  // PRD (from resolveOutcome's synthesis pass, with its AC-merge/preservation rules)
  // for debater 0's raw individual file on every default (non-verifier-pick) run,
  // since that file exists in the normal flow (BUG-15).
  if (selectionSummary.winnerOutputPath) {
    winningOutput = await readWinnerOutput(selectionSummary.winnerOutputPath, winningOutput);
  }

  let runCostUsd = totalCostUsd;
  if (config.postDebateVerifier && winningOutput) {
    const verifierCtx: PostDebateVerifierContext = {
      storyId: ctx.storyId,
      stage: ctx.stage,
      stageConfig: config,
      selectorResult: { outcome: outcome.outcome, output: winningOutput },
      workdir: opts.workdir,
      ctx: ctx.callContext as unknown as import("../operations/types").CallContext,
    };
    const verifierResult = await _runPlanDeps.resolvePostDebateVerifier(config.postDebateVerifier.kind)(verifierCtx);
    runCostUsd += verifierResult.costUsd;
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

  const proposals: Proposal[] = finalizedProposals.map((p) => ({ debater: p.debater, output: p.output }));
  logger?.info("debate", "debate:result", { storyId: ctx.storyId, stage: ctx.stage, outcome: finalOutcome });
  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: finalOutcome,
    rounds: includeHybridRebuttals ? config.rounds : 1,
    debaters: finalizedProposals.map((p) => p.debater.agent),
    resolverType: config.resolver.type,
    proposals,
    output: winningOutput,
    totalCostUsd: runCostUsd,
    ...(includeHybridRebuttals ? { rebuttals: rebuttalList } : {}),
  };
}
