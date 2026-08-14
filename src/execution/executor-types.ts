/**
 * Sequential Executor Types (ADR-005, Phase 4)
 *
 * Extracted from sequential-executor.ts to slim it below 200 lines.
 */

import { resolveDefaultAgent } from "../agents";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { RoutingResult } from "../pipeline/types";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import type { PRD, UserStory } from "../prd/types";
import { complexityToModelTier, resolveOperatingTier } from "../routing";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import type { StoryBatch } from "./batching";
import type { DeferredReviewResult } from "./deferred-review";
import type { StatusWriter } from "./status-writer";

export interface SequentialExecutionContext extends DispatchContext {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  useBatch: boolean;
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  logFilePath?: string;
  /**
   * Per-run plugin-provider cache (Finding 5 / issue #473).
   * Threaded from runner.ts into IterationRunner so the same instances are
   * reused across all assemble() calls for every story in this run.
   */
  pluginProviderCache?: import("../context/engine").PluginProviderCache;
  /** Per-run effectiveness provider-weights cache. See PipelineContext.providerWeightsCache. */
  providerWeightsCache?: import("../context/engine").ProviderWeightsCache;
  runId: string;
  startTime: number;
  batchPlan: StoryBatch[];
  interactionChain?: InteractionChain | null;
  /** Protocol-aware agent resolver (ACP wiring). Falls back to standalone getAgent when absent. */
  agentGetFn?: AgentGetFn;
  /** Max parallel sessions: undefined=sequential, 0=auto-detect, N>0=cap at N */
  parallelCount?: number;
  /** Run-scoped pre-resolved .naxignore index (refreshed when package set changes). */
  naxIgnoreIndex?: NaxIgnoreIndex;
}

/** Reason the sequential/parallel execution loop stopped. */
export type ExitReason = "completed" | "cost-limit" | "max-iterations" | "stalled" | "no-stories" | "pre-merge-aborted";

export interface SequentialExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  exitReason: ExitReason;
  deferredReview?: DeferredReviewResult;
  /** Date.now() captured immediately before postrun:phase:started for review was emitted. */
  deferredReviewStartedAt?: number;
}

/**
 * Build a preview routing from cached story.routing or config defaults.
 * The pipeline routing stage performs full classification and overwrites ctx.routing.
 * This preview is used only for logging, status display, and event emission.
 *
 * #1575: the tier goes through the same precedence the routing stage applies
 * (resolveOperatingTier), so a profile-assigned story is announced at its
 * profile's tier rather than at a stale persisted one — and the derived tier is
 * looked up from the story's OWN cached complexity, not a hardcoded band.
 * Classification itself has not run yet, so the derived tier remains an estimate.
 */
export function buildPreviewRouting(story: UserStory, config: NaxConfig): RoutingResult {
  const cached = story.routing;
  const defaultStrategy = "test-after" as const;
  const complexity = (cached?.complexity as RoutingResult["complexity"]) ?? "medium";
  // This is a display path: a partially-populated config must degrade to the
  // default band, never throw. The schema makes complexityRouting required, so
  // the guard only matters for hand-built configs.
  const derivedTier = config.autoMode?.complexityRouting ? complexityToModelTier(complexity, config) : "balanced";
  const { tier } = resolveOperatingTier({
    previousTier: cached?.modelTier,
    profileTier: cached?.profileModelTier,
    derivedTier,
    hasEscalationRecords: (story.escalations?.length ?? 0) > 0,
  });
  return {
    complexity,
    modelTier: tier as RoutingResult["modelTier"],
    testStrategy: (cached?.testStrategy as RoutingResult["testStrategy"]) ?? defaultStrategy,
    reasoning: cached ? "cached from story.routing" : "preview (pending pipeline routing stage)",
  };
}

/**
 * Agent a story will actually run as: its own assignment, else the run default.
 *
 * #1575: under cross-agent profiles the run default is not what executes a
 * profile-assigned story, so announcing it misreports every such story.
 */
export function agentFor(story: UserStory, ctx: SequentialExecutionContext): string {
  return story.routing?.agent ?? ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
}
