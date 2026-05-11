/**
 * Verifier-pick selector strategy.
 *
 * Ranks proposals by mechanical signals (citations, distribution, coverage, context validity)
 * and optionally applies a patch step if enabled and AC overlap is below threshold.
 */

import { getSafeLogger } from "@/logger";
import { PatchPromptBuilder } from "@/prompts";
import { citationDistribution, citationRate, extractClaims } from "../citations";
import type { FactsManifest } from "../facts-manifest";
import type { SuccessfulProposal } from "../session-helpers";
import type { Selector, SelectorContext, SelectorResult } from "./types";

// Score weight constants — documented linear combination of mechanical signals (no LLM)
export const SCORE_WEIGHTS = {
  citationRate: 0.4,
  citationDistributionScore: 0.3,
  failureModesCovered: 0.15,
  contextFilesValidRate: 0.15,
} as const;

/** Max failure-mode count used to normalize failureModesCovered to [0, 1]. */
const MAX_FAILURE_MODES = 5;

/** Regex patterns for detecting negative-path ACs in proposal output. */
const NEGATIVE_PATH_PATTERNS = [
  /\bAC\s*\d+\s*(?:fail|error|invalid|missing|reject)/gi,
  /error\s+(?:case|path|handling|scenario)/gi,
  /should\s+(?:fail|return\s+error|reject|throw)/gi,
  /when\s+(?:\w+\s+)?(?:is\s+)?(?:missing|invalid|empty|null|undefined)/gi,
  /handles?\s+(?:the\s+)?(?:error|failure|exception)/gi,
];

/** Regex to extract file paths mentioned in proposal output. */
const FILE_PATH_RE = /(?:^|\s)((?:\/|\.\/|\.\.\/)[\w./\-]+\.\w+)/gm;

/** Regex to extract AC identifiers (e.g. AC1, AC 2) from proposal output. */
const AC_ID_RE = /\bAC\s*(\d+)\b/gi;

interface Score {
  citationRate: number;
  citationDistributionScore: number;
  failureModesCovered: number;
  contextFilesValidRate: number;
  total: number;
}

interface ScoredProposal {
  proposal: SuccessfulProposal;
  score: Score;
}

interface PatchResult {
  output: string;
  cost: number;
}

/**
 * Returns an empty manifest as placeholder. The manifest is threaded by the
 * runner-plan orchestrator in US-005 — for US-003, scoring uses output-only signals.
 */
function extractManifestFromContext(_ctx: SelectorContext): FactsManifest {
  return { repoFacts: [], specClaims: [], gaps: [] };
}

async function computeScore(proposal: SuccessfulProposal, manifest: FactsManifest): Promise<Score> {
  const claims = extractClaims(proposal.output);
  const cr = citationRate(claims);

  const dist = citationDistribution(claims, manifest);
  const totalCited = dist.verifiedFacts + dist.specSpans;
  const cds = claims.length > 0 ? totalCited / claims.length : 0;

  let fmc = 0;
  for (const re of NEGATIVE_PATH_PATTERNS) {
    const matches = proposal.output.match(re);
    fmc += matches?.length ?? 0;
  }

  const pathMatches = [...proposal.output.matchAll(FILE_PATH_RE)];
  const paths = pathMatches.map((m) => m[1]);
  let cflr = 1.0;
  if (paths.length > 0) {
    const existChecks = await Promise.all(paths.map((p) => Bun.file(p as string).exists()));
    const existingCount = existChecks.filter(Boolean).length;
    cflr = existingCount / paths.length;
  }

  const total =
    SCORE_WEIGHTS.citationRate * cr +
    SCORE_WEIGHTS.citationDistributionScore * cds +
    SCORE_WEIGHTS.failureModesCovered * Math.min(fmc / MAX_FAILURE_MODES, 1) +
    SCORE_WEIGHTS.contextFilesValidRate * cflr;

  return {
    citationRate: cr,
    citationDistributionScore: cds,
    failureModesCovered: fmc,
    contextFilesValidRate: cflr,
    total,
  };
}

function extractAcIds(output: string): Set<string> {
  const matches = [...output.matchAll(AC_ID_RE)];
  return new Set(matches.map((m) => `AC${m[1]}`));
}

function acOverlap(winner: ScoredProposal, runnerUp: ScoredProposal): number {
  const winnerAcs = extractAcIds(winner.proposal.output);
  const runnerUpAcs = extractAcIds(runnerUp.proposal.output);
  if (winnerAcs.size === 0 && runnerUpAcs.size === 0) return 1.0;
  const intersection = [...winnerAcs].filter((ac) => runnerUpAcs.has(ac));
  const union = new Set([...winnerAcs, ...runnerUpAcs]);
  return intersection.length / union.size;
}

function extractDistinctACs(winner: SuccessfulProposal, runnerUp: SuccessfulProposal, maxDeltas: number): string[] {
  const winnerAcs = extractAcIds(winner.output);
  const runnerUpAcs = extractAcIds(runnerUp.output);
  const distinct = [...runnerUpAcs].filter((ac) => !winnerAcs.has(ac));
  return distinct.slice(0, maxDeltas);
}

export async function runPatchStep(
  ctx: SelectorContext,
  winner: ScoredProposal,
  runnerUp: ScoredProposal,
  maxDeltas: number,
): Promise<PatchResult> {
  const deltas = extractDistinctACs(winner.proposal, runnerUp.proposal, maxDeltas);
  const prompt = new PatchPromptBuilder().build(winner.proposal.output, deltas);
  const handle = winner.proposal.handle;
  if (!handle) {
    throw new Error("[verifier-pick] Winner proposal has no session handle — cannot continue session for patch step");
  }
  const result = await ctx.agentManager.runAsSession(winner.proposal.agentName, handle, prompt, {
    storyId: ctx.storyId,
    pipelineStage: "plan",
  });
  return { output: result.output, cost: result.estimatedCostUsd ?? 0 };
}

export const verifierPickSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  if (ctx.proposals.length === 0) {
    return { outcome: "failed", resolverCostUsd: 0 };
  }

  const manifest = extractManifestFromContext(ctx);
  const scored: ScoredProposal[] = await Promise.all(
    ctx.proposals.map(async (p) => ({ proposal: p, score: await computeScore(p, manifest) })),
  );
  scored.sort((a, b) => b.score.total - a.score.total);

  const winner = scored[0];
  const patchConfig = ctx.stageConfig.selector?.kind === "verifier-pick" ? ctx.stageConfig.selector.patch : undefined;

  if (patchConfig?.enabled) {
    const runnerUp = scored[1];
    if (runnerUp && acOverlap(winner, runnerUp) < (patchConfig.overlapThreshold ?? 0.8)) {
      try {
        const patched = await runPatchStep(ctx, winner, runnerUp, patchConfig.maxDeltas ?? 5);
        return { outcome: "passed", output: patched.output, resolverCostUsd: patched.cost };
      } catch (err) {
        const logger = getSafeLogger();
        if ((patchConfig.onFailure ?? "use-unpatched") === "block") {
          return { outcome: "failed", resolverCostUsd: 0 };
        }
        logger?.warn("verifier-pick", "Patch step failed — falling back to unpatched winner", {
          storyId: ctx.storyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { outcome: "passed", output: winner.proposal.output, resolverCostUsd: 0 };
};
