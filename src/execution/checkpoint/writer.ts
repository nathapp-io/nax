/**
 * CheckpointWriter — durable append-only writer for the feature-level
 * `checkpoint.jsonl` log.
 *
 * Each `recordGreen` call serializes one `CheckpointRecord` as a single
 * newline-terminated JSON line and forwards it to the injected `_deps.append`.
 * The writer does not perform any I/O of its own; the caller provides an
 * `append` implementation (typically backed by `node:fs/promises.appendFile`
 * or an equivalent O_APPEND-safe write).
 */

import { rename } from "node:fs/promises";
import { NaxError } from "@/errors";
import { errorMessage } from "@/utils/errors";
import type { PhaseKind } from "../story-orchestrator";
import type { CheckpointRecord, CheckpointWriterDeps, TreeState } from "./types";

export interface CheckpointWriterOptions {
  filePath: string;
  runId: string;
  _deps: CheckpointWriterDeps;
}

/**
 * Default on-disk append — Bun-native content write (no `writer()` FileSink,
 * which opens truncated: reusing it across the whole run would destroy any
 * checkpoint history from a prior run before `loadCheckpoints` ever gets to
 * read it). Reads existing content (if any) and rewrites the file with the
 * new line appended, so a fresh writer never truncates a checkpoint another
 * story is still relying on for resume.
 *
 * The rewrite itself is made atomic via write-to-`.tmp` + `rename()`: a
 * direct `Bun.write(filePath, ...)` truncates the destination before writing
 * the new bytes, so a crash mid-write can corrupt or shorten a file that
 * already held durable history for prior green phases — exactly the crash
 * this feature exists to survive. `rename()` is atomic on POSIX filesystems,
 * so a crash during the write leaves either the old file intact or the full
 * new file, never a partial one. `rename` has no Bun-native equivalent, so
 * it's imported from `node:fs/promises` (same precedent as
 * `src/execution/status-file.ts`).
 */
async function defaultAppend(filePath: string, line: string): Promise<void> {
  const file = Bun.file(filePath);
  const existing = (await file.exists()) ? await file.text() : "";
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, existing + line);
  await rename(tmpPath, filePath);
}

/** Construct a `CheckpointWriter` bound to the real Bun-native append. */
export function createCheckpointWriter(filePath: string, runId: string): CheckpointWriter {
  return new CheckpointWriter({ filePath, runId, _deps: { append: defaultAppend } });
}

export class CheckpointWriter {
  private readonly filePath: string;
  private readonly runId: string;
  private readonly deps: CheckpointWriterDeps;
  /**
   * Serializes `_deps.append` calls. `defaultAppend` is a read-modify-write
   * (no true O_APPEND primitive is exposed for `Bun.file`), so two concurrent
   * `recordGreen` calls — from two stories running in parallel mode via the
   * same shared writer — could each read the file before either writes back,
   * silently losing one story's record. Chaining every append onto this
   * promise forces them to run one at a time regardless of caller concurrency.
   * Always resolves (errors are swallowed here) so one failed write does not
   * permanently wedge the queue for subsequent calls; the failure is still
   * propagated to that call's own caller below.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CheckpointWriterOptions) {
    this.filePath = options.filePath;
    this.runId = options.runId;
    this.deps = options._deps;
  }

  /**
   * Append a single `CheckpointRecord` describing a green phase for the given
   * story. Awaits the injected append so callers can guarantee durability
   * before reporting success.
   */
  async recordGreen(storyId: string, phase: PhaseKind, tree: TreeState): Promise<void> {
    const record: CheckpointRecord = {
      storyId,
      phase,
      headSha: tree.headSha,
      dirtyDigest: tree.dirtyDigest,
      runId: this.runId,
      ts: Date.now(),
    };
    const line = `${JSON.stringify(record)}\n`;
    const task = this.queue.then(() => this.deps.append(this.filePath, line));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      await task;
    } catch (err) {
      throw new NaxError(
        `[checkpoint] Failed to record green phase for ${storyId}@${phase}: ${errorMessage(err)}`,
        "CHECKPOINT_WRITE_FAILED",
        { stage: "checkpoint", storyId, phase, filePath: this.filePath, cause: err },
      );
    }
  }
}
