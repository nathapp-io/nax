/**
 * Bake-off Contestant Runner
 *
 * Runs a single pinned agent through the nax pipeline inside an isolated
 * worktree, aggregating the result into a `ContestantResult`. The worktree
 * is always torn down, even when the pipeline throws or signals abort.
 */

import { basename, join } from "node:path";
import type { NaxConfig } from "../config";
import { projectOutputDir } from "../runtime/paths";
import type { ContestantResult } from "./types";
import { deriveBakeoffWorktreeId } from "./worktree-id";

export interface ContestantStoryResult {
  status: "passed" | "failed";
}

export interface ContestantStoryMetric {
  cost: number;
  durationMs: number;
  attempts: number;
}

export interface ContestantPipelineResult {
  results: ContestantStoryResult[];
  metrics: ContestantStoryMetric[];
  costLimitReached?: boolean;
  status?: ContestantResult["status"];
}

export interface ContestantOptions {
  projectRoot: string;
  config: NaxConfig;
  maxCostUsd?: number;
  /** Forwarded from BakeoffOptions.feature; also copied onto the pipeline's
   * ContestantRunContext.feature (US-002 AC-2). */
  feature?: string;
  /** The bake-off's project output root (BakeoffOptions.outputDir). Used to
   * derive this contestant's isolated ContestantRunContext.outputDir. */
  outputDir?: string;
  storiesTotal?: number;
}

/**
 * Per-contestant execution context handed to the pipeline dependency. Gives
 * each contestant an explicit, isolated worktree + output root instead of
 * only a pinned config (US-002).
 */
export interface ContestantRunContext {
  /** Profile name — also the contestant's label in the report. */
  profile: string;
  /** Base config + profile overlay, with fallback pinned off and outputDir set. */
  config: NaxConfig;
  /** This contestant's worktree — becomes the run's workdir. */
  worktree: string;
  /** This contestant's isolated output root. */
  outputDir: string;
  feature: string;
}

export interface ContestantRunnerDeps {
  worktreeManager: {
    create: (projectRoot: string, storyId: string) => Promise<unknown>;
    remove: (projectRoot: string, storyId: string) => Promise<unknown>;
  };
  /** Pipeline receives the contestant's isolated run context. */
  pipeline: (ctx: ContestantRunContext) => Promise<ContestantPipelineResult>;
}

function aggregateTotals(metrics: ContestantStoryMetric[]): {
  costUsd: number;
  wallTimeMs: number;
  tierEscalations: number;
} {
  let costUsd = 0;
  let wallTimeMs = 0;
  let tierEscalations = 0;
  for (const m of metrics) {
    costUsd += m.cost;
    wallTimeMs += m.durationMs;
    tierEscalations += m.attempts;
  }
  return { costUsd, wallTimeMs, tierEscalations };
}

/**
 * Run a single contestant: build a pinned config, create a worktree, invoke
 * the pipeline, aggregate the result, and always tear the worktree down.
 */
export async function runContestant(
  agent: string,
  options: ContestantOptions,
  deps: ContestantRunnerDeps,
): Promise<ContestantResult> {
  const feature = options.feature ?? "";
  const storyId = deriveBakeoffWorktreeId(feature, agent);

  // `agent` is the contestant's *profile* name (see ContestantRunContext.profile),
  // not necessarily its resolved agent binary — a profile like "gpu-claude" can
  // resolve to agent "claude". The real resolved `agent.default` already lives on
  // options.config (set upstream by preflight's buildContestantConfig from the
  // profile overlay), so it must be preserved here, not overwritten with the raw
  // profile name.
  const pinnedConfig: NaxConfig = {
    ...options.config,
    agent: {
      ...(options.config.agent ?? {}),
      fallback: {
        ...(options.config.agent?.fallback ?? {}),
        enabled: false,
      },
    },
    execution: {
      ...options.config.execution,
      ...(options.maxCostUsd !== undefined ? { costLimit: options.maxCostUsd } : {}),
    },
  };

  const worktree = join(options.projectRoot, ".nax-wt", storyId);
  const projectKey = options.config.name?.trim() || basename(options.projectRoot);
  const outputDir = join(projectOutputDir(projectKey, options.outputDir), "bakeoff", feature, agent);

  const context: ContestantRunContext = {
    profile: agent,
    config: { ...pinnedConfig, outputDir },
    worktree,
    outputDir,
    feature,
  };

  try {
    // BUG-03: worktreeManager.create() used to run before this try block —
    // a failure there (including the deps being unwired, e.g. undefined in
    // production before init wiring runs) threw uncaught out of
    // runContestant entirely, crashing the whole bake-off CLI invocation
    // instead of reporting this one contestant as "dnf-crashed" and letting
    // the sequential coordinator continue with the rest.
    await deps.worktreeManager.create(options.projectRoot, storyId);
    const result = await deps.pipeline(context);

    const totals = aggregateTotals(result.metrics);
    const storiesPassed = result.results.filter((r) => r.status === "passed").length;
    const storiesTotal = result.results.length > 0 ? result.results.length : (options.storiesTotal ?? 0);

    if (result.costLimitReached === true) {
      return finalize(agent, "cost-limit", storiesPassed, storiesTotal, totals);
    }
    if (result.status === "timeout") {
      return finalize(agent, "timeout", storiesPassed, storiesTotal, totals);
    }

    const status: ContestantResult["status"] = storiesTotal > 0 && storiesPassed === storiesTotal ? "passed" : "failed";
    return finalize(agent, status, storiesPassed, storiesTotal, totals);
  } catch (err) {
    return {
      agent,
      status: "dnf-crashed",
      storiesPassed: 0,
      storiesTotal: options.storiesTotal ?? 0,
      costUsd: 0,
      wallTimeMs: 0,
      tierEscalations: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await deps.worktreeManager.remove(options.projectRoot, storyId);
    } catch {
      // best-effort cleanup; do not mask the result
    }
  }
}

function finalize(
  agent: string,
  status: ContestantResult["status"],
  storiesPassed: number,
  storiesTotal: number,
  totals: { costUsd: number; wallTimeMs: number; tierEscalations: number },
): ContestantResult {
  return {
    agent,
    status,
    storiesPassed,
    storiesTotal,
    costUsd: totals.costUsd,
    wallTimeMs: totals.wallTimeMs,
    tierEscalations: totals.tierEscalations >= 0 ? totals.tierEscalations : 0,
  };
}
