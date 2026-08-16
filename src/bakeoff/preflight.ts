/**
 * Bake-off Pre-flight
 *
 * CLI parsing and validation for the bake-off (`nax run --compare`) flow.
 * Rejects invalid contestants before any spend occurs.
 */

import { ACP_ADAPTER_NAMES, AcpAgentAdapter } from "../agents/acp";
import type { NaxConfig } from "../config";
import { deepMergeConfig } from "../config";
import { loadProfile } from "../config/profile";
import { NaxError } from "../errors";
import { which as defaultWhich } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";

export type ContestantValidationReason = "unknown-profile" | "no-acp-adapter" | "dnf-not-installed";

export interface ContestantValidationError {
  agent: string;
  reason: ContestantValidationReason;
  /** Human-readable detail — for `unknown-profile`, names the profile that failed to resolve. */
  message?: string;
}

export interface ContestantValidationResult {
  errors: ContestantValidationError[];
  validAgents: string[];
}

export interface PreflightDeps {
  /** Takes the agent *name* — resolves to the real launch binary internally. */
  isInstalled: (agentName: string) => boolean;
  hasAcpAdapterEntry: (name: string) => boolean;
  /** Resolves a `--compare` entry (a profile name) to its raw overlay data. */
  loadProfile: (profileName: string, projectRoot: string) => Promise<Record<string, unknown>>;
}

/**
 * Per-call deps shape. `hasAcpAdapterEntry`/`loadProfile` are optional because
 * the test surface and the lean acceptance surface only require `isInstalled`.
 * When omitted, the module-level `_preflightDeps` entries are consulted.
 */
export interface PreflightCallableDeps {
  isInstalled: (agentName: string) => boolean;
  hasAcpAdapterEntry?: (name: string) => boolean;
  loadProfile?: (profileName: string, projectRoot: string) => Promise<Record<string, unknown>>;
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
  loadProfile: (profileName: string, projectRoot: string) => loadProfile(profileName, projectRoot),
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
 * Validate that every requested contestant (a profile name) resolves and
 * that its resolved agent is registered and installed. Returns both the
 * validation errors and the subset of contestant names that passed
 * pre-flight. `deps` is optional; when omitted, falls back to the
 * module-level `_preflightDeps`.
 */
export async function validateContestants(
  names: string[],
  projectRoot: string,
  deps: PreflightCallableDeps = _preflightDeps,
): Promise<ContestantValidationResult> {
  const hasAcpAdapterEntry = deps.hasAcpAdapterEntry ?? _preflightDeps.hasAcpAdapterEntry;
  const loadProfileFn = deps.loadProfile ?? _preflightDeps.loadProfile;
  if (!hasAcpAdapterEntry || !loadProfileFn) {
    throw new NaxError(
      "validateContestants requires hasAcpAdapterEntry and loadProfile deps",
      "PREFLIGHT_DEPS_MISSING",
      {
        stage: "bakeoff-preflight",
      },
    );
  }

  const errors: ContestantValidationError[] = [];
  const validAgents: string[] = [];

  for (const name of names) {
    let profileData: Record<string, unknown>;
    try {
      profileData = await loadProfileFn(name, projectRoot);
    } catch (err) {
      errors.push({
        agent: name,
        reason: "unknown-profile",
        message: `Profile "${name}" could not be resolved: ${errorMessage(err)}`,
      });
      continue;
    }

    const agentConfig = profileData.agent as { default?: unknown } | undefined;
    const resolvedAgent = typeof agentConfig?.default === "string" ? agentConfig.default : undefined;

    if (!resolvedAgent || !hasAcpAdapterEntry(resolvedAgent)) {
      errors.push({
        agent: name,
        reason: "no-acp-adapter",
        message: `Profile "${name}" resolves to agent "${resolvedAgent}", which has no ACP adapter entry`,
      });
      continue;
    }

    if (!deps.isInstalled(resolvedAgent)) {
      errors.push({
        agent: name,
        reason: "dnf-not-installed",
        message: `Profile "${name}" resolves to agent "${resolvedAgent}", whose binary is not installed on PATH`,
      });
      continue;
    }

    validAgents.push(name);
  }

  return { errors, validAgents };
}

/**
 * Deep-merge a resolved profile's overlay onto the base config for one
 * contestant, pinning `agent.fallback.enabled` off regardless of the
 * overlay (a bake-off contestant never falls back to a different agent).
 */
export function buildContestantConfig(baseConfig: NaxConfig, profileData: Record<string, unknown>): NaxConfig {
  const merged = deepMergeConfig<NaxConfig>(baseConfig as unknown as Record<string, unknown>, profileData);
  return {
    ...merged,
    agent: {
      ...merged.agent,
      fallback: {
        ...merged.agent?.fallback,
        enabled: false,
      },
    },
  };
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
