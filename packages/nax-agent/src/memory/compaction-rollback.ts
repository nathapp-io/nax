/** Recovery of one failed apply, still under the mirror's writer lock. */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { type MemoryCompactionManifest, restoreCompactionLog, writeCompactionManifest } from "./compaction-archive.ts";
import { refreshIndex } from "./operations-support.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryNote } from "./types.ts";

/** Record attempts before I/O: a call can throw after it has published its bytes. */
export interface CompactionStaging {
  readonly writtenSlugs: Set<string>;
  readonly enqueuedIds: Set<string>;
  /** Undefined until append is about to begin; null means there was no log. */
  logBefore?: Uint8Array | null;
}

/** Chain the original fault both through Error.cause and the package's structured context. */
export function compactionFailed(cause: unknown, context: Record<string, unknown> = {}): NaxError {
  return Object.assign(
    new NaxError("memory compaction failed", "MEMORY_COMPACT_FAILED", {
      stage: "memory",
      cause,
      ...context,
    }),
    { cause },
  );
}

/**
 * Try every repair even if another repair failed. In particular, a broken note write must
 * not strand a deliverable outbox entry or a failed log record. Report once, never replace
 * the original apply error with a recovery or logging error.
 */
export async function rollbackCompaction(input: {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: AgentLogger;
  readonly originals: readonly MemoryNote[];
  readonly manifest: MemoryCompactionManifest;
  readonly staging: CompactionStaging;
}): Promise<boolean> {
  const failures: unknown[] = [];
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  const originalSlugs = new Set(input.originals.map((note) => note.slug));
  for (const slug of input.staging.writtenSlugs) {
    if (!originalSlugs.has(slug)) await attempt(() => input.store.deleteNote("project", slug));
  }
  for (const note of input.originals) await attempt(() => input.store.writeNote(note));
  for (const clientId of input.staging.enqueuedIds) await attempt(() => input.outbox.remove(clientId));
  const logBefore = input.staging.logBefore;
  if (logBefore !== undefined) await attempt(() => restoreCompactionLog(input.store, logBefore));
  await attempt(() =>
    writeCompactionManifest({ store: input.store, manifest: { ...input.manifest, status: "rolled_back" } }),
  );
  await attempt(() => refreshIndex(input));
  if (failures.length === 0) return true;
  try {
    input.logger.error("memory", "memory compaction rollback incomplete", {
      id: input.manifest.id,
      projectDir: input.store.paths.projectDir,
      errors: failures.map(errorMessage),
    });
  } catch {
    // Logging must not mask the original apply failure either.
  }
  return false;
}
