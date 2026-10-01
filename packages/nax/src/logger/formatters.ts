import chalk from "chalk";
import { stripControlChars } from "../utils/strip-control-chars.js";
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
  let levelColor: (text: string) => string = chalk.gray;
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
    case "silent":
      levelColor = chalk.gray;
      break;
  }

  // Build base message with timestamp, stage, and optional storyId
  const parts = [chalk.gray(`[${stripControlChars(timestamp)}]`), levelColor(`[${stripControlChars(entry.stage)}]`)];

  if (entry.storyId) {
    parts.push(chalk.cyan(`[${stripControlChars(entry.storyId)}]`));
  }

  parts.push(stripControlChars(entry.message));

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
/**
 * MED-02: plain `JSON.stringify` throws on a BigInt value anywhere in the
 * entry ("Do not know how to serialize a BigInt") — a single log line with
 * one is enough to make writing it throw, losing that line (and, depending
 * on the caller, possibly more). `redactValue` already guards `entry.data`
 * against circular references, but a BigInt is a valid, non-circular leaf
 * value that JSON has no native representation for, so this is a distinct
 * failure mode with its own fallback: a replacer coerces BigInt to a
 * string tagged so it stays greppable and doesn't look like the original
 * numeric value.
 */
function jsonlReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `[BigInt] ${value.toString()}` : value;
}

export function formatJsonl(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch {
    try {
      return JSON.stringify(entry, jsonlReplacer);
    } catch (error) {
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: "error",
        stage: entry.stage,
        message: "Failed to serialize log entry",
        data: { originalMessage: entry.message, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
