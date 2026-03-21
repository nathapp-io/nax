/**
 * Logs command implementation
 *
 * Displays run logs with filtering, follow mode, and multiple output formats.
 * Uses resolveProject() for directory resolution and formatter for output.
 *
 * Re-exports reader and formatter modules for backward compatibility.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel } from "../logger/types";
import { resolveProject } from "./common";
import { displayLogs, displayRunsList, followLogs } from "./logs-formatter";
import { resolveRunFileFromRegistry, selectRunFile } from "./logs-reader";

// Re-exports for backward compatibility
export { _deps } from "./logs-reader";
export { extractRunSummary, resolveRunFileFromRegistry, selectRunFile } from "./logs-reader";
export { displayLogs, displayRunsList, followLogs, formatDuration } from "./logs-formatter";

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
 * Display logs with filtering and formatting
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
  const naxDir = join(resolved.projectDir, ".nax");

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
