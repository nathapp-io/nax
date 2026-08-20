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

import { join } from "node:path";
import { persistSemanticVerdict } from "@/acceptance";
import { featureDir } from "@/config";
import { annotateManifestEffectiveness } from "@/context/engine";
import { renderFragmentBody, writeFragment } from "@/context/fragments";
import { appendProgress } from "@/execution";
import { getLogger } from "@/logger";
import { collectBatchMetrics, collectStoryMetrics } from "@/metrics";
import { countStories, markStoryPassed, savePRD } from "@/prd";
import { errorMessage } from "@/utils/errors";
import { GIT_TIMEOUT_MS } from "@/utils/git";
import { DRAIN_TIMEOUT, raceWithDeadline } from "@/verification";
import { checkReviewGate, isTriggerEnabled } from "../../interaction/triggers";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// Bound on the captured git-diff text. Only the effectiveness annotation
// (Amendment A AC-45) reads this text now — the fragment capture (US-002)
// enumerates file paths via `git diff --name-only` instead, so it is not
// subject to the character cap. The bound is generous enough for any
// single-story diff but still well-bounded to prevent pathological inputs
// from blowing up completion.
const MAX_DIFF_TEXT_CHARS = 8_000;
const HIGH_MEMORY_TELEMETRY_BYTES = 512 * 1_024 * 1_024;

/**
 * BUG-13 — bound on the post-SIGKILL stream drain. Bun documents that piped
 * streams may not close after a kill; without this, a stream that never
 * closes hangs the Promise.all below forever even though the SIGKILL timer
 * already fired. Mirrors verification/executor.ts's drainTimeoutMs default.
 */
const STREAM_DRAIN_DEADLINE_MS = 2_000;

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
    const prdPath = ctx.prdPath ?? join(ctx.featureDir ?? featureDir(ctx.workdir, "unknown"), "prd.json");

    // Collect story metrics
    const storyStartTime = ctx.storyStartTime || new Date().toISOString();
    if (isBatch) {
      ctx.storyMetrics = collectBatchMetrics(ctx, storyStartTime);
    } else {
      ctx.storyMetrics = [await collectStoryMetrics(ctx, storyStartTime)];
    }

    // Amendment A AC-45: annotate context manifests with effectiveness signals.
    // US-002: capture a per-story fragment on successful non-batch completion.
    // Both writes are best-effort — the effectiveness annotation runs a full
    // `git diff` and fragment capture runs a separate `git diff --name-only`;
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
          // AC6: "names each changed file reported by that diff". Using
          // `git diff --name-only` instead of re-parsing the bounded diff
          // text means every changed file (including the deletion side and
          // paths past any character cap on `getDiffText`) reaches the
          // fragment body — the only bound is git's own per-line output,
          // which is naturally small.
          const changedFiles = [...(await _completionDeps.getDiffFilePaths(ctx.workdir, ctx.storyGitRef))];
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

/**
 * Read `git diff --name-only` stdout into a Set of file paths, streaming
 * line-by-line so the full output is never materialised as one string (nor the
 * split/map/filter arrays a full read would build). The returned Set is
 * inherently O(file count) — that is the required result for AC6 — but this
 * avoids the ~4x transient amplification of a full decode on a pathological
 * many-file diff.
 */
async function readDiffFilePaths(stream: ReadableStream<Uint8Array>): Promise<Set<string>> {
  const paths = new Set<string>();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      // The final element may be a partial line split across a chunk boundary;
      // carry it forward to the next read instead of emitting a truncated path.
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) paths.add(trimmed);
      }
    }
    const tail = (pending + decoder.decode()).trim();
    if (tail.length > 0) paths.add(tail);
    return paths;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Race an already-in-progress stream-read promise against
 * STREAM_DRAIN_DEADLINE_MS. Callers must only invoke this AFTER `proc.exited`
 * has already resolved (normal exit or our own SIGKILL) — never concurrently
 * with it. Racing a live, still-running process against this deadline would
 * truncate legitimately slow (but healthy) git output — e.g. a large diff
 * taking 3-9s, well inside GIT_TIMEOUT_MS — and silently resolve to `empty`
 * instead of the real content (BUG-31). Applied unconditionally once the
 * process has exited (not just after our own kill) because Bun's piped
 * streams can fail to close even on a normal exit (BUG-13) — this covers
 * both.
 */
async function drainAfterExit<T>(streamPromise: Promise<T>, empty: T): Promise<T> {
  const result = await raceWithDeadline(streamPromise, STREAM_DRAIN_DEADLINE_MS);
  return result === DRAIN_TIMEOUT ? empty : result;
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

    // Rule 07: stream reads start immediately, concurrently with awaiting
    // proc.exited, to avoid pipe-buffer deadlock on large diffs. They are
    // NOT bounded by a deadline while the process is still alive — see
    // drainAfterExit.
    const stdoutPromise = readTextStreamPrefix(proc.stdout, MAX_DIFF_TEXT_CHARS);
    const stderrPromise = readTextStreamPrefix(proc.stderr, 0);

    let output: string;
    try {
      await proc.exited;
      [output] = await Promise.all([drainAfterExit(stdoutPromise, ""), drainAfterExit(stderrPromise, "")]);
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
 * Set of file paths changed by the story, derived from `git diff --name-only`.
 * Used by US-002 fragment capture (AC6) so the fragment body names every
 * changed file — including the deletion side and paths past any character cap
 * on `getDiffText`. Output is one path per line and naturally bounded by
 * file count, not content size.
 */
async function getDiffFilePaths(workdir: string, baseRef: string | undefined): Promise<Set<string>> {
  if (!baseRef) return new Set();
  try {
    const proc = _completionDeps.spawn(["git", "diff", "--name-only", `${baseRef}..HEAD`], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timerId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
    }, GIT_TIMEOUT_MS);

    // `--name-only` output is one path per line, bounded by file count — not
    // content size — so it is streamed in full. Capping it (as getDiffText
    // does) would drop paths past the prefix and break AC6's "every changed
    // file" contract, but a single-string read amplifies transient memory ~4x
    // on pathological diffs; readDiffFilePaths emits each path into the Set as
    // it is decoded instead. Rule 07: reads start immediately, concurrently
    // with awaiting proc.exited, to avoid pipe-buffer deadlock; not bounded by
    // a deadline while the process is still alive — see drainAfterExit.
    const pathsPromise = readDiffFilePaths(proc.stdout);
    const stderrPromise = readTextStreamPrefix(proc.stderr, 0);

    let paths: Set<string>;
    try {
      await proc.exited;
      [paths] = await Promise.all([drainAfterExit(pathsPromise, new Set<string>()), drainAfterExit(stderrPromise, "")]);
    } finally {
      clearTimeout(timerId);
    }

    return timedOut ? new Set() : paths;
  } catch {
    return new Set();
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
  getDiffFilePaths,
  readTextStreamPrefix,
  writeFragment,
  renderFragmentBody,
  spawn: Bun.spawn,
};
