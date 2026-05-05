/**
 * Curator Plugin — Built-in Post-Run Action
 *
 * Collects observations from run artifacts, runs heuristics, renders proposals,
 * and appends to the cross-run rollup.
 */

import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { IPostRunAction, PluginLogger, PostRunActionResult, PostRunContext } from "../../types";
import type { NaxPlugin } from "../../types";
import { collectObservations } from "./collect";
import type { CuratorThresholds } from "./heuristics";
import { runHeuristics } from "./heuristics";
import { resolveCuratorOutputs } from "./paths";
import { renderProposals } from "./render";
import { appendToRollup } from "./rollup";
import type { CuratorPostRunContext } from "./types";

const PLUGIN_NAME = "nax-curator";
const PLUGIN_VERSION = "0.1.0";

const DEFAULT_THRESHOLDS: CuratorThresholds = {
  repeatedFinding: 2,
  emptyKeyword: 2,
  rectifyAttempts: 2,
  escalationChain: 2,
  staleChunkRuns: 2,
  unchangedOutcome: 2,
};

function getCuratorEnabled(context: PostRunContext): boolean {
  const cfg = context.config as Record<string, unknown> | undefined;
  if (!cfg) return true;
  const curator = cfg.curator as Record<string, unknown> | undefined;
  if (!curator) return true;
  if (curator.enabled === false) return false;
  return true;
}

function getReviewAuditEnabled(context: PostRunContext): boolean {
  const cfg = context.config as Record<string, unknown> | undefined;
  if (!cfg) return true;
  const review = cfg.review as Record<string, unknown> | undefined;
  if (!review) return true;
  const audit = review.audit as Record<string, unknown> | undefined;
  if (!audit) return true;
  if (audit.enabled === false) return false;
  return true;
}

function getCuratorThresholds(context: PostRunContext): CuratorThresholds {
  const cfg = context.config as Record<string, unknown> | undefined;
  const curator = cfg?.curator as Record<string, unknown> | undefined;
  const raw = curator?.thresholds as Partial<CuratorThresholds> | undefined;
  if (!raw) return DEFAULT_THRESHOLDS;
  return {
    repeatedFinding: raw.repeatedFinding ?? DEFAULT_THRESHOLDS.repeatedFinding,
    emptyKeyword: raw.emptyKeyword ?? DEFAULT_THRESHOLDS.emptyKeyword,
    rectifyAttempts: raw.rectifyAttempts ?? DEFAULT_THRESHOLDS.rectifyAttempts,
    escalationChain: raw.escalationChain ?? DEFAULT_THRESHOLDS.escalationChain,
    staleChunkRuns: raw.staleChunkRuns ?? DEFAULT_THRESHOLDS.staleChunkRuns,
    unchangedOutcome: raw.unchangedOutcome ?? DEFAULT_THRESHOLDS.unchangedOutcome,
  };
}

/**
 * Curator post-run action implementation.
 */
const curatorAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description: "Collects observations from run artifacts for curator aggregation",

  async shouldRun(context: PostRunContext): Promise<boolean> {
    if (!getCuratorEnabled(context)) return false;
    if (context.storySummary.completed < 1) return false;
    if (!getReviewAuditEnabled(context)) {
      context.logger.warn("review.audit.enabled is false — review-audit observations will be empty");
    }
    return true;
  },

  async execute(context: PostRunContext): Promise<PostRunActionResult> {
    try {
      const curatorContext = context as CuratorPostRunContext;
      const observations = await collectObservations(curatorContext);

      if (context.outputDir) {
        const { observationsPath, rollupPath } = resolveCuratorOutputs(curatorContext);
        const runDir = path.dirname(observationsPath);
        await mkdir(runDir, { recursive: true });

        // Write observations.jsonl
        await Bun.write(
          observationsPath,
          observations.map((o) => JSON.stringify(o)).join("\n") + (observations.length > 0 ? "\n" : ""),
        );

        // Run heuristics and render proposals
        const thresholds = getCuratorThresholds(context);
        const proposals = runHeuristics(observations, thresholds);
        const markdown = renderProposals(proposals, context.runId, observations.length);

        const proposalsMdPath = path.join(runDir, "curator-proposals.md");
        await Bun.write(proposalsMdPath, markdown);

        // Append to cross-run rollup
        await appendToRollup(observations, rollupPath);
      }

      return {
        success: true,
        message: `Curator collected ${observations.length} observations`,
      };
    } catch (err) {
      context.logger.warn("Curator execute failed", { error: String(err) });
      return {
        success: false,
        message: `Curator failed: ${String(err)}`,
      };
    }
  },
};

/**
 * Built-in curator plugin.
 */
export const curatorPlugin: NaxPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  provides: ["post-run-action"],

  async setup(_config: Record<string, unknown>, _logger: PluginLogger): Promise<void> {
    // No initialization required
  },

  async teardown(): Promise<void> {
    // No cleanup required
  },

  extensions: {
    postRunAction: curatorAction,
  },
};

// Re-export types for use in tests and other modules
export type {
  CuratorPostRunContext,
  Observation,
  ChunkIncludedObservation,
  ChunkExcludedObservation,
  ProviderEmptyObservation,
  ReviewFindingObservation,
  RectifyCycleObservation,
  EscalationObservation,
  AcceptanceVerdictObservation,
  PullCallObservation,
  CoChangeObservation,
  VerdictObservation,
  FixCycleIterationObservation,
  FixCycleExitObservation,
  FixCycleValidatorRetryObservation,
} from "./types";
export { collectObservations, resolveCuratorOutputs };
