import chalk from "chalk";
import type { LogEntry } from "./types.js";

/**
 * Format log entry for human-readable console output with chalk colors
 *
 * @param entry - The log entry to format
 * @returns Chalk-formatted console string
 *
 * @example
 * ```typescript
 * const entry: LogEntry = {
 *   timestamp: "2026-02-20T10:30:00.123Z",
 *   level: "info",
 *   stage: "routing",
 *   storyId: "user-auth-001",
 *   message: "Classified as simple task",
 *   data: { complexity: "simple", model: "claude-sonnet-4-5" }
 * };
 * console.log(formatConsole(entry));
 * // [10:30:00] [routing] [user-auth-001] Classified as simple task
 * ```
 */
export function formatConsole(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
  });

  // Level-specific color coding
  let levelColor: (text: string) => string;
  switch (entry.level) {
    case "error":
      levelColor = chalk.red;
      break;
    case "warn":
      levelColor = chalk.yellow;
      break;
    case "info":
      levelColor = chalk.blue;
      break;
    case "debug":
      levelColor = chalk.gray;
      break;
  }

  // Build base message with timestamp, stage, and optional storyId
  const parts = [chalk.gray(`[${timestamp}]`), levelColor(`[${entry.stage}]`)];

  if (entry.storyId) {
    parts.push(chalk.cyan(`[${entry.storyId}]`));
  }

  parts.push(entry.message);

  // Append data if present (pretty-printed on next line)
  let output = parts.join(" ");
  if (entry.data && Object.keys(entry.data).length > 0) {
    output += `\n${chalk.gray(JSON.stringify(entry.data, null, 2))}`;
  }

  return output;
}

/**
 * Format log entry as JSON Lines (JSONL) for machine-readable file output
 *
 * @param entry - The log entry to format
 * @returns Single-line JSON string
 *
 * @example
 * ```typescript
 * const entry: LogEntry = {
 *   timestamp: "2026-02-20T10:30:00.123Z",
 *   level: "info",
 *   stage: "routing",
 *   message: "Task classified"
 * };
 * console.log(formatJsonl(entry));
 * // {"timestamp":"2026-02-20T10:30:00.123Z","level":"info","stage":"routing","message":"Task classified"}
 * ```
 */
export function formatJsonl(entry: LogEntry): string {
  return JSON.stringify(entry);
}
