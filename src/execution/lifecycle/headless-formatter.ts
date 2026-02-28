/**
 * Headless Output Formatting
 *
 * Handles console output formatting for headless (non-TUI) mode.
 * Extracts run header and footer formatting logic from runner.ts.
 */

import path from "node:path";
import chalk from "chalk";
import type { RunSummary } from "../../logging";
import { formatRunSummary } from "../../logging";

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

  const pkg = await Bun.file(path.join(import.meta.dir, "..", "..", "..", "package.json")).json();

  console.log("");
  console.log(chalk.bold(chalk.blue("═".repeat(60))));
  console.log(chalk.bold(chalk.blue(`  ▶ NAX v${pkg.version} — RUN STARTED`)));
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
