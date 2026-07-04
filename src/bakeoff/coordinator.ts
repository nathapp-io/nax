/**
 * Bake-off Coordinator
 *
 * Orchestrates sequential contestant runs, ranks them via `rankContestants`,
 * persists the result, and returns the final `BakeoffResult`. Sequential
 * execution guarantees a crash in one contestant never blocks later contestants.
 */

import type { NaxConfig } from "../config";
import { _contestantDeps, runContestant } from "./contestant";
import type { ContestantOptions } from "./contestant";
import { _preflightDeps, validateContestants } from "./preflight";
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

/** Injectable dependencies for the coordinator. Tests override individual entries. */
export interface BakeoffCoordinatorDeps {
  validateContestants: typeof validateContestants;
  runContestant: typeof runContestant;
  rankContestants: typeof rankContestants;
  persistBakeoffResult: (result: BakeoffResult, outputDir: string) => Promise<void>;
}

export const _coordinatorDeps: BakeoffCoordinatorDeps = {
  validateContestants,
  runContestant,
  rankContestants,
  persistBakeoffResult: async (_result: BakeoffResult, _outputDir: string) => {
    throw new Error("not implemented"); // nax-lint-allow: plain-error
  },
};

/**
 * Run a bake-off: validate contestants, run them sequentially, rank the
 * results, persist `bakeoff.json`, and return the final `BakeoffResult`.
 */
export async function runBakeoff(
  options: BakeoffOptions,
  deps: Partial<BakeoffCoordinatorDeps> = {},
): Promise<BakeoffResult> {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
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
}

export const _bakeoffCliDeps: BakeoffCliDeps = {
  runBakeoff,
  runSingleAgent: async (_options: unknown) => {
    throw new Error("not implemented"); // nax-lint-allow: plain-error
  },
};

/**
 * Route a `nax run` invocation to either the bake-off or the single-agent
 * path based on the presence of `--compare`. Returns the dispatch result.
 */
export async function handleRunAction(
  options: HandleRunActionOptions,
  deps: BakeoffCliDeps = _bakeoffCliDeps,
): Promise<unknown> {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
}

// Re-exports for downstream wiring that already imports these names.
export { _contestantDeps, _preflightDeps };
export type { ContestantOptions, ContestantResult };
