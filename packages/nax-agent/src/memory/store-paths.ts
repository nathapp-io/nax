/**
 * Where a mirror's files live: the one spelling of the store's directory layout.
 *
 * This is a leaf on purpose. `store.ts` is the only module that acts on these paths, but
 * it is also the module that has to stay inside the source size limit — the layout, the
 * five file names only it uses and the "no user directory" normalisation are a coherent
 * unit that can be read and tested without a store, so they live here and `store.ts`
 * re-exports the type.
 *
 * `dirOrNull` is the one rule a caller's input needs: `undefined`, `null` and `""` all mean
 * "this store has no user directory", so every consumer of `MemoryStorePaths.userDir` sees
 * `null` rather than three spellings of absent.
 */
import { join } from "node:path";

/** The generated index each scope carries. */
export const INDEX_FILE = "MEMORY.md";
/** The directory each scope's note files sit in. */
export const NOTES_DIR = "notes";
/** The project's decision mirror, one JSON object per line. */
export const DECISIONS_FILE = "decisions.jsonl";
/** The sync loop's cursors and its last error. */
export const SYNC_STATE_FILE = "sync.json";
/** The forgets a proposal queued and has not yet delivered. */
export const PENDING_FORGETS_FILE = "pending-forgets.jsonl";

/** The files this store owns, spelled out once so every caller agrees on them. */
export interface MemoryStorePaths {
  readonly projectDir: string;
  readonly userDir: string | null;
  readonly index: string;
  readonly notesDir: string;
  readonly decisions: string;
  readonly pendingForgets: string;
  readonly syncState: string;
  readonly lock: string;
  readonly outboxDir: string;
  readonly userIndex: string | null;
  readonly userNotesDir: string | null;
}

/** `undefined`, `null` and `""` all mean "this store has no user directory". */
export function dirOrNull(dir: string | null | undefined): string | null {
  return dir === undefined || dir === null || dir === "" ? null : dir;
}

/** Every path one mirror owns, from the two directories the caller gave. */
export function memoryStorePaths(projectDir: string, userDir: string | null): MemoryStorePaths {
  return {
    projectDir,
    userDir,
    index: join(projectDir, INDEX_FILE),
    notesDir: join(projectDir, NOTES_DIR),
    decisions: join(projectDir, DECISIONS_FILE),
    pendingForgets: join(projectDir, PENDING_FORGETS_FILE),
    syncState: join(projectDir, SYNC_STATE_FILE),
    lock: join(projectDir, "sync.lock"),
    outboxDir: join(projectDir, "outbox"),
    userIndex: userDir === null ? null : join(userDir, INDEX_FILE),
    userNotesDir: userDir === null ? null : join(userDir, NOTES_DIR),
  };
}
