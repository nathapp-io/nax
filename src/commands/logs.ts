/**
 * Logs command implementation
 *
 * Displays run logs with filtering, follow mode, and multiple output formats.
 * Uses resolveProject() for directory resolution and formatter for output.
 */

import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { LogEntry, LogLevel } from "../logger/types";
import { type FormattedEntry, formatLogEntry, formatRunSummary } from "../logging/formatter";
import type { RunSummary, VerbosityMode } from "../logging/types";
import type { MetaJson } from "../pipeline/subscribers/registry";
import { type ResolveProjectOptions, resolveProject } from "./common";

/**
 * Swappable dependencies for testing (project convention: _deps over mock.module).
 */
export const _deps = {
  getRunsDir: () => process.env.NAX_RUNS_DIR ?? join(homedir(), ".nax", "runs"),
};

/**
 * Options for logs command
 */
export interface LogsOptions {
  /** Explicit project directory (from -d flag) */
  dir?: string;
  /** Follow mode - stream new entries real-time (from --follow / -f flag) */
  follow?: boolean;
  /** Filter to specific story (from --story / -s flag) */
  story?: string;
  /** Filter by log level (from --level flag) */
  level?: LogLevel;
  /** List all runs in table format (from --list / -l flag) */
  list?: boolean;
  /** Select specific run by timestamp (from --run / -r flag) */
  run?: string;
  /** Output raw JSONL (from --json / -j flag) */
  json?: boolean;
}

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
 * Resolve log file path for a runId from the central registry (~/.nax/runs/).
 *
 * Scans all ~/.nax/runs/*\/meta.json entries for an exact or prefix match on runId.
 * Returns the path to the matching run's JSONL file, or null if eventsDir/file is unavailable.
 * Throws if the runId is not found in the registry at all.
 *
 * @param runId - Full or prefix run ID to look up
 * @returns Absolute path to the JSONL log file, or null if unavailable
 */
async function resolveRunFileFromRegistry(runId: string): Promise<string | null> {
  const runsDir = _deps.getRunsDir();

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    throw new Error(`Run not found in registry: ${runId}`);
  }

  let matched: MetaJson | null = null;
  for (const entry of entries) {
    const metaPath = join(runsDir, entry, "meta.json");
    try {
      const meta: MetaJson = await Bun.file(metaPath).json();
      if (meta.runId === runId || meta.runId.startsWith(runId)) {
        matched = meta;
        break;
      }
    } catch {
      // skip unreadable meta.json entries
    }
  }

  if (!matched) {
    throw new Error(`Run not found in registry: ${runId}`);
  }

  if (!existsSync(matched.eventsDir)) {
    console.log(`Log directory unavailable for run: ${runId}`);
    return null;
  }

  const files = readdirSync(matched.eventsDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(`No log files found for run: ${runId}`);
    return null;
  }

  // Look for the specific run file by runId, fall back to newest
  const specificFile = files.find((f) => f === `${matched.runId}.jsonl`);
  return join(matched.eventsDir, specificFile ?? files[0]);
}

/**
 * Display logs with filtering and formatting
 *
 * @param options - Command options
 */
export async function logsCommand(options: LogsOptions): Promise<void> {
  // When --run <runId> is provided, resolve via central registry
  if (options.run) {
    const runFile = await resolveRunFileFromRegistry(options.run);
    if (!runFile) {
      return;
    }
    if (options.follow) {
      await followLogs(runFile, options);
    } else {
      await displayLogs(runFile, options);
    }
    return;
  }

  // Resolve project directory
  const resolved = resolveProject({ dir: options.dir });
  const naxDir = join(resolved.projectDir, "nax");

  // Read config to get feature name
  const configPath = resolved.configPath;
  const configFile = Bun.file(configPath);
  const config = await configFile.json();
  const featureName = config.feature;

  if (!featureName) {
    throw new Error("No feature specified in config.json");
  }

  const featureDir = join(naxDir, "features", featureName);
  const runsDir = join(featureDir, "runs");

  // Validate runs directory exists
  if (!existsSync(runsDir)) {
    throw new Error(`No runs directory found for feature: ${featureName}`);
  }

  // Handle --list mode (show runs table)
  if (options.list) {
    await displayRunsList(runsDir);
    return;
  }

  // Determine which run to display (latest by default — --run handled above via registry)
  const runFile = await selectRunFile(runsDir);

  if (!runFile) {
    throw new Error("No runs found for this feature");
  }

  // Handle follow mode
  if (options.follow) {
    await followLogs(runFile, options);
    return;
  }

  // Display static logs
  await displayLogs(runFile, options);
}

/**
 * Select which run file to display (always returns the latest run)
 */
async function selectRunFile(runsDir: string): Promise<string | null> {
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  return join(runsDir, files[0]);
}

/**
 * Display runs table
 */
async function displayRunsList(runsDir: string): Promise<void> {
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
 * Extract run summary from log file
 */
async function extractRunSummary(filePath: string): Promise<RunSummary | null> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.trim().split("\n");

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalCost = 0;
  let startedAt = "";
  let completedAt: string | undefined;
  let firstTimestamp = "";
  let lastTimestamp = "";

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      if (!firstTimestamp) {
        firstTimestamp = entry.timestamp;
      }
      lastTimestamp = entry.timestamp;

      if (entry.stage === "run.start") {
        startedAt = entry.timestamp;
        const runData = entry.data as Record<string, unknown>;
        total = typeof runData?.totalStories === "number" ? runData.totalStories : 0;
      }

      if (entry.stage === "story.complete" || entry.stage === "agent.complete") {
        const data = entry.data as Record<string, unknown>;
        const success = data?.success ?? true;
        const action = data?.finalAction || data?.action;

        if (success) {
          passed++;
        } else if (action === "skip") {
          skipped++;
        } else {
          failed++;
        }

        if (data?.cost && typeof data.cost === "number") {
          totalCost += data.cost;
        }
      }

      if (entry.stage === "run.end") {
        completedAt = entry.timestamp;
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  if (!startedAt) {
    return null;
  }

  const durationMs = lastTimestamp ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime() : 0;

  return {
    total,
    passed,
    failed,
    skipped,
    durationMs,
    totalCost,
    startedAt,
    completedAt,
  };
}

/**
 * Display static logs
 */
async function displayLogs(filePath: string, options: LogsOptions): Promise<void> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.trim().split("\n");

  const mode: VerbosityMode = options.json ? "json" : "normal";

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: LogEntry = JSON.parse(line);

      // Apply filters
      if (!shouldDisplayEntry(entry, options)) {
        continue;
      }

      // Format and display
      const formatted = formatLogEntry(entry, { mode, useColor: true });

      if (formatted.shouldDisplay && formatted.output) {
        console.log(formatted.output);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  // Display summary footer (unless in json mode)
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
async function followLogs(filePath: string, options: LogsOptions): Promise<void> {
  const mode: VerbosityMode = options.json ? "json" : "normal";

  // Display existing logs first
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

  // Now watch for new lines
  let lastSize = (await Bun.file(filePath).stat()).size;

  while (true) {
    await Bun.sleep(500);

    const currentSize = (await Bun.file(filePath).stat()).size;

    if (currentSize > lastSize) {
      // File has grown, read new content
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
function shouldDisplayEntry(entry: LogEntry, options: LogsOptions): boolean {
  // Story filter
  if (options.story && entry.storyId !== options.story) {
    return false;
  }

  // Level filter
  if (options.level) {
    const entryPriority = LOG_LEVEL_PRIORITY[entry.level];
    const filterPriority = LOG_LEVEL_PRIORITY[options.level];

    if (entryPriority < filterPriority) {
      return false;
    }
  }

  return true;
}

/**
 * Format duration in milliseconds
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}
