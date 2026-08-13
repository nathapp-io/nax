// RE-ARCH: keep
/**
 * Completion Stage
 *
 * Marks stories as passed, logs progress, emits lifecycle events.
 * This is the final stage in the pipeline for successful executions.
 *
 * Phase 3 (ADR-005): Replaced direct fireHook() calls with event bus emissions.
 * The hooks/reporters subscriber wires those events to actual hook/reporter calls.
 *
 * @returns
 * - `continue`: Stories marked complete, events emitted
 */

import { renderFragmentBody, writeFragment } from "@/context";
import { extractDiffFiles } from "@/utils/diff-files";
import { GIT_TIMEOUT_MS } from "@/utils/git";
import { persistSemanticVerdict } from "../../acceptance/semantic-verdict";
import { annotateManifestEffectiveness } from "../../context/engine/effectiveness";
import { appendProgress } from "../../execution/progress";
import { checkReviewGate, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { collectBatchMetrics, collectStoryMetrics } from "../../metrics";
import { countStories, markStoryPassed, savePRD } from "../../prd";
import { errorMessage } from "../../utils/errors";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// Bound on the captured git-diff text. Two consumers share this read:
//   - Amendment A AC-45 (effectiveness annotation) — tokenises the diff and
//     uses it as evidence against chunk summaries.
//   - US-002 (fragment capture) — extracts the file headers to enumerate
//     "files touched by the story" (AC6).
// 8,000 chars was tight enough for effectiveness annotation to lose file
// headers past the prefix, so US-002 widened the bound. It is still
// well-bounded: a single story's diff rarely exceeds a few hundred KB.
const MAX_DIFF_TEXT_CHARS = 1_048_576;
const HIGH_MEMORY_TELEMETRY_BYTES = 512 * 1_024 * 1_024;

function logHighMemoryCheckpoint(logger: ReturnType<typeof getLogger>, ctx: PipelineContext): void {
  const usage = process.memoryUsage();
  if (usage.heapUsed < HIGH_MEMORY_TELEMETRY_BYTES && usage.rss < HIGH_MEMORY_TELEMETRY_BYTES) return;
  logger.debug("completion.memory", "High memory at completion boundary", {
    storyId: ctx.story.id,
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    agentOutputChars: ctx.agentResult?.output.length ?? 0,
  });
}

export const completionStage: PipelineStage = {
  name: "completion",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;
    const sessionCost = ctx.runtime.costAggregator.byStory()[ctx.story.id]?.totalCostUsd ?? 0;
    // In parallel worktree mode, a shared PRD and prd.json file is managed by the
    // unified executor. Worktree pipelines must not race on it — skip both the in-memory
    // mutation and the disk write when skipPrdPersistence is set.
    const persistPrd = ctx.skipPrdPersistence !== true;

    // Calculate PRD path — prefer ctx.prdPath (already resolved by runner), fall back to
    // featureDir reconstruction, with a last-resort for contexts where neither is set (e.g. tests).
    const prdPath =
      ctx.prdPath ?? (ctx.featureDir ? `${ctx.featureDir}/prd.json` : `${ctx.workdir}/.nax/features/unknown/prd.json`);

    // Collect story metrics
    const storyStartTime = ctx.storyStartTime || new Date().toISOString();
    if (isBatch) {
      ctx.storyMetrics = collectBatchMetrics(ctx, storyStartTime);
    } else {
      ctx.storyMetrics = [await collectStoryMetrics(ctx, storyStartTime)];
    }

    // Amendment A AC-45: annotate context manifests with effectiveness signals.
    // US-002: capture a per-story fragment on successful non-batch completion.
    // Both writes are best-effort and share a single `git diff` invocation;
    // a failure in either one is logged at debug and never blocks the story.
    // Batch mode is intentionally skipped (mirroring the existing effectiveness
    // behaviour and matching the spec's "deferred" batch capture rule).
    const featureId = ctx.prd?.feature;
    const fragmentsEnabled = ctx.config.context?.v2?.fragments?.enabled === true;
    if (!isBatch && ctx.projectDir && featureId && ctx.config.context?.v2?.enabled) {
      let diffText = "";
      try {
        diffText = await _completionDeps.getDiffText(ctx.workdir, ctx.storyGitRef);
        await annotateManifestEffectiveness(ctx.projectDir, featureId, ctx.story.id, {
          agentOutput: ctx.agentResult?.output ?? "",
          diffText,
          findingMessages: (ctx.reviewFindings ?? []).map((f) => f.message),
        });
      } catch (err) {
        logger.debug("completion", "Effectiveness annotation failed — non-fatal", {
          storyId: ctx.story.id,
          error: errorMessage(err),
        });
      }

      if (fragmentsEnabled) {
        try {
          const changedFiles = [...extractDiffFiles(diffText)];
          const body = _completionDeps.renderFragmentBody(
            ctx.story.id,
            ctx.story.title,
            ctx.story.acceptanceCriteria,
            changedFiles,
          );
          const maxTokens = ctx.config.context.v2.fragments.maxTokens;
          await _completionDeps.writeFragment(ctx.projectDir, featureId, ctx.story.id, body, maxTokens);
        } catch (err) {
          logger.debug("completion", "Fragment capture failed — non-fatal", {
            storyId: ctx.story.id,
            error: errorMessage(err),
          });
        }
      }
    }

    // Mark all stories in batch as passed (skipped in parallel worktree mode)
    for (const completedStory of ctx.stories) {
      if (persistPrd) {
        markStoryPassed(ctx.prd, completedStory.id);
      }

      const costPerStory = sessionCost / ctx.stories.length;
      logger.info("completion", "Story passed", {
        storyId: completedStory.id,
        cost: costPerStory,
      });

      // Log progress. Skipped on a rectification re-run (BUG-36) for the same reason
      // as the story:completed emit below — the worktree pipeline's first pass already
      // logged this story "passed" once, before the merge conflict was found.
      if (ctx.featureDir && ctx.skipCompletionEvents !== true) {
        await appendProgress(
          ctx.featureDir,
          completedStory.id,
          "passed",
          `${completedStory.title} — Cost: $${costPerStory.toFixed(4)}${isBatch ? " (batched)" : ""}`,
        );
      }

      // Emit story:completed event — hooks + reporter subscribers handle the rest.
      // Skipped on a rectification re-run (BUG-36): the worktree pipeline's first
      // pass already emitted this event before the merge conflict was found.
      if (ctx.skipCompletionEvents !== true) {
        const storyMetric = ctx.storyMetrics?.find((m) => m.storyId === completedStory.id) ?? ctx.storyMetrics?.[0];
        pipelineEventBus.emit({
          type: "story:completed",
          storyId: completedStory.id,
          story: {
            id: completedStory.id,
            title: completedStory.title,
            status: completedStory.status,
            attempts: completedStory.attempts,
          },
          passed: true,
          runElapsedMs: storyMetric?.durationMs ?? 0,
          cost: costPerStory,
          modelTier: ctx.routing?.modelTier,
          testStrategy: ctx.routing?.testStrategy,
        });
      }

      // review-gate trigger: check if story needs re-review after passing
      if (ctx.interaction && isTriggerEnabled("review-gate", ctx.config)) {
        const shouldContinue = await _completionDeps.checkReviewGate(
          { featureName: ctx.prd.feature, storyId: completedStory.id },
          ctx.config,
          ctx.interaction,
        );
        if (!shouldContinue) {
          logger.warn("completion", "Story marked for re-review", { storyId: completedStory.id });
        }
      }

      // Semantic verdict persistence (AC-4 through AC-7): reviewResult removed in US-005c.
      // Verdict is now written by the execution stage directly when available.
    }

    // Save PRD (skipped in parallel worktree mode — unified executor is the single writer)
    if (persistPrd) {
      await _completionDeps.savePRD(ctx.prd, prdPath);
    }

    logHighMemoryCheckpoint(logger, ctx);

    // Display progress
    const updatedCounts = countStories(ctx.prd);
    logger.info("completion", "Progress update", {
      storyId: ctx.story.id,
      completed: updatedCounts.passed + updatedCounts.failed,
      total: updatedCounts.total,
      passed: updatedCounts.passed,
      failed: updatedCounts.failed,
    });

    return { action: "continue" };
  },
};

async function readTextStreamPrefix(stream: ReadableStream<Uint8Array>, maxChars: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (output.length >= maxChars) continue;
      const decoded = decoder.decode(value, { stream: true });
      output += decoded.slice(0, maxChars - output.length);
    }
    if (output.length < maxChars) {
      output += decoder.decode().slice(0, maxChars - output.length);
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

/** Get a git diff text between baseRef and HEAD. Best-effort, returns "" on failure. */
async function getDiffText(workdir: string, baseRef: string | undefined): Promise<string> {
  if (!baseRef) return "";
  try {
    const proc = _completionDeps.spawn(["git", "diff", `${baseRef}..HEAD`], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Same GIT_TIMEOUT_MS guard every sibling git call in the pipeline uses —
    // without it a hung git process (locked repo, network mount) can stall
    // run completion forever.
    let timedOut = false;
    const timerId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
    }, GIT_TIMEOUT_MS);

    let output: string;
    try {
      [output] = await Promise.all([
        readTextStreamPrefix(proc.stdout, MAX_DIFF_TEXT_CHARS),
        readTextStreamPrefix(proc.stderr, 0),
        proc.exited,
      ]);
    } finally {
      // finally, not a trailing call: a stream read that throws would otherwise
      // leak the timer, holding the event loop open for GIT_TIMEOUT_MS and then
      // SIGKILLing an unrelated (already-reaped) pid slot.
      clearTimeout(timerId);
    }

    return timedOut ? "" : output;
  } catch {
    return "";
  }
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _completionDeps = {
  checkReviewGate,
  persistSemanticVerdict,
  savePRD,
  getDiffText,
  readTextStreamPrefix,
  writeFragment,
  renderFragmentBody,
  spawn: Bun.spawn,
};
