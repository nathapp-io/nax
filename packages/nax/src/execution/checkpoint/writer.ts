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

// node:fs/promises exception: Bun has no native atomic-append equivalent —
// Bun.write() truncates, and reusing a `writer()` FileSink across the whole
// run would destroy checkpoint history from a prior run before
// `loadCheckpoints` ever gets to read it. `appendFile` uses O_APPEND, which
// the POSIX write(2) syscall guarantees is atomic for writes up to PIPE_BUF
// (same precedent as `src/session/scratch-writer.ts`, `src/logger/logger.ts`).
import { appendFile } from "node:fs/promises";
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
 * Default on-disk append. A prior implementation read the complete file,
 * concatenated the new line, and rewrote it via write-to-`.tmp` + `rename()`
 * for every single record — O(records²) total disk I/O and repeatedly
 * allocating increasingly large strings over a long run. `appendFile` with
 * O_APPEND writes only the new line and is atomic at the syscall level, so
 * a crash mid-write can never corrupt or shorten prior durable history.
 */
async function defaultAppend(filePath: string, line: string): Promise<void> {
  await appendFile(filePath, line, "utf8");
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
   * Serializes `_deps.append` calls. O_APPEND writes are atomic at the
   * syscall level for a single write, but two concurrent `recordGreen`
   * calls — from two stories running in parallel mode via the same shared
   * writer — could still interleave their underlying `write()` calls out of
   * program order or (for injected test `_deps`) use a non-atomic append.
   * Chaining every append onto this promise forces them to run one at a
   * time regardless of caller concurrency. Always resolves (errors are
   * swallowed here) so one failed write does not permanently wedge the
   * queue for subsequent calls; the failure is still propagated to that
   * call's own caller below.
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
