/**
 * runner-plan-helpers.ts
 *
 * Internal helpers for runPlan(): pre-phase invocation and prompt shaping.
 */

import type { DebateConfig } from "../config/selectors";
import type { CallContext } from "../operations/types";
import type { DebatePromptBuilder } from "../prompts";
import type { PreDebatePhaseContext } from "./pre-phase";
import { resolvePreDebatePhase } from "./pre-phase";
import { type ScoredProposal, acOverlap, runPatchStep } from "./selectors/verifier-pick";
import { _debateSessionDeps } from "./session-helpers";
import type { DebateStageConfig } from "./types";
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
}

const FILE_OUTPUT_INSTRUCTION =
  "Write the complete PRD JSON to this file path and then reply with a short confirmation:";

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
): string {
  return appendFileOutputInstruction(builder.buildRebuttalPrompt(debaterIndex, peerProposals, []), outputPath);
}

export function buildPlanPatchPrompt(patchPrompt: string, outputPath: string): string {
  return appendFileOutputInstruction(patchPrompt, outputPath);
}

export function buildPlanSynthesisSuffix(specContent: string | undefined): string {
  const specAnchor = specContent
    ? `\n\n## Original Spec\n\n${specContent}\n\n## Synthesis Rules — Descriptions\n\nThe spec above is the authoritative source for story descriptions.\n- When the spec contains a design subsection for a story (e.g. \`### N. <Topic>\` under \`## Design\`), the story's \`description\` MUST embed that subsection's interface declarations, algorithms, and design notes verbatim — do NOT paraphrase or collapse to one sentence.\n- A one-sentence description is almost always too short for implementation stories that have spec design content. Prefer the structured format: Goal → Motivation → Interface → Approach.\n- The implementer receives only this description — no access to the original spec. Design decisions lost here are permanently invisible.\n\n## Synthesis Rules — Acceptance Criteria\n\nThe spec above is the authoritative source for acceptance criteria.\n- Each story's \`acceptanceCriteria\` array MUST contain only criteria that are explicitly stated or directly implied by the spec.\n- If a debater proposed criteria beyond the spec (observable edge cases, error-path behaviors), place those in a separate \`suggestedCriteria\` array on the same story object. Each element of \`suggestedCriteria\` MUST be a plain string — never an object or structured value.\n- \`suggestedCriteria\` MUST contain only behavioral acceptance criteria — observable outputs, return values, state changes, or error conditions a test can assert. DO NOT include: implementation details (imports, internal structure), design suggestions ("consider X"), "not required" notes, or any criterion that cannot be expressed as a test assertion.\n- Never silently merge debater-invented criteria into \`acceptanceCriteria\`. The distinction matters: \`acceptanceCriteria\` drives automated testing; \`suggestedCriteria\` gates a hardening pass.\n- Preserve the spec's AC wording. You may refine for clarity but must not change semantics.\n- Preserve each story's \`routing\` object unchanged — especially \`routing.complexity\` and \`routing.testStrategy\`. These are required by the schema and must not be dropped or modified during synthesis.`
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
): Promise<{ winnerOutput?: string }> {
  if (scored.length === 0) {
    for (const selection of patchPrompts) selection.resolve({});
    return {};
  }

  const winner = scored[0];
  const runnerUp = scored[1];
  if (!patchConfig?.enabled || !runnerUp || acOverlap(winner, runnerUp) >= (patchConfig.overlapThreshold ?? 0.8)) {
    for (const selection of patchPrompts) selection.resolve({});
    return { winnerOutput: winner.proposal.output };
  }

  const prompt = await runPatchStep(selectorCtx, winner, runnerUp, patchConfig.maxDeltas ?? 5);
  const winnerIndex = proposalOrder.indexOf(winner.proposal);
  for (let index = 0; index < patchPrompts.length; index++) {
    patchPrompts[index].resolve(
      index === winnerIndex ? { patchPrompt: buildPlanPatchPrompt(prompt, outputPaths[index] ?? "") } : {},
    );
  }
  return { winnerOutput: winner.proposal.output };
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
