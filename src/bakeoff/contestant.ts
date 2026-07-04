/**
 * Bake-off Contestant Runner
 *
 * Runs a single pinned agent through the nax pipeline inside an isolated
 * worktree, aggregating the result into a `ContestantResult`. The worktree
 * is always torn down, even when the pipeline throws or signals abort.
 */

import type { NaxConfig } from "../config";
import type { StoryMetrics } from "../metrics";
import type { WorktreeManager } from "../worktree/manager";
import type { ContestantResult } from "./types";

export interface ContestantPipelineResult {
  /** Aggregated per-story metrics from the pipeline run. */
  storyMetrics: StoryMetrics[];
  /** Total number of stories executed (may differ from storyMetrics.length). */
  storiesTotal: number;
  /** Optional terminal classification the pipeline can surface without throwing. */
  outcome?: { kind: "passed" } | { kind: "failed" } | { kind: "cost-limit" } | { kind: "timeout" };
  /** Optional thrown error the pipeline caught (mapped to dnf-crashed). */
  error?: unknown;
}

export interface ContestantOptions {
  /** Stable contestant identifier surfaced as `ContestantResult.name`. */
  name: string;
  /** Project root used for worktree creation/cleanup. */
  projectRoot: string;
  /** Stable story id used for worktree path naming. */
  storyId: string;
  /** Base nax config; the runner will force agent pinning on top of it. */
  config: NaxConfig;
  /** Per-contestant cost ceiling (USD). Signaled to the pipeline, not enforced here. */
  maxCostUsd?: number;
  /** Feature name forwarded for telemetry / logging downstream. */
  feature?: string;
}

export interface ContestantRunnerDeps {
  /** Worktree manager used to create/remove the isolated worktree. */
  worktreeManager: Pick<WorktreeManager, "create" | "remove">;
  /**
   * The pipeline invocation. The runner supplies the pinned config; the deps
   * function decides how to actually drive the agent.
   */
  runPipeline: (options: ContestantOptions & { config: NaxConfig }) => Promise<ContestantPipelineResult>;
}

export const _contestantDeps: ContestantRunnerDeps = {
  worktreeManager: undefined as unknown as Pick<WorktreeManager, "create" | "remove">,
  runPipeline: undefined as unknown as ContestantRunnerDeps["runPipeline"],
};

export async function runContestant(
  agent: string,
  options: ContestantOptions,
  deps: ContestantRunnerDeps = _contestantDeps,
): Promise<ContestantResult> {
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
  };

  await deps.worktreeManager.create(options.projectRoot, options.storyId);

  try {
    const result = await deps.runPipeline({ ...options, config: pinnedConfig });

    const storiesPassed = result.storyMetrics.filter((m) => m.success).length;
    const costUsd = result.storyMetrics.reduce((sum, m) => sum + (m.cost ?? 0), 0);
    const wallTimeMs = result.storyMetrics.reduce((sum, m) => sum + (m.durationMs ?? 0), 0);
    const tierEscalations = result.storyMetrics.reduce((sum, m) => sum + (m.attempts ?? 0), 0);

    if (result.error !== undefined) {
      return {
        name: options.name,
        agent,
        status: "dnf-crashed",
        storiesPassed,
        storiesTotal: result.storiesTotal,
        costUsd,
        wallTimeMs,
        tierEscalations,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      };
    }

    let status: ContestantResult["status"];
    switch (result.outcome?.kind) {
      case "passed":
        status = "passed";
        break;
      case "cost-limit":
        status = "cost-limit";
        break;
      case "timeout":
        status = "timeout";
        break;
      default:
        status = storiesPassed === (result.storiesTotal ?? 0) && result.storiesTotal > 0 ? "passed" : "failed";
        break;
    }

    return {
      name: options.name,
      agent,
      status,
      storiesPassed,
      storiesTotal: result.storiesTotal,
      costUsd,
      wallTimeMs,
      tierEscalations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: options.name,
      agent,
      status: "dnf-crashed",
      storiesPassed: 0,
      costUsd: 0,
      wallTimeMs: 0,
      tierEscalations: 0,
      error: message,
    };
  } finally {
    try {
      await deps.worktreeManager.remove(options.projectRoot, options.storyId);
    } catch {
      // best-effort cleanup; do not mask the result
    }
  }
}
