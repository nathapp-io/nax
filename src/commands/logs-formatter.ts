/**
 * Log formatting and display utilities
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { LogEntry, LogLevel } from "../logger/types";
import { formatDuration, formatLogEntry, formatRunSummary } from "../logging/formatter";
export { formatDuration };
import type { VerbosityMode } from "../logging/types";
import { extractRunSummary } from "./logs-reader";

/**
 * Log level hierarchy for filtering
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Display runs table
 */
export async function displayRunsList(runsDir: string): Promise<void> {
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(chalk.dim("No runs found"));
    return;
  }

  console.log(chalk.bold("\nRuns:\n"));
  console.log(chalk.gray("  Timestamp            Stories  Duration  Cost      Status"));
  console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));

  for (const file of files) {
    const filePath = join(runsDir, file);
    const summary = await extractRunSummary(filePath);

    const timestamp = file.replace(".jsonl", "");
    const stories = summary ? `${summary.passed}/${summary.total}` : "?/?";
    const duration = summary ? formatDuration(summary.durationMs) : "?";
    const cost = summary ? `$${summary.totalCost.toFixed(4)}` : "$?.????";
    const status = summary ? (summary.failed === 0 ? chalk.green("✓") : chalk.red("✗")) : "?";

    console.log(`  ${timestamp}  ${stories.padEnd(7)}  ${duration.padEnd(8)}  ${cost.padEnd(8)}  ${status}`);
  }

  console.log();
}

/**
 * Display static logs
 */
export async function displayLogs(
  filePath: string,
  options: { json?: boolean; story?: string; level?: LogLevel },
): Promise<void> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.trim().split("\n");

  const mode: VerbosityMode = options.json ? "json" : "normal";

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      if (!shouldDisplayEntry(entry, options)) {
        continue;
      }

      const formatted = formatLogEntry(entry, { mode, useColor: true });

      if (formatted.shouldDisplay && formatted.output) {
        console.log(formatted.output);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  if (!options.json) {
    const summary = await extractRunSummary(filePath);
    if (summary) {
      console.log(formatRunSummary(summary, { mode: "normal", useColor: true }));
    }
  }
}

/**
 * Follow logs in real-time (tail -f mode)
 */
export async function followLogs(
  filePath: string,
  options: { json?: boolean; story?: string; level?: LogLevel },
): Promise<void> {
  const mode: VerbosityMode = options.json ? "json" : "normal";

  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.trim().split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      if (!shouldDisplayEntry(entry, options)) {
        continue;
      }

      const formatted = formatLogEntry(entry, { mode, useColor: true });

      if (formatted.shouldDisplay && formatted.output) {
        console.log(formatted.output);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  let lastSize = (await Bun.file(filePath).stat()).size;

  while (true) {
    await Bun.sleep(500);

    const currentSize = (await Bun.file(filePath).stat()).size;

    if (currentSize > lastSize) {
      const newFile = Bun.file(filePath);
      const newContent = await newFile.text();
      const newLines = newContent.slice(lastSize).trim().split("\n");

      for (const line of newLines) {
        if (!line.trim()) continue;

        try {
          const entry: LogEntry = JSON.parse(line);

          if (!shouldDisplayEntry(entry, options)) {
            continue;
          }

          const formatted = formatLogEntry(entry, { mode, useColor: true });

          if (formatted.shouldDisplay && formatted.output) {
            console.log(formatted.output);
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      lastSize = currentSize;
    }
  }
}

/**
 * Check if entry should be displayed based on filters
 */
function shouldDisplayEntry(entry: LogEntry, options: { json?: boolean; story?: string; level?: LogLevel }): boolean {
  if (options.story && entry.storyId !== options.story) {
    return false;
  }

  if (options.level) {
    const entryPriority = LOG_LEVEL_PRIORITY[entry.level];
    const filterPriority = LOG_LEVEL_PRIORITY[options.level];

    if (entryPriority < filterPriority) {
      return false;
    }
  }

  return true;
}
