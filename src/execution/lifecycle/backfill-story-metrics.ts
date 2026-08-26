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

import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { NaxConfig } from "@/config";
import { resolveModelForAgent } from "@/config";
import type { AgentFallbackHop, StoryMetrics } from "@/metrics";
import { toFallbackHops } from "@/metrics";
import type { UserStory } from "@/prd/types";

export interface BackfillMetricArgs {
  storyId: string;
  /** The story from the PRD, if found. */
  story: UserStory | undefined;
  /**
   * Aggregator cost for this story. May be `0`: nax#1714 — a story can fail having
   * spent nothing (a fallback chain whose candidates all fail auth instantly), and
   * its hops and crash retries are still worth recording. Nothing below branches on
   * this being positive.
   */
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

/**
 * True when the story ran and terminated as a failure in the execution stage.
 *
 * nax#1714: this used to also require `attempts > 0`, which excluded a story that
 * died at session creation — it carries a failed status with no attempt recorded, and
 * so fell to the completion-phase placeholder that drops its hops and crash retries.
 * The requirement was redundant anyway: the branch it guards floors attempts at
 * `Math.max(1, ...)`.
 *
 * Exported because nax#1721's back-fill domain must admit stories using the same
 * definition this function branches on — a story the loop admits but this rejects
 * would get the very placeholder it was admitted to avoid.
 */
export function isExecutionFailure(story: UserStory | undefined): boolean {
  return story != null && (story.status === "failed" || story.status === "regression-failed");
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

/**
 * Which stories the back-fill should consider, and in what order.
 *
 * nax#1721: the loop used to iterate the cost aggregator's keys alone, so a story
 * with no key was never visited. Two classes were invisible — a story that failed
 * having spent nothing, and a sibling of a failed batch, whose spend is filed under
 * the batch's LEAD (one session, one `ctx.storyId`) and which therefore has no key
 * of its own.
 *
 * Aggregator keys come first so the pre-existing emission order is preserved; the
 * other sources only append ids that order did not already cover.
 */
export function backfillDomain(input: {
  aggregatorKeys: Iterable<string>;
  fallbackKeys: Iterable<string>;
  crashKeys: Iterable<string>;
  stories: readonly UserStory[];
}): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  for (const id of input.aggregatorKeys) add(id);
  for (const id of input.fallbackKeys) add(id);
  for (const id of input.crashKeys) add(id);
  for (const story of input.stories) if (isExecutionFailure(story)) add(story.id);
  return ordered;
}

/**
 * Whether a story in the domain has any evidence worth a metric.
 *
 * Preserves the original guard's purpose — do not synthesize a row for a story that
 * genuinely did nothing — without using cost as the proxy for it. A swap hop and a
 * crash retry are both evidence of something that can cost nothing, and a story that
 * terminated as an execution failure ran whether or not it left any of the three.
 * A `pending` story a cost limit stopped the run before reaching matches none.
 */
export function hasBackfillEvidence(input: {
  costUsd: number;
  hopCount: number;
  crashCount: number;
  story: UserStory | undefined;
}): boolean {
  return input.costUsd > 0 || input.hopCount > 0 || input.crashCount > 0 || isExecutionFailure(input.story);
}

/**
 * Apply the back-fill to `allStoryMetrics`, in place.
 *
 * For each story in the domain with evidence: synthesize a metric when it has no
 * entry yet, or raise an existing entry's cost to the aggregator's value, which is
 * authoritative across all phases.
 *
 * Lives here rather than inline in run-completion.ts so the domain rule, the evidence
 * rule and the synthesis stay in one reviewable place (and run-completion.ts is close
 * to its file-size limit).
 */
export function applyBackfill(input: {
  allStoryMetrics: StoryMetrics[];
  aggByStory: Record<string, { totalCostUsd: number }>;
  stories: readonly UserStory[];
  agentFallbacks: ReadonlyMap<string, AgentFallbackRecord[]>;
  runtimeCrashRetries: ReadonlyMap<string, number>;
  config: NaxConfig;
  defaultAgent: string;
}): void {
  const { allStoryMetrics, aggByStory, stories, agentFallbacks, runtimeCrashRetries, config, defaultAgent } = input;
  const existingIndex = new Map(allStoryMetrics.map((m, i) => [m.storyId, i]));
  // Indexed once: the widened domain can span every story, so a linear find per id
  // would be quadratic in PRD size.
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const timestamp = new Date().toISOString();

  const domain = backfillDomain({
    aggregatorKeys: Object.keys(aggByStory),
    fallbackKeys: agentFallbacks.keys(),
    crashKeys: runtimeCrashRetries.keys(),
    stories,
  });

  for (const storyId of domain) {
    const totalCostUsd = aggByStory[storyId]?.totalCostUsd ?? 0;
    // nax#1709: the run-scoped stores outlive the per-attempt PipelineContext, so a
    // story that failed in the execution stage still has its swap hops and crash
    // retries here even though it never reached collectStoryMetrics.
    const fallbackHops = toFallbackHops(agentFallbacks.get(storyId), storyId);
    const runtimeCrashes = runtimeCrashRetries.get(storyId) ?? 0;
    const story = storyById.get(storyId);
    const hopCount = fallbackHops.length;
    if (!hasBackfillEvidence({ costUsd: totalCostUsd, hopCount, crashCount: runtimeCrashes, story })) continue;

    const existingIdx = existingIndex.get(storyId);
    if (existingIdx === undefined) {
      // A story with evidence but no execution-phase metric either failed in the
      // execution stage (the pipeline stopped before the completion stage) or spent
      // only in completion phases. synthesizeBackfillMetric distinguishes the two so a
      // failed story gets its real attempts/model/tier instead of the corrupt
      // attempts:0 / modelUsed=<agentName> placeholder (issue #1296).
      allStoryMetrics.push(
        synthesizeBackfillMetric({
          storyId,
          story,
          totalCostUsd,
          config,
          defaultAgent,
          timestamp,
          fallbackHops,
          runtimeCrashes,
        }),
      );
      continue;
    }
    const existing = allStoryMetrics[existingIdx];
    if (totalCostUsd > (existing.cost ?? 0)) {
      allStoryMetrics[existingIdx] = { ...existing, cost: totalCostUsd };
    }
  }
}
