/**
 * Headless Output Formatting
 *
 * Handles console output formatting for headless (non-TUI) mode.
 * Extracts run header and footer formatting logic from runner.ts.
 */

import chalk from "chalk";
import type { RunSummary } from "../../logging";
import { formatRunSummary } from "../../logging";
import { NAX_VERSION } from "../../version";

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
