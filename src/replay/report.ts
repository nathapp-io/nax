/**
 * Failure-focused replay report renderer.
 *
 * Consumes a `RunTimeline` (pure value object) and produces a terminal string
 * suitable for the `nax replay` post-mortem command.
 *
 * The renderer is the only place that decides "what's interesting": by default
 * passed stories collapse to a one-liner and failed stories expand to their
 * inferred phase trace with a root-cause marker on the failing phase. Use
 * `{ all: true }` to expand everything or `{ story: "US-002" }` to focus on
 * one.
 */

import type { RunTimeline, StoryTimeline } from "./types";

/** Options for the report renderer. */
export interface RenderOptions {
  /** Expand passed stories too. */
  all?: boolean;
  /** Show only the named story's block. */
  story?: string;
}

function totalCost(stories: StoryTimeline[]): number | undefined {
  let sum = 0;
  let hasAny = false;
  for (const s of stories) {
    // `typeof NaN === "number"`, so the Number.isFinite guard rejects NaN
    // and ±Infinity from malformed metrics.
    if (typeof s.cost === "number" && Number.isFinite(s.cost)) {
      sum += s.cost;
      hasAny = true;
    }
  }
  return hasAny ? sum : undefined;
}

function formatTotalCost(cost: number | undefined): string {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "n/a";
  return `$${cost.toFixed(4)}`;
}

/**
 * `shownStories` is whatever the caller will actually render below the
 * header (e.g. `{ story: "US-002" }` filters to one) — the header's story
 * count and cost total must reflect that same set, not the full timeline,
 * or the two disagree on scope.
 */
function renderHeader(timeline: RunTimeline, shownStories: StoryTimeline[]): string[] {
  const isCrashed = timeline.status === "crashed";
  const status = isCrashed ? "CRASHED" : timeline.status;
  const isFiltered = shownStories.length !== timeline.stories.length;
  const storiesLine = isFiltered
    ? `Stories: ${shownStories.length} (of ${timeline.stories.length})`
    : `Stories: ${shownStories.length}`;
  return [
    "=== nax replay ===",
    `Run: ${timeline.runId || "n/a"}`,
    `Feature: ${timeline.feature || "n/a"}`,
    `Status: ${status}`,
    storiesLine,
    `Cost: ${formatTotalCost(totalCost(shownStories))}`,
  ];
}

function renderStoryBlock(story: StoryTimeline, expandPhases: boolean): string[] {
  const lines: string[] = [];
  lines.push(`${story.storyId} ${story.status}`);

  const showPhases = expandPhases || story.status === "failed";
  if (!showPhases) return lines;

  // AC-6: the root-cause marker goes on the terminal (last) phase that has
  // status === "fail", not on `rootCausePhaseIndex` — fix-cycle
  // reconstructions can produce multiple failed phases, and the
  // reconstructor currently records only the first.
  let lastFailedIndex = -1;
  if (story.status === "failed") {
    for (let i = story.phases.length - 1; i >= 0; i--) {
      if (story.phases[i]?.status === "fail") {
        lastFailedIndex = i;
        break;
      }
    }
  }

  story.phases.forEach((phase, i) => {
    const isRootCause = i === lastFailedIndex;
    const marker = isRootCause ? " (root cause)" : "";
    lines.push(`  ${phase.name} ${phase.status}${marker}`);
  });
  return lines;
}

/**
 * Render a `RunTimeline` to a human-readable string.
 *
 * Pure: no I/O, no global state. Output is intended for a terminal and is
 * color-free so it remains greppable in CI logs.
 */
export function renderReport(timeline: RunTimeline, options: RenderOptions = {}): string {
  const stories = options.story ? timeline.stories.filter((s) => s.storyId === options.story) : timeline.stories;

  const lines: string[] = [];
  lines.push(...renderHeader(timeline, stories));
  lines.push("");
  lines.push("Note: phases reconstructed from logs (best-effort).");
  lines.push("");

  for (const story of stories) {
    lines.push(...renderStoryBlock(story, options.all === true));
    lines.push("");
  }

  return lines.join("\n");
}
