/**
 * Bake-off Pre-flight
 *
 * CLI parsing and validation for the bake-off (`nax run --compare`) flow.
 * Rejects invalid contestants before any spend occurs.
 */

import { KNOWN_AGENT_NAMES } from "../agents";
import { ACP_ADAPTER_NAMES } from "../agents/acp/adapter";
import { NaxError } from "../errors";
import { which as defaultWhich } from "../utils/bun-deps";

export type ContestantValidationReason = "unknown-agent" | "no-acp-adapter" | "dnf-not-installed";

export interface ContestantValidationError {
  agent: string;
  reason: ContestantValidationReason;
}

export interface PreflightDeps {
  which: (name: string) => string | null;
  hasAcpAdapterEntry: (name: string) => boolean;
}

/** Injectable dependencies. Tests override individual entries. */
export const _preflightDeps: PreflightDeps = {
  which: defaultWhich,
  hasAcpAdapterEntry: (name: string) => ACP_ADAPTER_NAMES.has(name),
};

/**
 * Parse a `--compare` flag value into a clean list of contestant names.
 * Trims whitespace, drops empty entries, returns the order as given.
 */
export function parseCompareList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validate that every requested contestant is a known, runnable agent.
 * Returns a list of validation errors (empty when all contestants are valid).
 */
export function validateContestants(names: string[]): ContestantValidationError[] {
  const errors: ContestantValidationError[] = [];
  for (const agent of names) {
    if (!KNOWN_AGENT_NAMES.includes(agent)) {
      errors.push({ agent, reason: "unknown-agent" });
      continue;
    }
    if (!_preflightDeps.hasAcpAdapterEntry(agent)) {
      errors.push({ agent, reason: "no-acp-adapter" });
      continue;
    }
    if (!_preflightDeps.which(agent)) {
      errors.push({ agent, reason: "dnf-not-installed" });
    }
  }
  return errors;
}

/**
 * Reject the `--compare` + `--agent` combination — they are mutually exclusive.
 * Throws NaxError with a stable code identifying the conflict.
 */
export function assertCompareAgentExclusive(opts: { compare?: string; agent?: string }): void {
  if (opts.compare && opts.agent) {
    throw new NaxError(
      `--compare and --agent are mutually exclusive (got --compare=${opts.compare} --agent=${opts.agent})`,
      "BAKEOFF_COMPARE_AGENT_EXCLUSIVE",
      { compare: opts.compare, agent: opts.agent },
    );
  }
}

/**
 * Compute the worst-case cost ceiling: contestantCount × maxCostPerContestant.
 * Used by the bake-off confirmation prompt to show the maximum possible spend.
 */
export function computeWorstCaseCost(contestantCount: number, maxCostPerContestant: number): number {
  return contestantCount * maxCostPerContestant;
}
