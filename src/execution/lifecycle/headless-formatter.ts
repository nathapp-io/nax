/**
 * Headless Output Formatting
 *
 * Handles console output formatting for headless (non-TUI) mode.
 * Extracts run header and footer formatting logic from runner.ts.
 */

import { type RunSummary, formatAdvisorySummary, formatMutationSummary, formatRunSummary } from "@/log-format";
import type { AdvisoryFindingSummaryEntry, MutationStorySummary } from "@/runtime";
import { NAX_VERSION } from "@/version";
import chalk from "chalk";

export interface RunHeaderOptions {
  feature: string;
  totalStories: number;
  pendingStories: number;
  workdir: string;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
}

export interface RunFooterOptions {
  finalCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  durationMs: number;
  totalCost: number;
  startedAt: string;
  completedAt: string;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
}

/**
 * Output run header in headless mode
 */
export async function outputRunHeader(options: RunHeaderOptions): Promise<void> {
  const { feature, totalStories, pendingStories, workdir, formatterMode } = options;

  if (formatterMode === "json") {
    return;
  }

  console.log("");
  console.log(chalk.bold(chalk.blue("═".repeat(60))));
  console.log(chalk.bold(chalk.blue(`  ▶ NAX v${NAX_VERSION} — RUN STARTED`)));
  console.log(chalk.blue("═".repeat(60)));
  console.log(`  ${chalk.gray("Feature:")}  ${chalk.cyan(feature)}`);
  console.log(`  ${chalk.gray("Stories:")}  ${chalk.cyan(`${totalStories} total, ${pendingStories} pending`)}`);
  console.log(`  ${chalk.gray("Path:")}     ${chalk.dim(workdir)}`);
  console.log(chalk.blue("═".repeat(60)));
  console.log("");
}

/**
 * Output run footer in headless mode
 */
export function outputRunFooter(options: RunFooterOptions): void {
  const { finalCounts, durationMs, totalCost, startedAt, completedAt, formatterMode } = options;

  if (formatterMode === "json") {
    return;
  }

  const runSummary: RunSummary = {
    total: finalCounts.total,
    passed: finalCounts.passed,
    failed: finalCounts.failed,
    skipped: finalCounts.skipped,
    durationMs,
    totalCost,
    startedAt,
    completedAt,
  };

  const summaryOutput = formatRunSummary(runSummary, {
    mode: formatterMode,
    useColor: true,
  });

  console.log(summaryOutput);
}

export function outputMutationSummary(
  summaries: Iterable<MutationStorySummary>,
  formatterMode: "quiet" | "normal" | "verbose" | "json",
): void {
  if (formatterMode === "json") return;
  const output = formatMutationSummary(summaries);
  if (output) console.log(output);
}

/**
 * Output the non-blocking (advisory) review findings summary in headless mode.
 * §2.1 — surfaces sub-threshold review findings that would otherwise only exist
 * in the on-disk review-audit trail. No-op when there are none, or in json mode
 * (findings are available via the review-audit JSONL trail instead).
 */
export function outputAdvisoryFindingsSummary(
  findings: readonly AdvisoryFindingSummaryEntry[],
  formatterMode: "quiet" | "normal" | "verbose" | "json",
): void {
  if (findings.length === 0 || formatterMode === "json") {
    return;
  }

  const output = formatAdvisorySummary(findings, { mode: formatterMode, useColor: true });
  if (output) {
    console.log(output);
  }
}
