/**
 * Auto-PR Plugin — PR Body Builder
 *
 * Pure functions that assemble the title and body markdown used to drive
 * `gh pr create --title … --body …` and `glab mr create --title … --description …`.
 *
 * No I/O — these functions receive a `PrBodyContext` and return strings.
 */

import type { UserStory } from "@/prd/types";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** Minimal context required to render a PR title and body. */
export interface PrBodyContext {
  /** Feature name — used in the title prefix and the run summary. */
  feature: string;
  /** Wall-clock run duration in milliseconds. Negative values clamp to zero. */
  totalDurationMs: number;
  /**
   * Display path to the PRD file that drove this run. Repo-relative — the
   * caller (`toPrBodyContext`) relativizes it against the workdir so the PR
   * body never leaks an absolute local filesystem path.
   */
  prdPath: string;
  /** Aggregated counts of story outcomes actually rendered by the body. */
  storySummary: {
    completed: number;
    failed: number;
    skipped: number;
  };
  /** Stories that were part of this run (drives the table). */
  stories: UserStory[];
}

/**
 * Build the conventional-commit PR title.
 *
 * Format: `feat: <feature>` so that
 * `gh pr create --title "feat: auto-pr-plugin"` matches the repo's commit style.
 */
export function buildTitle(ctx: PrBodyContext): string {
  return `feat: ${ctx.feature}`;
}

function formatDuration(totalMs: number): string {
  const clampedMs = Math.max(0, Math.round(totalMs));
  const totalSeconds = Math.floor(clampedMs / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function buildSummaryLines(ctx: PrBodyContext): string[] {
  const { storySummary } = ctx;
  const passed = `${storySummary.completed} passed`;
  const failed = `${storySummary.failed} failed`;
  const skipped = `${storySummary.skipped} skipped`;
  return [
    "## Run summary",
    `- Feature: ${ctx.feature}`,
    `- Stories: ${passed} / ${failed} / ${skipped}`,
    `- Duration: ${formatDuration(ctx.totalDurationMs)}`,
    `- PRD: ${ctx.prdPath}`,
    "",
  ];
}

/**
 * Escape a string for safe inclusion in a single markdown table cell.
 *
 * Pipes break the column boundary and newlines create new rows. Replace both
 * with their backslash-escaped form (`\|`, `\n` → space) so downstream
 * renderers parse the row as a single line.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildStoryTable(stories: UserStory[]): string[] {
  const lines: string[] = [];
  lines.push("| Story | Title | ACs |");
  lines.push("|-------|-------|-----|");
  for (const story of stories) {
    const acCount = story.acceptanceCriteria?.length ?? 0;
    const id = escapeTableCell(story.id);
    const title = escapeTableCell(story.title);
    lines.push(`| ${id} | ${title} | ${acCount} |`);
  }
  lines.push("");
  return lines;
}

/**
 * Build the PR/MR body.
 *
 * Layout (template present):
 * ```
 * > Auto-opened by nax — review pending. Run nax-finish before merge.
 * (blank line)
 * ## Run summary
 * - …
 * | Story | Title | ACs |
 * | …     | …     | …   |
 * (blank line)
 * ---
 * <template verbatim>
 * ```
 *
 * When `template` is `null`, the `---` separator and template block are omitted.
 */
export function buildBody(ctx: PrBodyContext, template: string | null): string {
  const blocks: string[] = [];

  blocks.push("> Auto-opened by nax — review pending. Run nax-finish before merge.");
  blocks.push("");
  blocks.push(...buildSummaryLines(ctx));
  blocks.push(...buildStoryTable(ctx.stories));

  if (template !== null) {
    blocks.push("---");
    blocks.push(template);
  }

  return blocks.join("\n");
}
