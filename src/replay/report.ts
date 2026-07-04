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

function totalCost(timeline: RunTimeline): number | undefined {
  let sum = 0;
  let hasAny = false;
  for (const s of timeline.stories) {
    if (typeof s.cost === "number") {
      sum += s.cost;
      hasAny = true;
    }
  }
  return hasAny ? sum : undefined;
}

function formatTotalCost(cost: number | undefined): string {
  if (typeof cost !== "number") return "n/a";
  return `$${cost.toFixed(4)}`;
}

function renderHeader(timeline: RunTimeline): string[] {
  const isCrashed = timeline.status === "crashed";
  const status = isCrashed ? "CRASHED" : timeline.status;
  return [
    "=== nax replay ===",
    `Run: ${timeline.runId || "n/a"}`,
    `Feature: ${timeline.feature || "n/a"}`,
    `Status: ${status}`,
    `Stories: ${timeline.stories.length}`,
    `Cost: ${formatTotalCost(totalCost(timeline))}`,
  ];
}

function renderStoryBlock(story: StoryTimeline, expandPhases: boolean): string[] {
  const lines: string[] = [];
  lines.push(`${story.storyId} ${story.status}`);

  const showPhases = expandPhases || story.status === "failed";
  if (!showPhases) return lines;

  story.phases.forEach((phase, i) => {
    const isRootCause = story.status === "failed" && i === story.rootCausePhaseIndex;
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
  const lines: string[] = [];
  lines.push(...renderHeader(timeline));
  lines.push("");
  lines.push("Note: phases reconstructed from logs (best-effort).");
  lines.push("");

  const stories = options.story ? timeline.stories.filter((s) => s.storyId === options.story) : timeline.stories;

  for (const story of stories) {
    lines.push(...renderStoryBlock(story, options.all === true));
    lines.push("");
  }

  return lines.join("\n");
}
