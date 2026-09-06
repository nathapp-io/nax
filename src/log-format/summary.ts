/**
 * Run-level summary output: the footer printed when a run ends, and the
 * non-blocking review findings block that precedes it.
 *
 * Split from formatter.ts, which formats individual `LogEntry` records — a
 * different cadence (once per run vs. once per line) and a different input
 * (aggregate counts vs. a log entry).
 */

import chalk from "chalk";
import type { AdvisoryFindingSummaryEntry } from "../review/review-audit.js";
// Leaf import (not the ../review barrel): the barrel does `export * from "./runner"`,
// which transitively pulls operations -> implement, closing a circular __esm init
// cycle in the bundled build. See scripts/check-log-format-layering.ts.
import { SEVERITY_RANK } from "../review/severity.js";
import { type ChalkLike, createNoopChalk } from "./chalk-like.js";
import { formatCost, formatDuration } from "./formatter.js";
import { EMOJI, type FormatterOptions, type RunSummary } from "./types.js";

/**
 * Format run summary footer
 */
export function formatRunSummary(summary: RunSummary, options: FormatterOptions): string {
  const { mode, useColor = true } = options;

  if (mode === "json") {
    return JSON.stringify(summary);
  }

  const c: ChalkLike = useColor ? chalk : createNoopChalk();
  const lines: string[] = [];

  lines.push("");
  lines.push(c.blue("═".repeat(60)));
  lines.push(c.bold(c.blue(`  ${EMOJI.storyComplete} RUN SUMMARY`)));
  lines.push(c.blue("═".repeat(60)));

  const successRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : "0.0";
  const statusColor = summary.failed === 0 ? c.green : summary.passed > summary.failed ? c.yellow : c.red;

  lines.push(`  ${c.gray("Total:")}    ${c.bold(summary.total.toString())}`);
  lines.push(`  ${c.green(`${EMOJI.success} Passed:`)}  ${c.bold(summary.passed.toString())}`);

  if (summary.failed > 0) {
    lines.push(`  ${c.red(`${EMOJI.failure} Failed:`)}  ${c.bold(summary.failed.toString())}`);
  }

  if (summary.skipped > 0) {
    lines.push(`  ${c.yellow(`${EMOJI.skip} Skipped:`)} ${c.bold(summary.skipped.toString())}`);
  }

  // A story that ends at "Human review needed" is paused: the pipeline records
  // it and moves on, and none of the three counters claim it. Deriving the
  // residual rather than adding a fourth counter keeps this correct for any
  // terminal state the counters do not model. Without it, a run whose last two
  // stories both hit a provider 429 printed "Total: 4 / Passed: 2 / 50.0%" and
  // said nothing at all about the two that stopped.
  const unresolved = summary.total - summary.passed - summary.failed - summary.skipped;
  if (unresolved > 0) {
    lines.push(
      `  ${c.yellow(`${EMOJI.warning} Unresolved:`)} ${c.bold(unresolved.toString())} ${c.gray("(paused / awaiting review)")}`,
    );
  }

  lines.push(`  ${c.gray("Success:")}  ${statusColor(c.bold(`${successRate}%`))}`);
  lines.push(c.blue("─".repeat(60)));
  lines.push(`  ${EMOJI.duration} Duration: ${c.bold(formatDuration(summary.durationMs))}`);
  lines.push(`  ${EMOJI.cost} Cost:     ${c.bold(formatCost(summary.totalCost))}`);
  lines.push(c.blue("═".repeat(60)));
  lines.push("");

  return lines.join("\n");
}

/**
 * Format the run-end advisory (sub-threshold review) findings summary.
 *
 * §2.1 — adversarial/semantic review findings below `blockingThreshold` never
 * block a story and, absent this call, only ever surface in a per-story debug
 * log line and the on-disk `.nax/review-audit/` trail. This renders them as a
 * severity-graded block so real findings are never silently dropped.
 */
export function formatAdvisorySummary(
  findings: readonly AdvisoryFindingSummaryEntry[],
  options: FormatterOptions,
): string {
  if (findings.length === 0) return "";

  const { mode, useColor = true } = options;

  if (mode === "json") {
    return JSON.stringify(findings);
  }

  const c: ChalkLike = useColor ? chalk : createNoopChalk();
  const rank = SEVERITY_RANK as Record<string, number>;
  const sorted = [...findings].sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0));

  const lines: string[] = [];
  lines.push("");
  lines.push(c.yellow("─".repeat(60)));
  lines.push(c.bold(c.yellow(`  ${EMOJI.warning} NON-BLOCKING REVIEW FINDINGS (${findings.length})`)));
  const coverageGapCount = findings.filter((f) => f.coverageGap).length;
  if (coverageGapCount > 0) {
    lines.push(
      c.gray(
        `  ${coverageGapCount} of ${findings.length} were coverage-gap demotions (recurred past the block limit — candidate for spec/AC review)`,
      ),
    );
  }
  const noActionCount = findings.filter((f) => f.actionRequired === false).length;
  if (noActionCount > 0) {
    lines.push(
      c.gray(
        `  ${noActionCount} of ${findings.length} asked for no change (compliance notes — the best-effort fix pass skipped them)`,
      ),
    );
  }
  lines.push(c.yellow("─".repeat(60)));

  for (const f of sorted) {
    const location = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined;
    const parts = [
      `[${f.severity}]`,
      f.storyId ?? "unknown",
      location,
      f.category,
      f.coverageGap ? "coverage-gap" : undefined,
      f.actionRequired === false ? "no-action" : undefined,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    lines.push(`  ${c.gray(parts.join(" · "))}`);
    lines.push(`    ${f.issue}`);
  }

  lines.push(c.yellow("─".repeat(60)));
  lines.push("");

  return lines.join("\n");
}
