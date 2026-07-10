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

import { NaxError } from "@/errors";
import { errorMessage } from "@/utils/errors";
import type { PhaseKind } from "../story-orchestrator";
import type { CheckpointRecord, CheckpointWriterDeps, TreeState } from "./types";

export interface CheckpointWriterOptions {
  filePath: string;
  runId: string;
  _deps: CheckpointWriterDeps;
}

export class CheckpointWriter {
  private readonly filePath: string;
  private readonly runId: string;
  private readonly deps: CheckpointWriterDeps;

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
    try {
      await this.deps.append(this.filePath, line);
    } catch (err) {
      throw new NaxError(
        `[checkpoint] Failed to record green phase for ${storyId}@${phase}: ${errorMessage(err)}`,
        "CHECKPOINT_WRITE_FAILED",
        { stage: "checkpoint", storyId, phase, filePath: this.filePath, cause: err },
      );
    }
  }
}
