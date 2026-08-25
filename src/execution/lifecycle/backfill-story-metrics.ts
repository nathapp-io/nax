/**
 * Back-fill synthesis for stories that have aggregator cost but no execution-phase
 * StoryMetrics entry.
 *
 * A story only gets a real metric from the completion pipeline stage
 * (`collectStoryMetrics` / `collectBatchMetrics`), which runs on the SUCCESS path.
 * A story that FAILS in the execution stage makes the pipeline stop at its
 * `finalAction` (fail/escalate/pause) before the completion stage — so it has cost
 * in the aggregator but no metric. Without distinguishing it, such a story fell into
 * the "completion-phase-only spend" back-fill and was stamped `attempts: 0`,
 * `modelUsed: <agentName>`, `durationMs: 0`, `source: "completion-phase"` — corrupt
 * analytics for a story that genuinely ran (issue #1296).
 *
 * This module is the single source of truth for that synthesis. It emits:
 *  - `execution-failed` — the story ran and failed in the execution stage; synthesize
 *    from the story's own routing / attempts / escalations so the values are real.
 *  - `completion-phase` — cost incurred only after execution (acceptance / hardening /
 *    diagnosis); the placeholder shape, unchanged.
 */
import { resolveModelForAgent } from "@/config";
import type { NaxConfig } from "@/config";
import type { AgentFallbackHop, StoryMetrics } from "@/metrics";
import type { UserStory } from "@/prd/types";

export interface BackfillMetricArgs {
  storyId: string;
  /** The story from the PRD, if found. */
  story: UserStory | undefined;
  /** Aggregator cost for this story (already known to be > 0 by the caller). */
  totalCostUsd: number;
  config: NaxConfig;
  /** Resolved default agent, used only for the completion-phase placeholder. */
  defaultAgent: string;
  /** Timestamp for startedAt/completedAt (execution timing is not persisted on the story). */
  timestamp: string;
  /**
   * Agent-swap hops recorded for this story during execution (nax#1709). A failed story
   * never reaches collectStoryMetrics, so without these the run-level swap-cost aggregate
   * omits exactly the spend it exists to measure, and `exhaustedStories` — which requires
   * `!success` — can never be populated at all. Ignored for completion-phase-only spend,
   * where no execution happened.
   */
  fallbackHops?: readonly AgentFallbackHop[];
  /** Runtime-crash retries tallied for this story during execution (nax#1709). */
  runtimeCrashes?: number;
}

/** True when the story ran and terminated as a failure in the execution stage. */
function isExecutionFailure(story: UserStory | undefined): boolean {
  return (
    story != null && (story.status === "failed" || story.status === "regression-failed") && (story.attempts ?? 0) > 0
  );
}

/**
 * Synthesize a StoryMetrics entry for a story with cost but no execution-phase metric.
 * Pure over its inputs — exported for unit testing.
 */
export function synthesizeBackfillMetric(args: BackfillMetricArgs): StoryMetrics {
  const { storyId, story, totalCostUsd, config, defaultAgent, timestamp, fallbackHops, runtimeCrashes } = args;

  if (story != null && isExecutionFailure(story)) {
    const tier = story.routing?.modelTier ?? "balanced";
    const agent = story.routing?.agent ?? defaultAgent;
    let modelUsed = agent;
    try {
      modelUsed = resolveModelForAgent(config.models, agent, tier, defaultAgent).model;
    } catch {
      /* tier not configured for this agent — fall back to the agent name */
    }
    const escalations = story.escalations ?? [];
    const finalTier = escalations.length > 0 ? escalations[escalations.length - 1].toTier : tier;
    // Mirror buildStoryMetrics: cross-tier failures live in priorFailures, current-tier in attempts.
    const attempts = (story.priorFailures?.length ?? 0) + Math.max(1, story.attempts ?? 1);
    return {
      storyId,
      complexity: story.routing?.complexity ?? "medium",
      initialComplexity: story.routing?.initialComplexity ?? story.routing?.complexity,
      modelTier: tier,
      modelUsed,
      agentUsed: agent,
      attempts,
      finalTier,
      success: false,
      cost: totalCostUsd,
      durationMs: 0, // per-story execution duration is not persisted on the story
      firstPassSuccess: false,
      startedAt: timestamp,
      completedAt: timestamp,
      source: "execution-failed",
      runtimeCrashes: runtimeCrashes ?? 0,
      ...(fallbackHops && fallbackHops.length > 0 ? { fallback: { hops: [...fallbackHops] } } : {}),
    };
  }

  // Completion-phase-only spend (acceptance refinement / hardening / diagnosis).
  return {
    storyId,
    complexity: story?.routing?.complexity ?? "medium",
    modelTier: "balanced",
    modelUsed: defaultAgent,
    attempts: 0,
    finalTier: "balanced",
    success: story?.passes ?? true,
    cost: totalCostUsd,
    durationMs: 0,
    firstPassSuccess: story?.passes ?? true,
    startedAt: timestamp,
    completedAt: timestamp,
    source: "completion-phase",
    runtimeCrashes: 0,
  };
}
