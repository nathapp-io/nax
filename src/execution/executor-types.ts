/**
 * Sequential Executor Types (ADR-005, Phase 4)
 *
 * Extracted from sequential-executor.ts to slim it below 200 lines.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { RoutingResult } from "../pipeline/types";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import type { PRD, UserStory } from "../prd/types";
import type { StoryBatch } from "./batching";
import type { DeferredReviewResult } from "./deferred-review";
import type { StatusWriter } from "./status-writer";

export interface SequentialExecutionContext {
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
  runId: string;
  startTime: number;
  batchPlan: StoryBatch[];
  interactionChain?: InteractionChain | null;
  /** Protocol-aware agent resolver (ACP wiring). Falls back to standalone getAgent when absent. */
  agentGetFn?: AgentGetFn;
}

export interface SequentialExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  exitReason: "completed" | "cost-limit" | "max-iterations" | "stalled" | "no-stories" | "pre-merge-aborted";
  deferredReview?: DeferredReviewResult;
}

/**
 * Build a preview routing from cached story.routing or config defaults.
 * The pipeline routing stage performs full classification and overwrites ctx.routing.
 * This preview is used only for logging, status display, and event emission.
 */
export function buildPreviewRouting(story: UserStory, config: NaxConfig): RoutingResult {
  const cached = story.routing;
  const defaultComplexity = "medium" as const;
  const defaultTier = "balanced" as const;
  const defaultStrategy = "test-after" as const;
  return {
    complexity: (cached?.complexity as RoutingResult["complexity"]) ?? defaultComplexity,
    modelTier:
      (cached?.modelTier as RoutingResult["modelTier"]) ??
      (config.autoMode.complexityRouting?.[defaultComplexity] as RoutingResult["modelTier"]) ??
      defaultTier,
    testStrategy: (cached?.testStrategy as RoutingResult["testStrategy"]) ?? defaultStrategy,
    reasoning: cached ? "cached from story.routing" : "preview (pending pipeline routing stage)",
  };
}
