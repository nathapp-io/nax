/**
 * Curator Rollup — streaming prune (#1430)
 *
 * `nax curator gc` used to read the whole rollup into a string, split it into
 * one array entry per line, and `JSON.parse` every entry — all live at once,
 * then rewrite with a single `writeFile`. On a real machine the rollup reached
 * 618 MB / 1.13M rows, so the one command that exists to shrink an oversized
 * rollup was the one operation that could not run on one.
 *
 * Both passes here stream. Memory is bounded by the run-id set (thousands of
 * short strings), never by the file. The rewrite goes to a sibling temp file and
 * is `rename`d over the original, matching the write-tmp + rename pattern used
 * by `src/execution/status-file.ts` — an interruption mid-write leaves the
 * original rollup intact rather than truncating it.
 */

import { rename, unlink, writeFile } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { streamJsonlLines } from "./jsonl-stream";
import type { Observation } from "./types";

/**
 * Bytes of pruned output buffered before flushing to the temp file.
 *
 * One `appendFile` per line would be a syscall per row (1.13M on the real
 * rollup); one flush for everything would rebuild the unbounded string this
 * module exists to avoid.
 */
const FLUSH_BYTES = 4 * 1024 * 1024;

/** Outcome of a prune. Byte counts are of the rewritten file, not the original. */
export interface PruneResult {
  /** Rows written to the new rollup. */
  kept: number;
  /** Rows dropped. */
  dropped: number;
  /** Rows preserved because they parsed but belong to another project. */
  keptOtherProjects: number;
  /**
   * Rows preserved because they carry no `projectKey` (pre-#1429 history) or did
   * not parse. Dropping either would discard data on evidence we do not have.
   */
  keptUnattributed: number;
}

/** Stream a JSONL file line by line without materialising it. */
function streamLines(filePath: string): AsyncGenerator<string> {
  return streamJsonlLines(Bun.file(filePath));
}

/**
 * Pass 1 — the newest timestamp per run id, for this project only.
 *
 * Only run ids are retained, so memory is bounded by run count rather than row
 * count. Rows that do not parse, or that belong to another project, are ignored
 * here and preserved by {@link pruneRollup}.
 *
 * @returns run ids newest-first, by their latest observation timestamp
 */
export async function scanProjectRunIds(rollupPath: string, projectKey: string): Promise<string[]> {
  const maxTsByRunId = new Map<string, string>();
  for await (const line of streamLines(rollupPath)) {
    if (!line.trim()) continue;
    let obs: Observation;
    try {
      obs = JSON.parse(line) as Observation;
    } catch {
      continue;
    }
    if (obs.projectKey !== projectKey) continue;
    const existing = maxTsByRunId.get(obs.runId);
    if (existing === undefined || obs.ts > existing) maxTsByRunId.set(obs.runId, obs.ts);
  }
  return [...maxTsByRunId.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)).map(([runId]) => runId);
}

export interface PruneRollupInput {
  rollupPath: string;
  /** Rows belonging to this project are the only ones eligible for dropping. */
  projectKey: string;
  /** Run ids of this project to keep. Everything else of this project's is dropped. */
  keepRunIds: ReadonlySet<string>;
  /**
   * When true, rows carrying no `projectKey` are dropped too. Off by default:
   * they predate #1429 and belong to no project, so no single project's `gc`
   * gets to decide their fate. The machine-wide sweep opts in explicitly.
   */
  dropUnattributed?: boolean;
}

/**
 * Pass 2 — rewrite the rollup, keeping everything not explicitly dropped.
 *
 * Preservation is the default for anything we cannot positively attribute: rows
 * of other projects, rows without a `projectKey`, and rows that fail to parse.
 * A parse failure is a reason to keep a row, not to discard it — we cannot tell
 * whose it is.
 */
export async function pruneRollup(input: PruneRollupInput): Promise<PruneResult> {
  const { rollupPath, projectKey, keepRunIds, dropUnattributed = false } = input;
  const tmpPath = `${rollupPath}.gc-tmp`;
  // Truncating creation, not append: a temp file left by an interrupted earlier
  // run would otherwise be appended to. It must also happen UNCONDITIONALLY —
  // when every row is dropped the buffer never flushes, and a temp file created
  // only on first flush would leave the rename below with nothing to rename.
  // That is the real `--sweep-unattributed` case: a rollup written entirely
  // before #1429 has no attributable row, so `keepRunIds` is empty and the
  // correct result is an empty rollup, not ENOENT.
  await writeFile(tmpPath, "");

  const result: PruneResult = { kept: 0, dropped: 0, keptOtherProjects: 0, keptUnattributed: 0 };
  let buffer = "";

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    await appendFile(tmpPath, buffer);
    buffer = "";
  };

  try {
    for await (const line of streamLines(rollupPath)) {
      if (!line.trim()) continue;

      let obs: Observation | null = null;
      try {
        obs = JSON.parse(line) as Observation;
      } catch {
        obs = null;
      }

      let keep: boolean;
      if (obs === null) {
        keep = !dropUnattributed;
        if (keep) result.keptUnattributed++;
      } else if (obs.projectKey === undefined) {
        keep = !dropUnattributed;
        if (keep) result.keptUnattributed++;
      } else if (obs.projectKey !== projectKey) {
        keep = true;
        result.keptOtherProjects++;
      } else {
        keep = keepRunIds.has(obs.runId);
      }

      if (!keep) {
        result.dropped++;
        continue;
      }
      result.kept++;
      buffer += `${line}\n`;
      if (buffer.length >= FLUSH_BYTES) await flush();
    }
    await flush();
    await rename(tmpPath, rollupPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return result;
}
