/**
 * Human-friendly logging formatter with verbosity levels
 *
 * Transforms JSONL log entries into readable output with emoji indicators
 * and supports multiple verbosity modes: quiet, normal, verbose, json
 */

import chalk from "chalk";
import type { LogEntry } from "../logger/types.js";
import type { AdvisoryFindingSummaryEntry } from "../review/review-audit.js";
// Leaf import (not the ../review barrel): the barrel does `export * from "./runner"`,
// which transitively pulls operations -> implement. Because src/config/loader.ts depends
// on the logger, which depends on this formatter, a barrel import here closes a circular
// __esm init cycle in the bundled build that leaves `implementerOp.config` bound to an
// undefined selector (crash: "undefined is not an object (evaluating 'selector.name')").
// severity.ts is a dependency-free leaf, so importing it directly breaks the cycle.
import { SEVERITY_RANK } from "../review/severity.js";
import { stripControlChars } from "../utils/strip-control-chars.js";
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
  // SEC-09: storyId/title are PRD-authored (planner output) — strip
  // ANSI/control chars before interpolating into a chalk-colorized line.
  const storyId = stripControlChars(String(data.storyId || entry.storyId || "unknown"));
  const title = stripControlChars(String(data.storyTitle || data.title || "Untitled story"));
  const complexity = typeof data.complexity === "string" ? data.complexity : "unknown";
  const tier = typeof data.modelTier === "string" ? data.modelTier : "unknown";
  const attempt = typeof data.attempt === "number" ? data.attempt : 1;
  const agent = typeof data.agent === "string" ? data.agent : undefined;
  const progress =
    typeof data.storyNumber === "number" && typeof data.storyTotal === "number"
      ? `${data.storyNumber}/${data.storyTotal}`
      : undefined;

  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`${EMOJI.storyStart} ${c.cyan(storyId)}: ${title}`));

  if (mode === "verbose") {
    if (progress) lines.push(`  ${c.gray("├─")} Story: ${c.cyan(progress)}`);
    lines.push(`  ${c.gray("├─")} Complexity: ${c.yellow(complexity)}`);
    lines.push(`  ${c.gray("├─")} Tier: ${c.magenta(tier)}`);
    if (agent) lines.push(`  ${c.gray("├─")} Agent: ${c.cyan(agent)}`);
    if (attempt > 1) {
      lines.push(`  ${c.gray("└─")} Attempt: ${c.yellow(`#${attempt}`)} ${EMOJI.retry}`);
    } else {
      lines.push(`  ${c.gray("└─")} Status: ${c.green("starting")}`);
    }
  } else {
    const metadata: string[] = [];
    if (progress) metadata.push(progress);
    metadata.push(complexity, tier);
    if (agent) metadata.push(agent);
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
  // SEC-09: storyId is PRD-authored; reason (below) is agent-authored escalation text.
  const storyId = stripControlChars(String(data.storyId || entry.storyId || "unknown"));
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
    lines.push(`     ${c.gray(`Reason: ${stripControlChars(String(data.reason))}`)}`);
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

  // SEC-09: storyId is PRD-authored; message routinely interpolates agent
  // stderr/output and error text — neither is ANSI/control-char sanitized
  // upstream (the logger's redaction only targets secret-shaped substrings).
  if (entry.storyId) {
    parts.push(c.dim(`[${stripControlChars(entry.storyId)}]`));
  }
  // sessionRole is a first-class LogEntry field (stripped from data by the logger);
  // render it as a tag so per-line provenance is visible without a JSONL cross-reference.
  if (entry.sessionRole) {
    parts.push(c.dim(`(${entry.sessionRole})`));
  }

  parts.push(stripControlChars(entry.message));

  let output = parts.join(" ");

  // Surface key structured fields inline in normal+ modes. The headless console
  // previously dropped agent identity, activity counts, status, and phase
  // progress even though they are already present in the JSONL.
  const data = entry.data;
  if (data && typeof data === "object") {
    const meta = buildDefaultMeta(data, mode);
    if (meta.length > 0) {
      output += `  ${c.gray(meta.join("  "))}`;
    }

    // Full data dump only in verbose mode — exclude fields already surfaced
    // above so they are not printed twice.
    if (mode === "verbose") {
      const filtered = stripConsumedMetaFields(data);
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

/** Data keys that {@link buildDefaultMeta} renders inline (excluded from the verbose JSON dump). */
const CONSUMED_META_KEYS = [
  "agentName",
  "model",
  "phaseIndex",
  "totalPhases",
  "status",
  "findingsCount",
  "messageUpdates",
  "toolCallUpdates",
  "thinkingUpdates",
  "idleMs",
  "cost",
  "durationMs",
  "action",
  "reason",
] as const;

/**
 * Build the inline metadata segment for a default log line.
 *
 * Order is fixed for scannability: identity (agent·model) → phase progress →
 * status/findings → agent-stream activity counts → cost/duration → action/reason.
 * Only present, meaningful fields are emitted, so unrelated lines stay terse.
 */
function buildDefaultMeta(data: Record<string, unknown>, mode: string): string[] {
  const meta: string[] = [];

  const identity = [data.agentName, data.model].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (identity.length > 0) meta.push(`${EMOJI.agent} ${identity.join("·")}`);

  if (typeof data.phaseIndex === "number" && typeof data.totalPhases === "number") {
    meta.push(`${data.phaseIndex}/${data.totalPhases}`);
  }

  if (typeof data.status === "string") meta.push(`status: ${data.status}`);
  if (typeof data.findingsCount === "number")
    meta.push(`${data.findingsCount} finding${data.findingsCount === 1 ? "" : "s"}`);

  const activity = buildActivityMeta(data);
  if (activity) meta.push(activity);

  if (typeof data.cost === "number" && data.cost > 0) meta.push(`${EMOJI.cost} ${formatCost(data.cost)}`);
  if (typeof data.durationMs === "number" && data.durationMs > 0)
    meta.push(`${EMOJI.duration} ${formatDuration(data.durationMs)}`);
  if (typeof data.action === "string") meta.push(`action: ${data.action}`);
  if (typeof data.reason === "string" && mode !== "quiet") meta.push(stripControlChars(data.reason));

  return meta;
}

/**
 * Compact agent-stream activity summary (message / tool-call / thinking update
 * counts + idle time). Returns null when no activity field is present so
 * non-agent-stream lines are unaffected.
 */
function buildActivityMeta(data: Record<string, unknown>): string | null {
  const segments: string[] = [];
  if (typeof data.messageUpdates === "number" && data.messageUpdates > 0) segments.push(`msg ${data.messageUpdates}`);
  if (typeof data.toolCallUpdates === "number" && data.toolCallUpdates > 0)
    segments.push(`tools ${data.toolCallUpdates}`);
  if (typeof data.thinkingUpdates === "number" && data.thinkingUpdates > 0)
    segments.push(`think ${data.thinkingUpdates}`);
  if (typeof data.idleMs === "number" && data.idleMs > 0) segments.push(`idle ${formatDuration(data.idleMs)}`);
  return segments.length > 0 ? segments.join(" ") : null;
}

/** Remove fields already rendered inline so the verbose JSON dump shows only the remainder. */
function stripConsumedMetaFields(data: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(CONSUMED_META_KEYS as readonly string[]).includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
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
 * Format the run-end advisory (sub-threshold review) findings summary.
 *
 * §2.1 — adversarial/semantic review findings below `blockingThreshold` never
 * block a story and, absent this call, only ever surface in a per-story debug
 * log line and the on-disk `.nax/review-audit/` trail. This renders them as a
 * severity-graded block so real findings are never silently dropped.
 */
export function formatAdvisorySummary(
  findings: readonly AdvisoryFindingSummaryEntry[],
  options: FormatterOptions,
): string {
  if (findings.length === 0) return "";

  const { mode, useColor = true } = options;

  if (mode === "json") {
    return JSON.stringify(findings);
  }

  const c = useColor ? chalk : createNoopChalk();
  const rank = SEVERITY_RANK as Record<string, number>;
  const sorted = [...findings].sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0));

  const lines: string[] = [];
  lines.push("");
  lines.push(c.yellow("─".repeat(60)));
  lines.push(c.bold(c.yellow(`  ${EMOJI.warning} NON-BLOCKING REVIEW FINDINGS (${findings.length})`)));
  const coverageGapCount = findings.filter((f) => f.coverageGap).length;
  if (coverageGapCount > 0) {
    lines.push(
      c.gray(
        `  ${coverageGapCount} of ${findings.length} were coverage-gap demotions (recurred past the block limit — candidate for spec/AC review)`,
      ),
    );
  }
  const noActionCount = findings.filter((f) => f.actionRequired === false).length;
  if (noActionCount > 0) {
    lines.push(
      c.gray(
        `  ${noActionCount} of ${findings.length} asked for no change (compliance notes — the best-effort fix pass skipped them)`,
      ),
    );
  }
  lines.push(c.yellow("─".repeat(60)));

  for (const f of sorted) {
    const location = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined;
    const parts = [
      `[${f.severity}]`,
      f.storyId ?? "unknown",
      location,
      f.category,
      f.coverageGap ? "coverage-gap" : undefined,
      f.actionRequired === false ? "no-action" : undefined,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    lines.push(`  ${c.gray(parts.join(" · "))}`);
    lines.push(`    ${f.issue}`);
  }

  lines.push(c.yellow("─".repeat(60)));
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
