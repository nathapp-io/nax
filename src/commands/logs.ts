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
import { resolveProject, resolveSingleFeature } from "./common";
import { displayLogs, displayRunsList, followLogs } from "./logs-formatter";
import { resolveRunFileFromRegistry, selectRunFile } from "./logs-reader";

// Re-exports for backward compatibility
export { _logsReaderDeps as _deps } from "./logs-reader";
export { extractRunSummary, resolveRunFileFromRegistry, selectRunFile } from "./logs-reader";
export { displayLogs, displayRunsList, followLogs, formatDuration } from "./logs-formatter";
export type { FollowLogsDeps } from "./logs-formatter";

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
  /**
   * Abort signal forwarded to follow mode. No production caller sets this
   * today — `bin/nax.ts` does not wire SIGINT to it — so this seam is
   * currently exercised only by tests. Wiring a real SIGINT handler in
   * the CLI entry point is a separate, out-of-scope concern.
   */
  signal?: AbortSignal;
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
      await followLogs(runFile, options, { signal: options.signal });
    } else {
      await displayLogs(runFile, options);
    }
    return;
  }

  // Resolve project directory
  const resolved = resolveProject({ dir: options.dir });
  const naxDir = join(resolved.projectDir, ".nax");

  // config.json never carries a feature field — derive the single feature from
  // .nax/features/* (BUG-02). `logs` has no -f/--feature flag (-f is --follow here),
  // so the only way to disambiguate is -r/--run against the central run registry.
  const featureName = resolveSingleFeature(naxDir, "pass -r <runId> (see `nax runs list`)");

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
    await followLogs(runFile, options, { signal: options.signal });
    return;
  }

  // Display static logs
  await displayLogs(runFile, options);
}
