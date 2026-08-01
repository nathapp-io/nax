/**
 * Curator Rollup — Phase 3
 *
 * Append-only rollup writer for cross-run observation aggregation.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Observation } from "./types";

/**
 * Bytes read from the tail of the rollup when building the heuristic window.
 * The rollup is append-only and unbounded between `nax curator gc` runs, so the
 * window is taken from the end rather than by parsing the whole file.
 */
const MAX_WINDOW_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Append observations to a rollup file (JSONL format).
 *
 * Creates parent directory if needed. Appends one JSON line per observation.
 * Never throws on write errors — logs warning and continues.
 *
 * @param observations - Array of observations to append
 * @param rollupPath - Absolute path to the rollup JSONL file
 */
export async function appendToRollup(observations: Observation[], rollupPath: string): Promise<void> {
  try {
    const dir = path.dirname(rollupPath);
    await mkdir(dir, { recursive: true });

    if (observations.length === 0) {
      const f = Bun.file(rollupPath);
      if (!(await f.exists())) {
        await writeFile(rollupPath, "");
      }
      return;
    }

    const newLines = `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`;
    await appendFile(rollupPath, newLines);
  } catch {
    // Write errors are logged but never thrown — curator must not affect run exit code
  }
}

/**
 * Observations from the most recent `windowRuns` runs in the rollup.
 *
 * Heuristics that measure recurrence ACROSS features (H1) cannot run on a single
 * run's observations: collection is run-scoped and a run covers one feature, so
 * the distinct-feature count is always 1. The rollup is the cross-run record
 * this needs — and because collection is run-scoped, each finding appears in it
 * exactly once, which is what makes counting it meaningful.
 *
 * Never throws: a missing, empty, or partially corrupt rollup yields whatever
 * could be read. The curator must not affect the run's exit code.
 */
export async function readHeuristicWindow(rollupPath: string, windowRuns: number): Promise<Observation[]> {
  try {
    const file = Bun.file(rollupPath);
    if (!(await file.exists())) return [];
    const size = file.size;
    const start = Math.max(0, size - MAX_WINDOW_TAIL_BYTES);
    const text = await (start > 0 ? file.slice(start).text() : file.text());
    // A non-zero start almost certainly lands mid-line; drop the partial head.
    const lines = text.split("\n");
    if (start > 0) lines.shift();

    const observations: Observation[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        observations.push(JSON.parse(line) as Observation);
      } catch {
        // Truncated or malformed line — skip it, keep the rest.
      }
    }

    // Keep the last `windowRuns` distinct runIds, walking backwards so recency wins.
    const keep = new Set<string>();
    for (let i = observations.length - 1; i >= 0 && keep.size < windowRuns; i -= 1) {
      const runId = observations[i]?.runId;
      if (runId) keep.add(runId);
    }
    return observations.filter((o) => keep.has(o.runId));
  } catch {
    return [];
  }
}
