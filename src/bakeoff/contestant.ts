/**
 * Bake-off Contestant Runner
 *
 * Runs a single pinned agent through the nax pipeline inside an isolated
 * worktree, aggregating the result into a `ContestantResult`. The worktree
 * is always torn down, even when the pipeline throws or signals abort.
 */

import type { NaxConfig } from "../config";
import type { ContestantResult } from "./types";

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
  /** Forwarded from BakeoffOptions.feature; not read inside runContestant
   * itself but is part of the tested cross-call contract (US-004 AC-27). */
  feature?: string;
  storiesTotal?: number;
}

export interface ContestantRunnerDeps {
  worktreeManager: {
    create: (projectRoot: string, storyId: string) => Promise<unknown>;
    remove: (projectRoot: string, storyId: string) => Promise<unknown>;
  };
  /** Pipeline receives the pinned config as its first positional argument. */
  pipeline: (config: NaxConfig) => Promise<ContestantPipelineResult>;
}

/** Production wiring installs these via init steps; tests override per-call. */
export const _contestantDeps: ContestantRunnerDeps = {
  worktreeManager: undefined as unknown as ContestantRunnerDeps["worktreeManager"],
  pipeline: undefined as unknown as ContestantRunnerDeps["pipeline"],
};

function safeStoryId(agent: string): string {
  return `bakeoff-contestant-${agent}`;
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
  deps: ContestantRunnerDeps = _contestantDeps,
): Promise<ContestantResult> {
  const storyId = safeStoryId(agent);

  const pinnedConfig: NaxConfig = {
    ...options.config,
    agent: {
      ...(options.config.agent ?? {}),
      default: agent,
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

  await deps.worktreeManager.create(options.projectRoot, storyId);

  try {
    const result = await deps.pipeline(pinnedConfig);

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
