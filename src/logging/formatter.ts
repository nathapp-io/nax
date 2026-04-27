/**
 * Human-friendly logging formatter with verbosity levels
 *
 * Transforms JSONL log entries into readable output with emoji indicators
 * and supports multiple verbosity modes: quiet, normal, verbose, json
 */

import chalk from "chalk";
import type { LogEntry } from "../logger/types.js";
import { EMOJI, type FormatterOptions, type RunSummary } from "./types.js";

/**
 * Formatted output entry
 */
export interface FormattedEntry {
  /** Formatted string ready for console output */
  output: string;
  /** Whether this entry should be shown in the current verbosity mode */
  shouldDisplay: boolean;
}

/**
 * Format a timestamp to local timezone HH:MM:SS
 */
export function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format duration in milliseconds to human-readable format
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format cost in dollars
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Check if entry should be displayed based on verbosity mode
 */
function shouldDisplay(entry: LogEntry, mode: string): boolean {
  if (mode === "json") return true;
  if (mode === "quiet") {
    // Only show critical events: run start/end, story pass/fail
    return (
      entry.stage === "run.start" ||
      entry.stage === "run.end" ||
      entry.stage === "story.complete" ||
      entry.level === "error"
    );
  }
  if (mode === "verbose") return true;

  // Normal mode: filter out debug logs, but always show story.start/iteration.start
  if (entry.stage === "story.start" || entry.stage === "iteration.start") return true;
  return entry.level !== "debug";
}

/**
 * Format a log entry for human-readable output
 *
 * Supports different verbosity modes and styling options
 */
export function formatLogEntry(entry: LogEntry, options: FormatterOptions): FormattedEntry {
  const { mode, useColor = true } = options;

  // JSON mode: pass through raw JSONL
  if (mode === "json") {
    return {
      output: JSON.stringify(entry),
      shouldDisplay: true,
    };
  }

  // Check if should display based on mode
  if (!shouldDisplay(entry, mode)) {
    return {
      output: "",
      shouldDisplay: false,
    };
  }

  const timestamp = formatTimestamp(entry.timestamp);
  const colorize = useColor ? chalk : createNoopChalk();

  // Handle special stages with custom formatting
  if (entry.stage === "run.start") {
    return formatRunStart(entry, colorize, timestamp, mode);
  }

  if (entry.stage === "story.start" || entry.stage === "iteration.start") {
    return formatStoryStart(entry, colorize, timestamp, mode);
  }

  if (entry.stage === "story.complete" || entry.stage === "agent.complete") {
    return formatStoryComplete(entry, colorize, timestamp, mode);
  }

  if (entry.stage.includes("tdd") && entry.message.startsWith("→ Session:")) {
    return formatTDDSession(entry, colorize, timestamp, mode);
  }

  // Default formatting for other entries
  return formatDefault(entry, colorize, timestamp, mode);
}

/**
 * Format run start event
 */
function formatRunStart(entry: LogEntry, c: ChalkLike, timestamp: string, _mode: string): FormattedEntry {
  const data = entry.data as Record<string, unknown>;
  const lines: string[] = [];

  lines.push("");
  lines.push(c.bold(c.blue("═".repeat(60))));
  lines.push(c.bold(c.blue(`  ${EMOJI.storyStart} NAX RUN STARTED`)));
  lines.push(c.blue("═".repeat(60)));
  lines.push(`  ${c.gray("Time:")}     ${timestamp}`);
  lines.push(`  ${c.gray("Feature:")}  ${c.cyan(String(data.feature || "unknown"))}`);
  lines.push(`  ${c.gray("Run ID:")}   ${c.dim(String(data.runId || "unknown"))}`);
  lines.push(`  ${c.gray("Workdir:")}  ${c.dim(String(data.workdir || "."))}`);
  lines.push(c.blue("═".repeat(60)));
  lines.push("");

  return {
    output: lines.join("\n"),
    shouldDisplay: true,
  };
}

/**
 * Format story start event
 */
function formatStoryStart(entry: LogEntry, c: ChalkLike, _timestamp: string, mode: string): FormattedEntry {
  const data = entry.data as Record<string, unknown>;
  const storyId = String(data.storyId || entry.storyId || "unknown");
  const title = String(data.storyTitle || data.title || "Untitled story");
  const complexity = typeof data.complexity === "string" ? data.complexity : "unknown";
  const tier = typeof data.modelTier === "string" ? data.modelTier : "unknown";
  const attempt = typeof data.attempt === "number" ? data.attempt : 1;

  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`${EMOJI.storyStart} ${c.cyan(storyId)}: ${title}`));

  if (mode === "verbose") {
    lines.push(`  ${c.gray("├─")} Complexity: ${c.yellow(complexity)}`);
    lines.push(`  ${c.gray("├─")} Tier: ${c.magenta(tier)}`);
    if (attempt > 1) {
      lines.push(`  ${c.gray("└─")} Attempt: ${c.yellow(`#${attempt}`)} ${EMOJI.retry}`);
    } else {
      lines.push(`  ${c.gray("└─")} Status: ${c.green("starting")}`);
    }
  } else {
    const metadata = [complexity, tier];
    if (attempt > 1) metadata.push(`attempt #${attempt} ${EMOJI.retry}`);
    lines.push(`  ${c.gray(metadata.join(" • "))}`);
  }

  return {
    output: lines.join("\n"),
    shouldDisplay: true,
  };
}

/**
 * Format story completion event
 */
function formatStoryComplete(entry: LogEntry, c: ChalkLike, _timestamp: string, mode: string): FormattedEntry {
  const data = entry.data as Record<string, unknown>;
  const storyId = String(data.storyId || entry.storyId || "unknown");
  const success = data.success ?? true;
  const cost =
    typeof data.cost === "number" ? data.cost : typeof data.estimatedCostUsd === "number" ? data.estimatedCostUsd : 0;
  const duration = typeof data.durationMs === "number" ? data.durationMs : 0;
  const action = data.finalAction || data.action;

  const emoji = success ? EMOJI.success : action === "escalate" ? EMOJI.retry : EMOJI.failure;
  const statusColor = success ? c.green : action === "escalate" ? c.yellow : c.red;
  const status = success ? "PASSED" : action === "escalate" ? "ESCALATED" : "FAILED";

  const lines: string[] = [];
  lines.push(statusColor(`  ${emoji} ${c.bold(storyId)}: ${status}`));

  if (mode === "verbose" || mode === "normal") {
    const metadata: string[] = [];
    if (cost > 0) metadata.push(`${EMOJI.cost} ${formatCost(cost)}`);
    if (duration > 0) metadata.push(`${EMOJI.duration} ${formatDuration(duration)}`);
    if (metadata.length > 0) {
      lines.push(`     ${c.gray(metadata.join("  "))}`);
    }
  }

  if (mode === "verbose" && data.reason) {
    lines.push(`     ${c.gray(`Reason: ${data.reason}`)}`);
  }

  lines.push("");

  return {
    output: lines.join("\n"),
    shouldDisplay: true,
  };
}

/**
 * Format TDD session start
 */
function formatTDDSession(entry: LogEntry, c: ChalkLike, _timestamp: string, mode: string): FormattedEntry {
  if (mode === "quiet") {
    return { output: "", shouldDisplay: false };
  }

  const data = entry.data as Record<string, unknown>;
  const role = typeof data.role === "string" ? data.role : "unknown";
  const roleLabel = role.replace(/-/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase());

  return {
    output: `  ${c.gray("│")}  ${EMOJI.tdd} ${c.cyan(roleLabel)}`,
    shouldDisplay: true,
  };
}

/**
 * Format default log entry
 */
function formatDefault(entry: LogEntry, c: ChalkLike, timestamp: string, mode: string): FormattedEntry {
  const levelEmoji = entry.level === "error" ? EMOJI.failure : entry.level === "warn" ? EMOJI.warning : EMOJI.info;
  const levelColor = entry.level === "error" ? c.red : entry.level === "warn" ? c.yellow : c.gray;
  const parts = [c.gray(`[${timestamp}]`), levelColor(`${levelEmoji} ${entry.stage}`)];

  if (entry.storyId) {
    parts.push(c.dim(`[${entry.storyId}]`));
  }

  parts.push(entry.message);

  let output = parts.join(" ");

  // Always show key data fields (cost, duration, action, reason) in normal+ modes
  const data = entry.data;
  if (data && typeof data === "object") {
    const meta: string[] = [];
    if (typeof data.cost === "number" && data.cost > 0) meta.push(`${EMOJI.cost} ${formatCost(data.cost)}`);
    if (typeof data.durationMs === "number" && data.durationMs > 0)
      meta.push(`${EMOJI.duration} ${formatDuration(data.durationMs)}`);
    if (typeof data.action === "string") meta.push(`action: ${data.action}`);
    if (typeof data.reason === "string" && mode !== "quiet") meta.push(data.reason);
    if (meta.length > 0) {
      output += `  ${c.gray(meta.join("  "))}`;
    }

    // Full data dump only in verbose mode
    if (mode === "verbose") {
      // biome-ignore lint/suspicious/noExplicitAny: Intentional spread to filter known fields
      const { cost: _c, durationMs: _d, action: _a, reason: _r, ...filtered } = data as any;
      if (Object.keys(filtered).length > 0) {
        output += `\n${c.gray(JSON.stringify(filtered, null, 2))}`;
      }
    }
  }

  return {
    output,
    shouldDisplay: true,
  };
}

/**
 * Format run summary footer
 */
export function formatRunSummary(summary: RunSummary, options: FormatterOptions): string {
  const { mode, useColor = true } = options;

  if (mode === "json") {
    return JSON.stringify(summary);
  }

  const c = useColor ? chalk : createNoopChalk();
  const lines: string[] = [];

  lines.push("");
  lines.push(c.blue("═".repeat(60)));
  lines.push(c.bold(c.blue(`  ${EMOJI.storyComplete} RUN SUMMARY`)));
  lines.push(c.blue("═".repeat(60)));

  const successRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : "0.0";
  const statusColor = summary.failed === 0 ? c.green : summary.passed > summary.failed ? c.yellow : c.red;

  lines.push(`  ${c.gray("Total:")}    ${c.bold(summary.total.toString())}`);
  lines.push(`  ${c.green(`${EMOJI.success} Passed:`)}  ${c.bold(summary.passed.toString())}`);

  if (summary.failed > 0) {
    lines.push(`  ${c.red(`${EMOJI.failure} Failed:`)}  ${c.bold(summary.failed.toString())}`);
  }

  if (summary.skipped > 0) {
    lines.push(`  ${c.yellow(`${EMOJI.skip} Skipped:`)} ${c.bold(summary.skipped.toString())}`);
  }

  lines.push(`  ${c.gray("Success:")}  ${statusColor(c.bold(`${successRate}%`))}`);
  lines.push(c.blue("─".repeat(60)));
  lines.push(`  ${EMOJI.duration} Duration: ${c.bold(formatDuration(summary.durationMs))}`);
  lines.push(`  ${EMOJI.cost} Cost:     ${c.bold(formatCost(summary.totalCost))}`);
  lines.push(c.blue("═".repeat(60)));
  lines.push("");

  return lines.join("\n");
}

/**
 * Chalk-like interface for no-op mode (no colors)
 */
interface ChalkLike {
  bold: (s: string) => string;
  dim: (s: string) => string;
  gray: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
}

/**
 * Create a no-op chalk instance (returns strings unchanged)
 */
function createNoopChalk(): ChalkLike {
  const noop = (s: string) => s;
  return {
    bold: noop,
    dim: noop,
    gray: noop,
    red: noop,
    green: noop,
    yellow: noop,
    blue: noop,
    magenta: noop,
    cyan: noop,
  };
}
