/**
 * Bake-off Pre-flight
 *
 * CLI parsing and validation for the bake-off (`nax run --compare`) flow.
 * Rejects invalid contestants before any spend occurs.
 */

import { KNOWN_AGENT_NAMES } from "../agents";
import { ACP_ADAPTER_NAMES, AcpAgentAdapter } from "../agents/acp";
import { NaxError } from "../errors";
import { which as defaultWhich } from "../utils/bun-deps";

export type ContestantValidationReason = "unknown-agent" | "no-acp-adapter" | "dnf-not-installed";

export interface ContestantValidationError {
  agent: string;
  reason: ContestantValidationReason;
}

export interface ContestantValidationResult {
  errors: ContestantValidationError[];
  validAgents: string[];
}

export interface PreflightDeps {
  /** Takes the agent *name* — resolves to the real launch binary internally. */
  isInstalled: (agentName: string) => boolean;
  hasAcpAdapterEntry: (name: string) => boolean;
}

/**
 * Per-call deps shape. `hasAcpAdapterEntry` is optional because the
 * test surface and the lean acceptance surface only require `isInstalled`.
 * When omitted, the default ACP adapter registry is consulted.
 */
export interface PreflightCallableDeps {
  isInstalled: (agentName: string) => boolean;
  hasAcpAdapterEntry?: (name: string) => boolean;
}

/**
 * Injectable dependencies. Tests override individual entries.
 *
 * `isInstalled` resolves the agent's real launch binary via the same
 * `AcpAgentAdapter` registry entry the rest of the codebase uses (see
 * `AcpAgentAdapter.isInstalled()` in `src/agents/acp/adapter.ts`), rather
 * than assuming the agent name and its PATH binary are the same string.
 */
export const _preflightDeps: PreflightDeps = {
  isInstalled: (agentName: string) => defaultWhich(new AcpAgentAdapter(agentName).binary) !== null,
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
 * Returns both the validation errors and the subset of contestants that
 * passed pre-flight. `deps` is optional; when omitted, falls back to the
 * module-level `_preflightDeps`.
 */
export function validateContestants(
  names: string[],
  deps: PreflightCallableDeps = _preflightDeps,
): ContestantValidationResult {
  const errors: ContestantValidationError[] = [];
  const validAgents: string[] = [];

  const hasAdapter = deps.hasAcpAdapterEntry ?? _preflightDeps.hasAcpAdapterEntry;

  for (const agent of names) {
    if (!KNOWN_AGENT_NAMES.includes(agent)) {
      errors.push({ agent, reason: "unknown-agent" });
      continue;
    }
    if (!hasAdapter(agent)) {
      errors.push({ agent, reason: "no-acp-adapter" });
      continue;
    }
    if (!deps.isInstalled(agent)) {
      errors.push({ agent, reason: "dnf-not-installed" });
      continue;
    }
    validAgents.push(agent);
  }

  return { errors, validAgents };
}

/**
 * Reject the `--compare` + `--agent` combination — they are mutually exclusive.
 * Throws NaxError with a stable code identifying the conflict.
 */
export function assertCompareAgentExclusive(opts: { compare?: string; agent?: string }): void {
  if (opts.compare && opts.agent) {
    throw new NaxError(
      `--compare and --agent are mutually exclusive (got --compare=${opts.compare} --agent=${opts.agent})`,
      "COMPARE_AGENT_EXCLUSIVE",
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
