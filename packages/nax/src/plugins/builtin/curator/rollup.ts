/**
 * Curator Rollup — Phase 3
 *
 * Append-only rollup writer for cross-run observation aggregation.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { streamJsonlLines } from "./jsonl-stream";
import type { Observation } from "./types";

/**
 * Bytes read from the tail of the rollup on the first attempt. The rollup is
 * append-only and unbounded between `nax curator gc` runs, so the window is
 * taken from the end rather than by parsing the whole file.
 */
const INITIAL_WINDOW_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on the tail read, doubling from `INITIAL_WINDOW_TAIL_BYTES`.
 *
 * The initial read is a guess at "enough history"; it is not the window policy.
 * On a real 618 MB rollup an 8 MB tail held 2 runs where 20 were configured
 * (#1429), because pre-#1427 rows re-ingested the whole audit history and are
 * enormous. Reading further back is correct; reading without a ceiling is not,
 * since project-scoped filtering means a quiet project's 20th-newest run could
 * be arbitrarily far from the end.
 */
const MAX_WINDOW_TAIL_BYTES = 64 * 1024 * 1024;

/** Options for `readHeuristicWindow`; byte bounds are overridable for tests. */
export interface HeuristicWindowOptions {
  /** Only rows from this project are returned — see `BaseObservation.projectKey`. */
  projectKey: string;
  tailBytes?: number;
  maxTailBytes?: number;
}

export interface HeuristicWindow {
  observations: Observation[];
  /** Distinct runIds represented, newest first. */
  runIds: string[];
  /**
   * True when the byte ceiling was hit before `windowRuns` runs were found —
   * i.e. more history exists but was not read. False when the file was simply
   * exhausted: that is not truncation, there is just less history than asked for.
   */
  truncated: boolean;
  /**
   * Rows in the read span that belong to no project (pre-#1429 history). On an
   * existing rollup these dominate, so a window can be empty while the file is
   * hundreds of megabytes — reporting the count is what makes that legible
   * instead of looking like a bug.
   */
  unattributedRows: number;
}

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
  // RACE-46 (D-29): serialize with pruneRollup() via the path-keyed file
  // lock so an observation landing between GC's read pass and its
  // rename(tmpPath, rollupPath) doesn't get written to the old inode
  // and then destroyed by the rename. Telemetry loss only — but the
  // curator's whole purpose is preserving observations.
  //
  // mkdir first so the lock file can land on disk; the path-file-lock
  // requires the parent directory to exist before it can create its
  // `<path>.lock` file.
  const dir = path.dirname(rollupPath);
  await mkdir(dir, { recursive: true }).catch(() => {
    // Already-exists or read-only parent surfaces inside the locked body.
  });

  const { withPathFileLock } = await import("@/utils/path-file-lock");
  await withPathFileLock(rollupPath, () => appendToRollupUnlocked(observations, rollupPath)).catch(() => {
    // Lock-acquisition / write failures are logged below in the unlocked
    // body — never thrown because the curator must not affect run exit.
  });
}

async function appendToRollupUnlocked(observations: Observation[], rollupPath: string): Promise<void> {
  try {
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

/** Fresh each time: a shared literal would let one caller's mutation poison every later empty read. */
function emptyWindow(): HeuristicWindow {
  return { observations: [], runIds: [], truncated: false, unattributedRows: 0 };
}

interface ParsedTail {
  observations: Observation[];
  /** Rows belonging to no project — pre-#1429 history. Explains an empty window. */
  unattributed: number;
}

/**
 * Parse a tail slice, dropping the partial first line when the read started mid-file.
 *
 * Streamed rather than read into a string (#1439). The tail can be up to
 * `MAX_WINDOW_TAIL_BYTES`, and slurping it would hold the text AND a line array
 * of every row in it — the same unbounded materialisation `rollup-prune.ts`
 * streams to avoid, on a path that runs after EVERY run rather than only on
 * `gc`. Streaming leaves only this project's rows resident, which is the return
 * value anyway.
 */
async function parseTail(file: Bun.BunFile, startedMidFile: boolean, projectKey: string): Promise<ParsedTail> {
  const observations: Observation[] = [];
  let unattributed = 0;
  let first = true;
  for await (const line of streamJsonlLines(file)) {
    // The slice began mid-row, so the first line is a fragment of a row whose
    // start was never read.
    if (first) {
      first = false;
      if (startedMidFile) continue;
    }
    if (!line.trim()) continue;
    try {
      const obs = JSON.parse(line) as Observation;
      // Rows written before #1429 carry no projectKey and no way to recover
      // one, so they are dropped rather than claimed by whichever project
      // happens to be reading — that would be the contamination this prevents.
      if (obs.projectKey === projectKey) observations.push(obs);
      else if (!obs.projectKey) unattributed += 1;
    } catch {
      // Truncated or malformed line — skip it, keep the rest.
    }
  }
  return { observations, unattributed };
}

/** The last `windowRuns` distinct runIds present, walking backwards so recency wins. */
function newestRunIds(observations: Observation[], windowRuns: number): Set<string> {
  const keep = new Set<string>();
  for (let i = observations.length - 1; i >= 0 && keep.size < windowRuns; i -= 1) {
    const runId = observations[i]?.runId;
    if (runId) keep.add(runId);
  }
  return keep;
}

/**
 * Observations from this project's most recent `windowRuns` runs in the rollup.
 *
 * Heuristics that measure recurrence ACROSS features (H1) cannot run on a single
 * run's observations: collection is run-scoped and a run covers one feature, so
 * the distinct-feature count is always 1. The rollup is the cross-run record
 * this needs — and because collection is run-scoped, each finding appears in it
 * exactly once, which is what makes counting it meaningful.
 *
 * The rollup is shared by every project on the machine, so the window MUST be
 * filtered by `projectKey` before anything counts features (#1429). Reads grow
 * from the tail until enough of this project's runs are found, the file is
 * exhausted, or the ceiling is hit — the last case sets `truncated`.
 *
 * Never throws: a missing, empty, or partially corrupt rollup yields whatever
 * could be read. The curator must not affect the run's exit code.
 */
export async function readHeuristicWindow(
  rollupPath: string,
  windowRuns: number,
  options: HeuristicWindowOptions,
): Promise<HeuristicWindow> {
  const maxTail = Math.max(1, options.maxTailBytes ?? MAX_WINDOW_TAIL_BYTES);
  try {
    const file = Bun.file(rollupPath);
    if (!(await file.exists())) return emptyWindow();
    const size = file.size;

    // Floored at one byte: a zero tail would read nothing, double to zero, and
    // spin forever.
    let tail = Math.max(1, Math.min(options.tailBytes ?? INITIAL_WINDOW_TAIL_BYTES, maxTail));
    while (true) {
      const start = Math.max(0, size - tail);
      const { observations, unattributed } = await parseTail(
        start > 0 ? file.slice(start) : file,
        start > 0,
        options.projectKey,
      );
      const keep = newestRunIds(observations, windowRuns);

      const exhausted = start === 0;
      if (keep.size >= windowRuns || exhausted || tail >= maxTail) {
        return {
          observations: observations.filter((o) => keep.has(o.runId)),
          runIds: [...keep],
          truncated: keep.size < windowRuns && !exhausted,
          unattributedRows: unattributed,
        };
      }
      tail = Math.max(1, Math.min(tail * 2, maxTail));
    }
  } catch {
    return emptyWindow();
  }
}
