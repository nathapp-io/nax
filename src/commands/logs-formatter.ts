/**
 * Log formatting and display utilities
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { formatDuration, formatLogEntry, formatRunSummary } from "../log-format/formatter";
import type { LogEntry, LogLevel } from "../logger/types";
export { formatDuration };
import type { VerbosityMode } from "../log-format/types";
import { cancellableDelay } from "../utils/bun-deps";
import { extractRunSummary } from "./logs-reader";

/**
 * Log level hierarchy for filtering
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: -1,
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
 * Dependencies for {@link followLogs}.
 *
 * Mirrors the {@link WaitDeps} pattern from `src/schedule/wait.ts`: a
 * `Partial<Deps>` override merged over a module-level default at call
 * time. The defaults preserve today's `console.log` output and the
 * canonical cancellable inter-poll delay.
 */
export interface FollowLogsDeps {
  /** Emits one formatted line. Defaults to today's console output. */
  emit: (line: string) => void;
  /** Waits between polls. Defaults to cancellableDelay; rejects on abort. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Reads the file from a byte offset to EOF. Defaults to `Bun.file(path).slice(start).text()`. */
  readRange: (filePath: string, start: number) => Promise<string>;
}

async function defaultReadRange(filePath: string, start: number): Promise<string> {
  return Bun.file(filePath).slice(start).text();
}

const DEFAULT_FOLLOW_LOGS_DEPS: FollowLogsDeps = {
  emit: (line) => console.log(line),
  sleep: (ms, signal) => cancellableDelay(ms, signal),
  readRange: defaultReadRange,
};

/**
 * Follow logs in real-time (tail -f mode).
 *
 * Returns `"cancelled"` when the supplied signal fires — either at the
 * top of the loop on the next iteration, or via the injected `sleep`
 * rejecting on abort. Output and inter-poll delay are routed through
 * injectable dependencies for testability. Incremental reads are
 * byte-aligned via the injected `readRange` seam, so non-ASCII content
 * in the file does not cause the offset and the read to drift out of
 * sync. When the file is rewritten shorter than the consumed offset
 * (in-place truncation), the offset is resynchronised back to 0 so the
 * next append is detected from the new file's start.
 */
export async function followLogs(
  filePath: string,
  options: { json?: boolean; story?: string; level?: LogLevel },
  opts?: { signal?: AbortSignal; _deps?: Partial<FollowLogsDeps> },
): Promise<"cancelled"> {
  const deps: FollowLogsDeps = { ...DEFAULT_FOLLOW_LOGS_DEPS, ...opts?._deps };
  const signal = opts?.signal;
  const mode: VerbosityMode = options.json ? "json" : "normal";

  if (signal?.aborted) return "cancelled";

  let lastOffset = await consumeRange(filePath, 0, deps, options, mode);

  while (true) {
    if (signal?.aborted) return "cancelled";

    try {
      await deps.sleep(500, signal);
    } catch {
      return "cancelled";
    }

    const currentSize = (await Bun.file(filePath).stat()).size;

    if (currentSize > lastOffset) {
      lastOffset = await consumeRange(filePath, lastOffset, deps, options, mode);
    } else if (currentSize < lastOffset) {
      lastOffset = await consumeRange(filePath, 0, deps, options, mode);
    }
  }
}

/**
 * Reads the file from `start` (byte offset) to EOF via the injected
 * `readRange` seam, splits the result on newline, formats each line,
 * and returns the new offset (start + byte length of the content
 * returned). Skips invalid JSON lines.
 */
async function consumeRange(
  filePath: string,
  start: number,
  deps: FollowLogsDeps,
  options: { json?: boolean; story?: string; level?: LogLevel },
  mode: VerbosityMode,
): Promise<number> {
  const chunk = await deps.readRange(filePath, start);
  if (!chunk) return start;

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      if (!shouldDisplayEntry(entry, options)) {
        continue;
      }

      const formatted = formatLogEntry(entry, { mode, useColor: true });

      if (formatted.shouldDisplay && formatted.output) {
        deps.emit(formatted.output);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  return start + Buffer.byteLength(chunk, "utf8");
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
