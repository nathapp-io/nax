/**
 * Runs CLI Commands
 *
 * Display run history from JSONL log files.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger";
import type { LogEntry } from "../logger/types";

/**
 * Options for runs list command.
 */
export interface RunsListOptions {
  /** Feature name */
  feature: string;
  /** Project directory */
  workdir: string;
}

/**
 * Options for runs show command.
 */
export interface RunsShowOptions {
  /** Run ID to display */
  runId: string;
  /** Feature name */
  feature: string;
  /** Project directory */
  workdir: string;
}

/**
 * Parse JSONL log file and extract run events.
 *
 * @param logPath - Path to .jsonl log file
 * @returns Array of log entries
 */
async function parseRunLog(logPath: string): Promise<LogEntry[]> {
  const logger = getLogger();
  try {
    const content = await Bun.file(logPath).text();
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as LogEntry);
  } catch (err) {
    logger.warn("cli", "Failed to parse run log", { logPath, error: (err as Error).message });
    return [];
  }
}

/**
 * List all runs for a feature.
 *
 * @param options - Command options
 *
 * @example
 * ```bash
 * nax runs list -f auth-system
 * ```
 */
export async function runsListCommand(options: RunsListOptions): Promise<void> {
  const logger = getLogger();
  const { feature, workdir } = options;

  const runsDir = join(workdir, "nax", "features", feature, "runs");

  if (!existsSync(runsDir)) {
    logger.info("cli", "No runs found for feature", { feature, hint: `Directory not found: ${runsDir}` });
    return;
  }

  // List all .jsonl files in runs directory
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));

  if (files.length === 0) {
    logger.info("cli", "No runs found for feature", { feature });
    return;
  }

  logger.info("cli", `Runs for ${feature}`, { count: files.length });

  // Parse each run file and extract run.start event
  for (const file of files.sort().reverse()) {
    const logPath = join(runsDir, file);
    const entries = await parseRunLog(logPath);

    // Find run.start and run.complete events
    const startEvent = entries.find((e) => e.message === "run.start");
    const completeEvent = entries.find((e) => e.message === "run.complete");

    if (!startEvent) {
      logger.warn("cli", "Run log missing run.start event", { file });
      continue;
    }

    const runId = startEvent.data?.runId || file.replace(".jsonl", "");
    const startedAt = startEvent.timestamp;
    const status = completeEvent ? "completed" : "in-progress";
    const totalCost = completeEvent?.data?.totalCost || 0;
    const storiesCompleted = completeEvent?.data?.storiesCompleted || 0;
    const totalStories = completeEvent?.data?.totalStories || 0;

    logger.info("cli", `  ${runId}`, {
      status,
      startedAt,
      totalCost,
      storiesCompleted,
      totalStories,
    });
  }
}

/**
 * Show detailed information for a specific run.
 *
 * @param options - Command options
 *
 * @example
 * ```bash
 * nax runs show run-20260220-103045 -f auth-system
 * ```
 */
export async function runsShowCommand(options: RunsShowOptions): Promise<void> {
  const logger = getLogger();
  const { runId, feature, workdir } = options;

  const logPath = join(workdir, "nax", "features", feature, "runs", `${runId}.jsonl`);

  if (!existsSync(logPath)) {
    logger.error("cli", "Run not found", { runId, feature, logPath });
    process.exit(1);
  }

  const entries = await parseRunLog(logPath);

  // Find key events
  const startEvent = entries.find((e) => e.message === "run.start");
  const completeEvent = entries.find((e) => e.message === "run.complete");
  const storyEvents = entries.filter((e) => e.stage === "execution" && e.data?.storyId);

  if (!startEvent) {
    logger.error("cli", "Run log missing run.start event", { runId });
    process.exit(1);
  }

  // Display run summary
  logger.info("cli", `Run: ${runId}`, {
    feature,
    startedAt: startEvent.timestamp,
    completedAt: completeEvent?.timestamp,
    status: completeEvent ? "completed" : "in-progress",
  });

  if (completeEvent) {
    logger.info("cli", "Run Summary", {
      totalStories: completeEvent.data?.totalStories,
      storiesCompleted: completeEvent.data?.storiesCompleted,
      storiesFailed: completeEvent.data?.storiesFailed,
      totalCost: completeEvent.data?.totalCost,
      totalDurationMs: completeEvent.data?.totalDurationMs,
    });
  }

  // Display per-story events
  logger.info("cli", "Story Events", { count: storyEvents.length });
  for (const event of storyEvents) {
    logger.info("cli", `  ${event.data?.storyId}: ${event.message}`, {
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}
