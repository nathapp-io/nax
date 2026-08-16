/**
 * Bake-off Coordinator
 *
 * Orchestrates sequential contestant runs, ranks them via `rankContestants`,
 * persists the result, and returns the final `BakeoffResult`. Sequential
 * execution guarantees a crash in one contestant never blocks later contestants.
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { WorktreeManager } from "../worktree/manager";
import { runContestant } from "./contestant";
import type { ContestantOptions, ContestantRunnerDeps } from "./contestant";
import { pipeline } from "./pipeline-adapter";
import { buildContestantConfig, parseCompareList, validateContestants } from "./preflight";
import type { ContestantValidationResult } from "./preflight";
import { rankContestants } from "./ranking";
import type { BakeoffResult, ContestantResult } from "./types";

export interface BakeoffOptions {
  agents: string[];
  feature: string;
  projectRoot: string;
  outputDir: string;
  config: NaxConfig;
  /** Per-contestant cost ceiling. Forwarded to runContestant. */
  maxCostUsd?: number;
}

/** Injectable dependencies for the coordinator. Tests override individual entries. */
export interface BakeoffCoordinatorDeps {
  validateContestants: (names: string[], projectRoot: string) => Promise<ContestantValidationResult>;
  runContestant: (agent: string, options: ContestantOptions) => Promise<ContestantResult>;
  rankContestants: typeof rankContestants;
  persistBakeoffResult: (result: BakeoffResult, outputDir: string) => Promise<void>;
}

/** Default `persistBakeoffResult` dep: writes bakeoff.json under outputDir. */
export async function persistBakeoffResult(result: BakeoffResult, outputDir: string): Promise<void> {
  const filePath = join(outputDir, "bakeoff", result.feature, "bakeoff.json");
  await Bun.write(filePath, JSON.stringify(result, null, 2));
}

/**
 * Default `ContestantRunnerDeps` for production wiring: a real worktree
 * manager and the real pipeline adapter (`src/bakeoff/pipeline-adapter.ts`).
 */
const _defaultContestantDeps: ContestantRunnerDeps = {
  worktreeManager: new WorktreeManager(),
  pipeline,
};

export const _coordinatorDeps: BakeoffCoordinatorDeps = {
  validateContestants,
  runContestant: (agent, options) => runContestant(agent, options, _defaultContestantDeps),
  rankContestants,
  persistBakeoffResult,
};

/**
 * Statuses that count as a "finisher" — the contestant produced a
 * comparable result. Everything else (cost-limit, timeout, dnf-crashed,
 * dnf-not-installed, or any other non-terminal status) is a non-finisher;
 * an allow-list here is safer than a DNF deny-list since an unrecognized
 * status fails closed rather than silently counting as a finisher.
 */
const FINISHER_STATUSES: ReadonlySet<ContestantResult["status"]> = new Set(["passed", "failed"]);

/**
 * Run a bake-off: validate contestants, run them sequentially, rank the
 * results, persist `bakeoff.json`, and return the final `BakeoffResult`.
 */
export async function runBakeoff(
  options: BakeoffOptions,
  deps: Partial<BakeoffCoordinatorDeps> = {},
): Promise<BakeoffResult> {
  const merged: BakeoffCoordinatorDeps = { ..._coordinatorDeps, ...deps };

  const { validAgents, errors, profileData } = await merged.validateContestants(options.agents, options.projectRoot);

  const results: ContestantResult[] = [];
  for (const agent of validAgents) {
    const contestantOptions: ContestantOptions = {
      projectRoot: options.projectRoot,
      config: buildContestantConfig(options.config, profileData[agent] ?? {}),
      maxCostUsd: options.maxCostUsd,
      feature: options.feature,
      outputDir: options.outputDir,
    };
    const result = await merged.runContestant(agent, contestantOptions);
    results.push(result);
  }

  const ranking = merged.rankContestants(results);

  const hasFinisher = ranking.some((r) => FINISHER_STATUSES.has(r.status));
  const outcome = hasFinisher ? 0 : 1;

  const completedAt = new Date().toISOString();

  // Only name a winner when ranking[0] actually finished — an all-DNF
  // outcome must not report a crashed/timed-out contestant as the winner.
  const topResult = ranking[0];
  const hasWinner = topResult !== undefined && FINISHER_STATUSES.has(topResult.status);

  const bakeoffResult: BakeoffResult = {
    feature: options.feature,
    completedAt,
    outcome,
    ranking,
    contestants: results,
    ...(hasWinner ? { winner: topResult } : {}),
    ...(errors.length > 0 ? { validationErrors: errors } : {}),
  };

  await merged.persistBakeoffResult(bakeoffResult, options.outputDir);

  return bakeoffResult;
}

// ── CLI wiring ──────────────────────────────────────────────────────────────

/**
 * Arguments accepted by the bake-off CLI dispatch. Mirrors the slice of
 * `bin/nax.ts` run-action options that matter for the bake-off routing decision.
 */
export interface HandleRunActionOptions {
  /** `--compare` flag value (e.g. "claude,codex"); absent ⇒ single-agent path. */
  compare?: string;
  feature: string;
  projectRoot: string;
  outputDir: string;
  config: NaxConfig;
  /** Optional pre-parsed contestant list — overrides `compare` when provided. */
  agents?: string[];
  /** Per-contestant cost ceiling. Forwarded to runBakeoff. */
  maxCostUsd?: number;
}

/**
 * Injectable dependencies for `handleRunAction`. Tests override these to
 * observe the dispatch decision without invoking real agents.
 */
export interface BakeoffCliDeps {
  runBakeoff: (options: BakeoffOptions) => Promise<BakeoffResult>;
  runSingleAgent: (options: unknown) => Promise<unknown>;
  handleRunAction: (options: HandleRunActionOptions) => Promise<unknown>;
}

export const _bakeoffCliDeps: BakeoffCliDeps = {
  runBakeoff,
  runSingleAgent: async (_options: unknown) => {
    throw new Error("not implemented"); // nax-lint-allow: plain-error
  },
  // Default delegates to the standalone function defined below.
  handleRunAction: (options: HandleRunActionOptions) => handleRunAction(options, _bakeoffCliDeps),
};

/**
 * Route a `nax run` invocation to either the bake-off or the single-agent
 * path based on the presence of `--compare`. Returns the dispatch result.
 */
export async function handleRunAction(
  options: HandleRunActionOptions,
  deps: BakeoffCliDeps = _bakeoffCliDeps,
): Promise<unknown> {
  const compareList = options.compare ? parseCompareList(options.compare) : [];
  if (compareList.length === 0) {
    return deps.runSingleAgent(options);
  }

  const agents = options.agents ?? compareList;
  return deps.runBakeoff({
    agents,
    feature: options.feature,
    projectRoot: options.projectRoot,
    outputDir: options.outputDir,
    config: options.config,
    maxCostUsd: options.maxCostUsd,
  });
}

// Re-exports for downstream wiring that already imports these names.
export type { ContestantOptions, ContestantResult };
