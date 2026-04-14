/**
 * Review Verdict Writer
 *
 * Writes a unified verdict file to .nax/review-verdicts/<featureName>/<storyId>.json
 * after each story's LLM review (semantic + adversarial) completes.
 *
 * The verdict file records per-reviewer blocking/advisory finding counts and
 * whether each reviewer passed. Consumers (CI, dashboards) can read this to
 * understand advisory signal without blocking the pipeline.
 *
 * All operations are best-effort: errors are warned but never thrown so that
 * a verdict write failure can never interrupt an active run.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findNaxProjectRoot } from "../agents/acp";
import { getSafeLogger } from "../logger";
import type { ReviewerFindingSummary } from "./types";

export interface ReviewVerdictEntry {
  /** Story ID */
  storyId: string;
  /** Feature name */
  featureName?: string;
  /** ISO timestamp of when the verdict was written */
  timestamp: string;
  /** blockingThreshold used for this review run */
  blockingThreshold: "error" | "warning" | "info";
  /** Per-reviewer finding breakdown */
  reviewers: {
    semantic?: ReviewerFindingSummary & { passed: boolean };
    adversarial?: ReviewerFindingSummary & { passed: boolean };
  };
}

/** Injectable dependencies for verdict-writer.ts — allows tests to mock without mock.module() */
export const _verdictWriterDeps = {
  findNaxProjectRoot,
  mkdir: mkdir as (path: string, opts?: { recursive?: boolean }) => Promise<string | undefined>,
  writeFile: Bun.write as (path: string, body: string) => Promise<number>,
};

/**
 * Write a unified review verdict file (fire-and-forget).
 * Never throws — errors are logged at warn level.
 */
export async function writeReviewVerdict(entry: ReviewVerdictEntry): Promise<void> {
  const logger = getSafeLogger();
  try {
    const projectDir = await _verdictWriterDeps.findNaxProjectRoot(entry.featureName ? join(entry.featureName) : ".");
    const baseDir = projectDir ?? ".";
    const verdictDir = entry.featureName
      ? join(baseDir, ".nax", "review-verdicts", entry.featureName)
      : join(baseDir, ".nax", "review-verdicts", "_unknown");

    await _verdictWriterDeps.mkdir(verdictDir, { recursive: true });

    const fileName = `${entry.storyId}.json`;
    const filePath = join(verdictDir, fileName);

    await _verdictWriterDeps.writeFile(filePath, JSON.stringify(entry, null, 2));

    logger?.debug("review", "Review verdict written", {
      storyId: entry.storyId,
      filePath,
    });
  } catch (err) {
    logger?.warn("review", "Failed to write review verdict (non-fatal)", {
      storyId: entry.storyId,
      cause: String(err),
    });
  }
}
