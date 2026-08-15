/**
 * Context Engine v2 — PriorRunFailureProvider (US-003)
 *
 * Reads retained `metrics.json` history and surfaces a single `prior-failure`
 * chunk at story scope when the requested story has at least one prior-run
 * failure recorded. Used by the rectify stage so a retrying agent has a
 * deterministic record of how this story failed previously.
 *
 * Failure handling (per spec):
 * - Source file absent (no `metrics.json` at `request.repoRoot`):
 *   `fetch()` returns empty chunks; never throws.
 * - Source file malformed (unparseable JSON):
 *   `loadRunMetrics()` returns []; the provider surfaces empty chunks; never throws.
 * - `loadRunMetrics()` itself throws (defensive — should never happen):
 *   `fetch()` catches, logs, and returns empty chunks; never throws.
 *
 * Wire contract: pullTools is always empty (push-style provider).
 *
 * See: docs/superpowers/specs/2026-08-15-context-engine-v23-prior-failure-design.md
 */

import { createHash } from "node:crypto";
import { getLogger } from "@/logger";
import { loadRunMetrics as _loadRunMetrics } from "@/metrics";
import type { RunMetrics } from "@/metrics";
import { errorMessage } from "@/utils/errors";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on
 * the exported object to inject fakes without `mock.module()`.
 */
export const _priorRunFailureDeps: {
  loadRunMetrics(outputDir: string): Promise<RunMetrics[]>;
} = {
  loadRunMetrics: _loadRunMetrics,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Aggregate attempt counts and unique failing test files for the requested
 * story across the entire retained history.
 *
 * The retained history is already capped to MAX_RETAINED_RUNS (200) by
 * `saveRunMetrics()`, so this is bounded.
 *
 * Defensive: a hand-edited or partially corrupt run entry may omit
 * `stories`, a story may lack a string `storyId`, or `attempts` may be
 * missing/NaN/negative. Such entries are skipped silently — they must
 * not throw, since the spec requires `fetch()` to never throw on
 * malformed metrics (AC9 / failure handling).
 */
function aggregatePriorFailures(
  runs: RunMetrics[],
  storyId: string,
): {
  totalAttempts: number;
  uniqueFailingFiles: string[];
} {
  let totalAttempts = 0;
  const failingFiles = new Set<string>();

  for (const run of runs) {
    if (!run || !Array.isArray(run.stories)) continue;
    for (const story of run.stories) {
      if (!story || typeof story.storyId !== "string") continue;
      if (story.storyId !== storyId) continue;
      if (story.success) continue;
      if (typeof story.attempts !== "number" || !Number.isFinite(story.attempts) || story.attempts < 0) {
        continue;
      }
      totalAttempts += story.attempts;
      if (Array.isArray(story.failingTestFiles)) {
        for (const f of story.failingTestFiles) {
          if (typeof f === "string") failingFiles.add(f);
        }
      }
    }
  }

  return { totalAttempts, uniqueFailingFiles: [...failingFiles] };
}

/**
 * Render the aggregated prior-failure block as Markdown.
 *
 * Layout (stable for snapshot tests / prompt templates):
 *   ## Prior Failure: <storyId>
 *   - Prior attempts: <totalAttempts>
 *   - Failing test files: <comma-joined list, or "none recorded">
 */
function renderPriorFailureChunk(
  storyId: string,
  totalAttempts: number,
  uniqueFailingFiles: readonly string[],
): string {
  const fileList = uniqueFailingFiles.length > 0 ? uniqueFailingFiles.join(", ") : "none recorded";
  const lines = [
    `## Prior Failure: ${storyId}`,
    `- Prior attempts: ${totalAttempts}`,
    `- Failing test files: ${fileList}`,
  ];
  return lines.join("\n");
}

/**
 * Build the chunk if any prior failure is recorded; otherwise return null.
 */
function buildChunk(storyId: string, totalAttempts: number, uniqueFailingFiles: readonly string[]): RawChunk | null {
  if (totalAttempts <= 0) return null;
  const content = renderPriorFailureChunk(storyId, totalAttempts, uniqueFailingFiles);
  const hash = contentHash8(content);
  const tokens = Math.ceil(content.length / 4);
  return {
    id: `prior-run-failure:${hash}`,
    kind: "prior-failure",
    scope: "story",
    role: ["implementer", "reviewer"],
    content,
    tokens,
    rawScore: 1.0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads `<request.repoRoot>/metrics.json` and emits one chunk per request
 * when the requested story has any prior-run failure recorded.
 */
export class PriorRunFailureProvider implements IContextProvider {
  readonly id = "prior-run-failure" as const;
  readonly kind = "prior-failure" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const storyId = request.storyId;
    if (!storyId) {
      return { chunks: [], pullTools: [] };
    }

    let runs: RunMetrics[] = [];
    try {
      runs = await _priorRunFailureDeps.loadRunMetrics(request.repoRoot);
    } catch (err) {
      // Defensive: loadRunMetrics already returns [] for missing/malformed
      // metrics.json (the spec's AC4/AC9 cases), but a future dep swap, a
      // filesystem permission error, or a structurally corrupt file could
      // throw. Surface the unexpected failure so corrupted/unavailable
      // history is observable in the logs — without this it is
      // indistinguishable from a clean history — and never let fetch throw.
      getLogger().warn("prior-run-failure", "loadRunMetrics threw — returning empty chunks", {
        storyId,
        repoRoot: request.repoRoot,
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }
    if (!Array.isArray(runs) || runs.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const { totalAttempts, uniqueFailingFiles } = aggregatePriorFailures(runs, storyId);
    const chunk = buildChunk(storyId, totalAttempts, uniqueFailingFiles);
    if (!chunk) return { chunks: [], pullTools: [] };

    return { chunks: [chunk], pullTools: [] };
  }
}
