/**
 * Runs Command
 *
 * Reads all ~/.nax/runs/*\/meta.json entries and displays a table of runs
 * sorted by registeredAt descending. Resolves each statusPath to read the
 * live NaxStatusFile for current state. Falls back to '[unavailable]' if
 * the status file is missing or unreadable.
 *
 * Usage:
 *   nax runs [--project <name>] [--last <N>] [--status <status>]
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { NaxStatusFile } from "../execution/status-file";
import type { MetaJson } from "../pipeline/subscribers/registry";

const DEFAULT_LIMIT = 20;

/**
 * Swappable dependencies for testing (project convention: _deps over mock.module).
 */
export const _deps = {
  getRunsDir: () => join(homedir(), ".nax", "runs"),
};

export interface RunsOptions {
  /** Filter by project name */
  project?: string;
  /** Limit number of runs displayed (default: 20) */
  last?: number;
  /** Filter by run status */
  status?: "running" | "completed" | "failed" | "crashed";
}

interface RunRow {
  runId: string;
  project: string;
  feature: string;
  status: string;
  passed: number;
  total: number;
  durationMs: number;
  registeredAt: string;
}

/**
 * Format duration in milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Format ISO date to short local date string.
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

/**
 * Color a status string for terminal output.
 */
function colorStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.yellow(status);
    case "[unavailable]":
      return chalk.dim(status);
    default:
      return chalk.dim(status);
  }
}

/** Regex that matches ANSI escape sequences. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Strip ANSI escape codes to compute visible string length. */
function visibleLength(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

/**
 * Pad a string to a fixed width (left-aligned).
 */
function pad(str: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(str));
  return str + " ".repeat(padding);
}

/**
 * Display all registered runs from ~/.nax/runs/ as a table.
 *
 * @param options - Filter and limit options
 */
export async function runsCommand(options: RunsOptions = {}): Promise<void> {
  const runsDir = _deps.getRunsDir();

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    console.log("No runs found.");
    return;
  }

  const rows: RunRow[] = [];

  for (const entry of entries) {
    const metaPath = join(runsDir, entry, "meta.json");
    let meta: MetaJson;
    try {
      meta = await Bun.file(metaPath).json();
    } catch {
      continue;
    }

    // Apply project filter early
    if (options.project && meta.project !== options.project) continue;

    // Read live status file
    let statusData: NaxStatusFile | null = null;
    try {
      statusData = await Bun.file(meta.statusPath).json();
    } catch {
      // statusPath missing or unreadable — handled gracefully below
    }

    const runStatus = statusData ? statusData.run.status : "[unavailable]";

    // Apply status filter
    if (options.status && runStatus !== options.status) continue;

    rows.push({
      runId: meta.runId,
      project: meta.project,
      feature: meta.feature,
      status: runStatus,
      passed: statusData?.progress.passed ?? 0,
      total: statusData?.progress.total ?? 0,
      durationMs: statusData?.durationMs ?? 0,
      registeredAt: meta.registeredAt,
    });
  }

  // Sort newest first
  rows.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());

  // Apply limit
  const limit = options.last ?? DEFAULT_LIMIT;
  const displayed = rows.slice(0, limit);

  if (displayed.length === 0) {
    console.log("No runs found.");
    return;
  }

  // Column widths (minimum per header)
  const COL = {
    runId: Math.max(6, ...displayed.map((r) => r.runId.length)),
    project: Math.max(7, ...displayed.map((r) => r.project.length)),
    feature: Math.max(7, ...displayed.map((r) => r.feature.length)),
    status: Math.max(6, ...displayed.map((r) => visibleLength(r.status))),
    stories: 7,
    duration: 8,
    date: 11,
  };

  // Header
  const header = [
    pad(chalk.bold("RUN ID"), COL.runId),
    pad(chalk.bold("PROJECT"), COL.project),
    pad(chalk.bold("FEATURE"), COL.feature),
    pad(chalk.bold("STATUS"), COL.status),
    pad(chalk.bold("STORIES"), COL.stories),
    pad(chalk.bold("DURATION"), COL.duration),
    chalk.bold("DATE"),
  ].join("  ");

  console.log();
  console.log(header);
  console.log(
    chalk.dim("-".repeat(COL.runId + COL.project + COL.feature + COL.status + COL.stories + COL.duration + 11 + 12)),
  );

  for (const row of displayed) {
    const colored = colorStatus(row.status);
    const line = [
      pad(row.runId, COL.runId),
      pad(row.project, COL.project),
      pad(row.feature, COL.feature),
      pad(colored, COL.status + (colored.length - visibleLength(colored))),
      pad(`${row.passed}/${row.total}`, COL.stories),
      pad(formatDuration(row.durationMs), COL.duration),
      formatDate(row.registeredAt),
    ].join("  ");
    console.log(line);
  }

  console.log();
  if (rows.length > limit) {
    console.log(chalk.dim(`Showing ${limit} of ${rows.length} runs. Use --last <N> to see more.`));
    console.log();
  }
}
