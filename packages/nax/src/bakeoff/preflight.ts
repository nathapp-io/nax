/**
 * Bake-off Pre-flight
 *
 * CLI parsing and validation for the bake-off (`nax run --compare`) flow.
 * Rejects invalid contestants before any spend occurs.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { acpAdapterFor } from "../agents";
import { ACP_SDK_AGENT_NAMES } from "../agents/acp-sdk";
import { type AcpTransport, DEFAULT_ACP_TRANSPORT, deepMergeConfig, type NaxConfig } from "../config";
import { loadProfile } from "../config/profile";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { gitWithTimeout } from "../utils/git";

const BAKEOFF_BRANCH_PREFIX = "nax/bakeoff-";

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
  /** Resolved profile overlay data, keyed by contestant name — one entry per `validAgents` member. */
  profileData: Record<string, Record<string, unknown>>;
}

export interface PreflightDeps {
  /** Takes the agent *name* and the contestant's ACP transport; asks that transport's adapter (S4b-2). */
  isInstalled: (agentName: string, transport: AcpTransport) => boolean | Promise<boolean>;
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
  isInstalled: (agentName: string, transport: AcpTransport) => boolean | Promise<boolean>;
  hasAcpAdapterEntry?: (name: string) => boolean;
  loadProfile?: (profileName: string, projectRoot: string) => Promise<Record<string, unknown>>;
}

/**
 * Injectable dependencies. Tests override individual entries.
 *
 * `isInstalled` asks the registry's adapter for that transport (see
 * `acpAdapterFor` in `src/agents/registry.ts`), rather than assuming the agent
 * name and its PATH binary are the same string.
 */
export const _preflightDeps: PreflightDeps = {
  isInstalled: (agentName: string, transport: AcpTransport) => acpAdapterFor(agentName, transport).isInstalled(),
  hasAcpAdapterEntry: (name: string) => ACP_SDK_AGENT_NAMES.has(name),
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

/** A contestant's ACP transport: its profile's `agent.acp.transport`, else the run's (D2-o). */
function contestantTransport(profileData: Record<string, unknown>, base: AcpTransport): AcpTransport {
  const agent = profileData.agent as { acp?: { transport?: unknown } } | undefined;
  const transport = agent?.acp?.transport;
  return transport === "acpx" || transport === "sdk" ? transport : base;
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
  baseTransport: AcpTransport = DEFAULT_ACP_TRANSPORT,
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
  const profileData: Record<string, Record<string, unknown>> = {};

  for (const name of names) {
    let resolvedProfileData: Record<string, unknown>;
    try {
      resolvedProfileData = await loadProfileFn(name, projectRoot);
    } catch (err) {
      // Only a genuine "this profile name does not resolve" failure is
      // reported as a per-contestant validation error. Anything else
      // (malformed profile JSON, permission errors, unexpected I/O
      // failures) is an operational/configuration defect, not a missing
      // profile — swallowing it here would misreport it and hide the
      // real cause, so it propagates instead.
      if (err instanceof NaxError && (err.code === "PROFILE_NOT_FOUND" || err.code === "PROFILE_NAME_INVALID")) {
        errors.push({
          agent: name,
          reason: "unknown-profile",
          message: `Profile "${name}" could not be resolved: ${errorMessage(err)}`,
        });
        continue;
      }
      throw err;
    }

    const agentConfig = resolvedProfileData.agent as { default?: unknown } | undefined;
    const resolvedAgent = typeof agentConfig?.default === "string" ? agentConfig.default : undefined;

    if (!resolvedAgent || !hasAcpAdapterEntry(resolvedAgent)) {
      errors.push({
        agent: name,
        reason: "no-acp-adapter",
        message: `Profile "${name}" resolves to agent "${resolvedAgent}", which has no ACP adapter entry`,
      });
      continue;
    }

    if (!(await deps.isInstalled(resolvedAgent, contestantTransport(resolvedProfileData, baseTransport)))) {
      errors.push({
        agent: name,
        reason: "dnf-not-installed",
        message: `Profile "${name}" resolves to agent "${resolvedAgent}", whose binary is not installed on PATH`,
      });
      continue;
    }

    validAgents.push(name);
    profileData[name] = resolvedProfileData;
  }

  return { errors, validAgents, profileData };
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

/**
 * Removes leftover `nax/bakeoff-<id>` branches that have no live worktree
 * record, freeing the reserved namespace for a fresh bake-off run
 * (US-004 AC-6, AC-7). Branches outside the `nax/bakeoff-` namespace are
 * never touched.
 *
 * Best-effort: called unconditionally as part of bake-off preflight, so any
 * failure (e.g. projectRoot isn't a git repo) is logged and swallowed rather
 * than aborting the run — a missed reclaim only risks a later worktree-create
 * collision, which `WorktreeManager.create` already tolerates for its own
 * orphans.
 */
export async function reclaimStaleBakeoffBranches(projectRoot: string): Promise<void> {
  try {
    const branchesResult = await gitWithTimeout(
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BAKEOFF_BRANCH_PREFIX}*`],
      projectRoot,
    );
    if (branchesResult.exitCode !== 0) return;

    const branches = branchesResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(BAKEOFF_BRANCH_PREFIX));
    if (branches.length === 0) return;

    const worktreeListResult = await gitWithTimeout(["worktree", "list", "--porcelain"], projectRoot);
    // A failed/timed-out `worktree list` must not be read as "no branches
    // have worktree records" — that would force-delete live branches. Bail
    // out and leave every bakeoff- branch alone until the next preflight run.
    if (worktreeListResult.exitCode !== 0) return;

    const recordedBranches = new Set(
      worktreeListResult.stdout
        .split("\n")
        .filter((line) => line.startsWith("branch "))
        .map((line) => line.slice("branch ".length).trim()),
    );

    for (const branch of branches) {
      if (recordedBranches.has(`refs/heads/${branch}`)) continue;

      // ENH-3 fix: capture the tip SHA before deleting, so a mistaken
      // delete is recoverable (`git checkout <sha>` / `git branch <name>
      // <sha>`). The previous implementation force-deleted with no
      // breadcrumb, silently losing unmerged work in the shared
      // `nax/bakeoff-*` namespace (docs/20260816-review-since-0.80.0-canary.3.md).
      // Best-effort: a failed rev-parse (concurrent delete, unparseable
      // ref) still lets the deletion proceed — the SHA log is
      // observability, not a gate.
      let sha: string | undefined;
      try {
        const shaResult = await gitWithTimeout(["rev-parse", branch], projectRoot);
        if (shaResult.exitCode === 0) {
          const trimmed = shaResult.stdout.trim();
          if (trimmed) sha = trimmed;
        }
      } catch {
        // swallow — deletion proceeds without the SHA breadcrumb
      }

      getSafeLogger()?.warn("bakeoff", "Reclaiming stale bake-off branch", {
        projectRoot,
        branch,
        ...(sha ? { sha } : {}),
        recoverable: sha ? `git checkout ${sha}  # or: git branch ${branch} ${sha}` : "(no SHA captured)",
      });

      const deleteResult = await gitWithTimeout(["branch", "-D", branch], projectRoot);
      if (deleteResult.exitCode !== 0) {
        getSafeLogger()?.warn("bakeoff", "Failed to delete stale bake-off branch", {
          projectRoot,
          branch,
          stderr: deleteResult.stderr,
        });
      }
    }
  } catch (error) {
    getSafeLogger()?.warn("bakeoff", "Failed to reclaim stale bake-off branches", {
      projectRoot,
      error: errorMessage(error),
    });
  }
}
