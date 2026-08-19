/**
 * Metrics Tracker
 *
 * Collects and persists per-story and per-run metrics.
 */

import path from "node:path";
import { resolveDefaultAgent } from "../agents";
import { resolveModelForAgent } from "../config/schema";
import type { PullCallRecord } from "../context/engine";
import { loadContextManifests } from "../context/engine/manifest-store";
import { computePollutionMetrics } from "../context/engine/pollution";
import { getLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import { loadJsonFile, saveJsonFile } from "../utils/json-file";
import { withPathFileLock } from "../utils/path-file-lock";
import type { ContextProviderMetrics, FloorOverageMetrics, RunMetrics, StoryMetrics } from "./types";
import { TokenUsage } from "./types";

/**
 * Maximum number of runs retained in metrics.json (GROWTH-1).
 *
 * Per-story entries carry context.providers, pullCalls, failingTestFiles, and
 * fallback.hops — tens of KB per run — so without a cap the file (and every
 * in-memory `flatMap` over it in the aggregator) grows unbounded across the
 * lifetime of a project. Oldest runs are dropped first on write; runs are
 * always appended chronologically so this keeps the most recent N.
 */
/** Exported via the `src/metrics` barrel so replay/reporting consumers can reference the cap without hardcoding it. */
export const MAX_RETAINED_RUNS = 200;

/**
 * One-shot dedupe flag (GROWTH-1): `saveRunMetrics` runs on every completed
 * run, so once a project is past `MAX_RETAINED_RUNS` this would fire a
 * warning on every single subsequent run. Log it once per process lifetime
 * instead — the condition itself is durable (it stays true forever once
 * true), so a single warning is enough to make the truncation observable
 * without spamming the log on every run thereafter.
 */
let hasWarnedAboutRunTruncation = false;

/**
 * Reset the one-shot truncation-warning flag (for testing only).
 * @internal
 */
export function _resetRunTruncationWarningForTests(): void {
  hasWarnedAboutRunTruncation = false;
}

/**
 * Collect metrics for a single story execution.
 *
 * Extracts timing, cost, model usage, and escalation data from the pipeline context.
 *
 * @param ctx - Pipeline context with execution results
 * @param storyStartTime - Story start timestamp (ISO string)
 * @returns Story metrics object
 *
 * @example
 * ```ts
 * const metrics = collectStoryMetrics(ctx, "2026-02-17T10:30:00.000Z");
 * // {
 * //   storyId: "US-001",
 * //   complexity: "medium",
 * //   modelTier: "balanced",
 * //   modelUsed: "claude-sonnet-4.5",
 * //   attempts: 1,
 * //   finalTier: "balanced",
 * //   success: true,
 * //   cost: 0.0234,
 * //   durationMs: 45000,
 * //   firstPassSuccess: true,
 * //   ...
 * // }
 * ```
 */
async function deriveContextMetrics(
  projectDir: string,
  storyId: string,
  featureId: string,
  pullCalls?: PullCallRecord[],
): Promise<StoryMetrics["context"] | undefined> {
  const stored = await loadContextManifests(projectDir, storyId, featureId);
  if (stored.length === 0) return undefined;

  const providers: Record<string, ContextProviderMetrics> = {};

  for (const { manifest } of stored) {
    if (!manifest.providerResults) continue;
    for (const pr of manifest.providerResults) {
      const existing = providers[pr.providerId];
      const kept = manifest.includedChunks.filter((id) => id.startsWith(`${pr.providerId}:`)).length;
      // Sanitize once per entry — applied uniformly to merge and init paths.
      const sanitizedPressure = sanitizeProviderPressure(pr.budgetPressure);
      if (existing) {
        existing.tokensProduced += pr.tokensProduced;
        existing.chunksProduced += pr.chunkCount;
        existing.chunksKept += kept;
        existing.wallClockMs += pr.durationMs;
        if (pr.status === "timeout") existing.timedOut = true;
        if (pr.status === "failed") existing.failed = true;
        if (pr.costUsd) existing.costUsd = (existing.costUsd ?? 0) + pr.costUsd;
        if (sanitizedPressure) {
          existing.budgetPressure = existing.budgetPressure ?? {
            overageTokens: 0,
            droppedCount: 0,
            droppedTokens: 0,
          };
          existing.budgetPressure.overageTokens += sanitizedPressure.overageTokens;
          existing.budgetPressure.droppedCount += sanitizedPressure.droppedCount;
          existing.budgetPressure.droppedTokens += sanitizedPressure.droppedTokens;
        }
      } else {
        providers[pr.providerId] = {
          tokensProduced: pr.tokensProduced,
          chunksProduced: pr.chunkCount,
          chunksKept: kept,
          wallClockMs: pr.durationMs,
          timedOut: pr.status === "timeout",
          failed: pr.status === "failed",
          ...(pr.costUsd ? { costUsd: pr.costUsd } : {}),
          ...(sanitizedPressure ? { budgetPressure: sanitizedPressure } : {}),
        };
      }
    }
  }

  if (Object.keys(providers).length === 0) return undefined;

  const pollution = computePollutionMetrics(stored);
  const hasPollution =
    pollution.droppedBelowMinScore > 0 ||
    pollution.staleChunksInjected > 0 ||
    pollution.contradictedChunks > 0 ||
    pollution.ignoredChunks > 0;

  // US-003: floor overage — see computeFloorOverage's docstring for the exact
  // computation (sum of ALL floor-item tokens minus effectiveBudget, floored at 0).
  // Only emitted here when at least one provider manifest exists (the early return
  // above); a manifest set with no providers never reaches this line.
  const floorOverage = computeFloorOverage(stored);

  return {
    providers,
    ...(hasPollution && { pollution }),
    floorOverage,
    ...(pullCalls?.length ? { pullCalls } : {}),
  };
}

/**
 * Sum per-stage floor-budget overage across the persisted stage manifests.
 *
 * For each stage manifest, the overage is
 * `max(0, sum(tokens of all floor chunks packed) - effectiveBudget)` —
 * the amount by which the floor alone pushed the bundle past the ceiling
 * that `packChunks` actually used (which may be smaller than
 * `totalBudgetTokens` due to `availableBudgetTokens`). Summing per-stage
 * overflow chunk tokens without subtracting the ceiling (the previous
 * behaviour) overstates the overage by the budget amount and compounds
 * across stages.
 *
 * Manifests without `effectiveBudget` (legacy writes predating US-003)
 * contribute 0 to the total rather than fall back to a wrong answer.
 */
function computeFloorOverage(stored: Awaited<ReturnType<typeof loadContextManifests>>): FloorOverageMetrics {
  let overageTokens = 0;
  for (const { manifest } of stored) {
    if (typeof manifest.effectiveBudget !== "number") continue;
    const floorIds = manifest.floorItems ?? [];
    if (floorIds.length === 0) continue;
    const chunkTokens = manifest.chunkTokens ?? {};
    let floorTotal = 0;
    for (const id of floorIds) {
      const tokens = chunkTokens[id];
      if (typeof tokens === "number") floorTotal += tokens;
    }
    overageTokens += Math.max(0, floorTotal - manifest.effectiveBudget);
  }
  return { overageTokens };
}

/**
 * Sanitize a persisted budgetPressure object.
 *
 * Persisted JSON may be hand-edited, legacy, or partially corrupt — values
 * can be NaN, negative, non-number, or fields can be missing. Aggregating
 * those directly produces NaN or string-coerced values that break consumers
 * (e.g. `nax status`). Treat any non-finite-nonnegative-number field as 0;
 * if nothing valid remains, return undefined so the aggregator omits
 * `budgetPressure` (matching AC-7's "legacy contributes zero" rule).
 */
function sanitizeProviderPressure(raw: unknown): NonNullable<ContextProviderMetrics["budgetPressure"]> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const fields = ["overageTokens", "droppedCount", "droppedTokens"] as const;
  let sanitized: NonNullable<ContextProviderMetrics["budgetPressure"]> | null = null;
  for (const field of fields) {
    const v = obj[field];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      if (!sanitized) {
        sanitized = { overageTokens: 0, droppedCount: 0, droppedTokens: 0 };
      }
      sanitized[field] = v;
    }
  }
  return sanitized ?? undefined;
}

export async function collectStoryMetrics(ctx: PipelineContext, storyStartTime: string): Promise<StoryMetrics> {
  const story = ctx.story;
  const routing = ctx.routing;
  const agentResult = ctx.agentResult;

  // Calculate attempts (initial + escalations)
  // @design: BUG-067: priorFailures captures cross-tier attempts that story.escalations never records
  const escalationCount = story.escalations?.length || 0;
  const priorFailureCount = story.priorFailures?.length || 0;
  const attempts = priorFailureCount + Math.max(1, story.attempts || 1);

  // Determine final tier (from last escalation or initial routing)
  const finalTier = escalationCount > 0 ? story.escalations[escalationCount - 1].toTier : routing.modelTier;

  // rectifyAttempt > 0 means the rectify phase ran at least once within the story orchestrator.
  // Disqualifies first-pass success (BUG-067 / issue #679).
  const rectifyAttemptCount = ctx.rectifyAttempt ?? 0;

  // First pass success = succeeded with no tier escalation, no cross-tier failures,
  // and no rectify repair cycles (BUG-067 / issue #679)
  const firstPassSuccess =
    agentResult?.success === true && escalationCount === 0 && priorFailureCount === 0 && rectifyAttemptCount === 0;

  // Extract model name and agent from config
  const agentUsed = routing.agent ?? ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
  let modelUsed: string = routing.modelTier;
  try {
    const modelDef = resolveModelForAgent(
      ctx.config.models,
      agentUsed,
      routing.modelTier,
      ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
    );
    modelUsed = modelDef.model;
  } catch {
    /* tier not configured — use tier name as fallback */
  }

  // initialComplexity: prefer story.routing.initialComplexity (first classify),
  // fall back to routing.complexity for backward compat
  const initialComplexity = story.routing?.initialComplexity ?? routing.complexity;

  // fullSuiteGatePassed: true only for TDD strategies when gate passes
  const isTddStrategy =
    routing.testStrategy === "three-session-tdd" || routing.testStrategy === "three-session-tdd-lite";
  const fullSuiteGatePassed = isTddStrategy ? (ctx.fullSuiteGatePassed ?? false) : false;

  const featureId = ctx.prd.feature;
  const contextMetrics =
    ctx.projectDir && featureId
      ? await deriveContextMetrics(ctx.projectDir, story.id, featureId, ctx.contextToolRunCounter?.calls)
      : undefined;

  return {
    storyId: story.id,
    complexity: routing.complexity,
    initialComplexity,
    modelTier: routing.modelTier,
    modelUsed,
    agentUsed,
    attempts,
    finalTier,
    success: agentResult?.success || false,
    cost: ctx.runtime.costAggregator.byStory()[story.id]?.totalCostUsd ?? 0,
    durationMs: agentResult?.durationMs || 0,
    firstPassSuccess,
    startedAt: storyStartTime,
    completedAt: new Date().toISOString(),
    fullSuiteGatePassed,
    ...(ctx.fullSuiteGateFailingFiles && ctx.fullSuiteGateFailingFiles.length > 0
      ? { failingTestFiles: ctx.fullSuiteGateFailingFiles }
      : {}),
    runtimeCrashes: ctx.storyRuntimeCrashes ?? 0,
    tokens: agentResult?.tokenUsage
      ? new TokenUsage({
          inputTokens: agentResult.tokenUsage.inputTokens,
          outputTokens: agentResult.tokenUsage.outputTokens,
          cacheReadInputTokens: agentResult.tokenUsage.cacheReadInputTokens,
          cacheCreationInputTokens: agentResult.tokenUsage.cacheCreationInputTokens,
        })
      : undefined,
    ...(contextMetrics !== undefined && { context: contextMetrics }),
    ...(ctx.agentFallbacks?.length && { fallback: { hops: ctx.agentFallbacks } }),
  };
}

/**
 * Collect metrics for a batch of stories.
 *
 * Creates individual story metrics for each story in the batch,
 * distributing the total cost and duration proportionally.
 *
 * @param ctx - Pipeline context with batch execution results
 * @param storyStartTime - Batch start timestamp (ISO string)
 * @returns Array of story metrics (one per story in batch)
 *
 * @example
 * ```ts
 * const batchMetrics = collectBatchMetrics(ctx, "2026-02-17T10:30:00.000Z");
 * // [
 * //   { storyId: "US-001", cost: 0.0078, ... },
 * //   { storyId: "US-002", cost: 0.0078, ... },
 * //   { storyId: "US-003", cost: 0.0078, ... },
 * // ]
 * ```
 */
export function collectBatchMetrics(ctx: PipelineContext, storyStartTime: string): StoryMetrics[] {
  const stories = ctx.stories;
  const routing = ctx.routing;
  const agentResult = ctx.agentResult;

  const batchTotal = ctx.runtime.costAggregator.byStory()[ctx.story.id]?.totalCostUsd ?? 0;
  const totalDuration = agentResult?.durationMs || 0;
  const costPerStory = batchTotal / stories.length;
  const durationPerStory = totalDuration / stories.length;

  const batchAgentUsed = routing.agent ?? ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
  let modelUsed: string = routing.modelTier;
  try {
    const modelDef = resolveModelForAgent(
      ctx.config.models,
      batchAgentUsed,
      routing.modelTier,
      ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
    );
    modelUsed = modelDef.model;
  } catch {
    /* tier not configured — use tier name as fallback */
  }

  return stories.map((story) => {
    // initialComplexity: prefer story.routing.initialComplexity (if individual routing exists),
    // fall back to shared routing.complexity (batch stories classified together)
    const initialComplexity = story.routing?.initialComplexity ?? routing.complexity;

    return {
      storyId: story.id,
      complexity: routing.complexity,
      initialComplexity,
      modelTier: routing.modelTier,
      modelUsed,
      agentUsed: batchAgentUsed,
      attempts: 1, // batch stories don't escalate individually
      finalTier: routing.modelTier,
      success: true, // if batch succeeded, all stories succeeded
      cost: costPerStory,
      durationMs: durationPerStory,
      firstPassSuccess: true, // batch = first pass success
      startedAt: storyStartTime,
      completedAt: new Date().toISOString(),
      fullSuiteGatePassed: false, // batches are not TDD-gated
      runtimeCrashes: 0, // batch stories don't have individual crash tracking
    };
  });
}

/**
 * Canonical path to `metrics.json` under a given output directory.
 *
 * Both `saveRunMetrics` and `loadRunMetrics` (and any read-side consumer
 * that needs to point at the same file) must use this helper so the write
 * location and read location can never drift apart (BUG-1 — see
 * docs/20260816-review-since-0.80.0-canary.3.md).
 *
 * The output dir is `runtime.outputDir` (defaulting to
 * `~/.nax/<projectKey>`), NOT the repo root.
 */
export function metricsPathFor(outputDir: string): string {
  return path.join(outputDir, "metrics.json");
}

/**
 * Save run metrics to nax/metrics.json.
 *
 * Appends the run metrics to the existing metrics file (or creates it if missing).
 * Each run is a separate entry in the JSON array.
 *
 * @param workdir - Project root directory
 * @param runMetrics - Run metrics to persist
 *
 * @example
 * ```ts
 * await saveRunMetrics("/home/user/project", {
 *   runId: "run-20260217-103045",
 *   feature: "auth-system",
 *   totalCost: 0.1234,
 *   stories: [...],
 *   ...
 * });
 * ```
 */
export async function saveRunMetrics(outputDir: string, runMetrics: RunMetrics): Promise<void> {
  const metricsPath = metricsPathFor(outputDir);

  // Compute totalTokens by summing all story tokens
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;

  for (const story of runMetrics.stories) {
    if (story.tokens) {
      totalInputTokens += story.tokens.inputTokens;
      totalOutputTokens += story.tokens.outputTokens;
      totalCacheReadInputTokens += story.tokens.cacheReadInputTokens ?? 0;
      totalCacheCreationInputTokens += story.tokens.cacheCreationInputTokens ?? 0;
    }
  }

  // Only add totalTokens if there's actual non-zero token data
  const hasTokenData =
    totalInputTokens > 0 || totalOutputTokens > 0 || totalCacheReadInputTokens > 0 || totalCacheCreationInputTokens > 0;

  const finalMetrics: RunMetrics = hasTokenData
    ? {
        ...runMetrics,
        totalTokens: new TokenUsage({
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          cacheCreationInputTokens: totalCacheCreationInputTokens,
        }),
      }
    : runMetrics;

  // BUG-6: serialize load-modify-save across processes so two parallel `nax run`
  // invocations (or worktree-mode parallel stories writing to the same per-project
  // metrics.json) cannot both read the same base, append, and have the later
  // rename() silently drop the earlier writer's append. The entire
  // read-append-cap-write sequence must sit inside the critical section: a
  // writer that releases the lock before its write lands lets a peer read a
  // stale base and overwrite the append. Lock is keyed by the metrics file path.
  await withPathFileLock(metricsPath, async () => {
    const existing = await loadJsonFile<RunMetrics[]>(metricsPath, "metrics");
    const allMetrics = Array.isArray(existing) ? existing : [];
    allMetrics.push(finalMetrics);

    // GROWTH-1: cap retained history to the last MAX_RETAINED_RUNS runs — drop
    // the oldest first. Runs are appended chronologically, so a simple tail
    // slice keeps the most recent ones.
    const isTruncating = allMetrics.length > MAX_RETAINED_RUNS;
    const cappedMetrics = isTruncating ? allMetrics.slice(allMetrics.length - MAX_RETAINED_RUNS) : allMetrics;

    // GROWTH-1: make the resulting semantic drift observable — aggregate
    // metrics (calculateAggregateMetrics) and any downstream consumer (e.g.
    // `nax status --cost`) silently become "totals across the last
    // MAX_RETAINED_RUNS runs" instead of true all-time history once this
    // fires. Logged once per process lifetime (see hasWarnedAboutRunTruncation)
    // so it doesn't spam on every run after the cap is first hit. The check and
    // set are serialized under the lock, so concurrent truncating saves cannot
    // both pass the guard and double-log.
    if (isTruncating && !hasWarnedAboutRunTruncation) {
      hasWarnedAboutRunTruncation = true;
      const droppedCount = allMetrics.length - MAX_RETAINED_RUNS;
      getLogger().warn(
        "metrics",
        "Run-history cap reached — oldest run-entries dropped from metrics.json; aggregate metrics now cover only the retained window",
        {
          droppedCount,
          maxRetainedRuns: MAX_RETAINED_RUNS,
          metricsPath,
        },
      );
    }

    // Write back under the lock so the next acquirer always reads what the
    // previous writer actually persisted.
    await saveJsonFile(metricsPath, cappedMetrics, "metrics");
  });
}

/**
 * Load all run metrics from nax/metrics.json.
 *
 * @param workdir - Project root directory
 * @returns Array of run metrics, or empty array if file doesn't exist
 *
 * @example
 * ```ts
 * const runs = await loadRunMetrics("/home/user/project");
 * console.log(`Total runs: ${runs.length}`);
 * ```
 */
export async function loadRunMetrics(outputDir: string): Promise<RunMetrics[]> {
  const metricsPath = metricsPathFor(outputDir);

  const content = await loadJsonFile<RunMetrics[]>(metricsPath, "metrics");
  return Array.isArray(content) ? content : [];
}
