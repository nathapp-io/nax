/**
 * Bake-off Coordinator
 *
 * Orchestrates sequential contestant runs, ranks them via `rankContestants`,
 * persists the result, and returns the final `BakeoffResult`. Sequential
 * execution guarantees a crash in one contestant never blocks later contestants.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { runContestant } from "./contestant";
import type { ContestantOptions } from "./contestant";
import { validateContestants } from "./preflight";
import type { ContestantValidationError } from "./preflight";
import { rankContestants } from "./ranking";
import type { BakeoffResult, ContestantResult } from "./types";

export interface BakeoffOptions {
  agents: string[];
  feature: string;
  projectRoot: string;
  outputDir: string;
  config: NaxConfig;
  /** Stable story id used for the contestant worktree naming. */
  storyId?: string;
  /** Per-contestant cost ceiling. Forwarded to runContestant. */
  maxCostUsd?: number;
}

export interface BakeoffPreflightResult {
  errors: ContestantValidationError[];
  validAgents: string[];
}

/** Injectable dependencies for the coordinator. Tests override individual entries. */
export interface BakeoffCoordinatorDeps {
  validateContestants: (names: string[]) => BakeoffPreflightResult;
  runContestant: (agent: string, options: ContestantOptions) => Promise<ContestantResult>;
  rankContestants: typeof rankContestants;
  persistBakeoffResult: (result: BakeoffResult, outputDir: string) => Promise<void>;
}

/** Default `validateContestants` dep: wraps the real preflight into the {errors, validAgents} shape. */
function defaultValidateContestants(names: string[]): BakeoffPreflightResult {
  const errors = validateContestants(names);
  const invalidAgents = new Set(errors.map((e) => e.agent));
  const validAgents = names.filter((n) => !invalidAgents.has(n));
  return { errors, validAgents };
}

/** Default `persistBakeoffResult` dep: writes bakeoff.json under outputDir. */
export async function persistBakeoffResult(result: BakeoffResult, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, "bakeoff.json");
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
}

export const _coordinatorDeps: BakeoffCoordinatorDeps = {
  validateContestants: defaultValidateContestants,
  runContestant,
  rankContestants,
  persistBakeoffResult,
};

/** DNF statuses that signal a contestant failed to produce a comparable result. */
const DNF_STATUSES: ReadonlySet<ContestantResult["status"]> = new Set(["dnf-crashed", "dnf-timeout", "dnf-killed"]);

/**
 * Run a bake-off: validate contestants, run them sequentially, rank the
 * results, persist `bakeoff.json`, and return the final `BakeoffResult`.
 */
export async function runBakeoff(
  options: BakeoffOptions,
  deps: Partial<BakeoffCoordinatorDeps> = {},
): Promise<BakeoffResult> {
  const merged: BakeoffCoordinatorDeps = { ..._coordinatorDeps, ...deps };

  const { validAgents } = merged.validateContestants(options.agents);

  const results: ContestantResult[] = [];
  for (const agent of validAgents) {
    const contestantOptions: ContestantOptions = {
      name: agent,
      projectRoot: options.projectRoot,
      storyId: options.storyId ?? `bakeoff-${options.feature}-${agent}`,
      config: options.config,
      maxCostUsd: options.maxCostUsd,
      feature: options.feature,
    };
    const result = await merged.runContestant(agent, contestantOptions);
    results.push(result);
  }

  const ranking = merged.rankContestants(results);

  const hasFinisher = ranking.some((r) => !DNF_STATUSES.has(r.status));
  const outcome = hasFinisher ? 0 : 1;

  const completedAt = new Date().toISOString();

  const bakeoffResult: BakeoffResult = {
    feature: options.feature,
    completedAt,
    outcome,
    ranking,
    contestants: results,
    ...(ranking[0] ? { winner: ranking[0] } : {}),
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
  });
}

function parseCompareList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Re-exports for downstream wiring that already imports these names.
export { _contestantDeps } from "./contestant";
export type { ContestantOptions, ContestantResult };
