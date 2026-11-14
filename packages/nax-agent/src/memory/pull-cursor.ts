/**
 * Where a scope's pull restarts.
 *
 * The cursor is the checkpoint a run resumes from: a page hands one back and the next run asks
 * from there, so a note the provider never sends again is never read again. That is right while
 * the mirror already holds what the cursor passed — and wrong the moment something makes the
 * mirror miss a note the provider still has.
 *
 * Two such things exist, and both answer the same way. A drain that parked a write the provider
 * kept refusing never delivered it, so the provider's copy of that note — which an incremental
 * pull would never send — is the one the mirror must take. A `direct` forget answered `pending`
 * is the same shape from the other side: the note was deleted when the request was queued, and
 * the provider has not retired it, so its still-active row is the mirror's only copy.
 *
 * It lives in a leaf of its own because the two callers sit on opposite sides of `delivery.ts`:
 * `sync-drain.ts` imports `applyPushed` from it, so a `delivery.ts` that imported the cursor back
 * from `sync-drain.ts` would close an import cycle. Its only imports are types, so either side
 * may depend on it. `sync-drain.ts` re-exports it, so every importer keeps its specifier.
 */
import type { MemoryStore } from "./store.ts";
import type { MemoryScope } from "./types.ts";

/**
 * Start this scope's next pull from the beginning.
 *
 * A pull skips a held key, and the cursor moves past it; that is safe only while the held write
 * is still on its way. Once it is parked or held, the provider's copy of that note — which an
 * incremental pull would never send again — is the one the mirror must take, so the scope is
 * read in full. Only the named scope's cursor moves: the other scope's progress is its own, and
 * clearing it would re-read a sequence this run learned nothing about.
 */
export async function rewindPullCursor(store: MemoryStore, scope: MemoryScope): Promise<void> {
  const state = await store.readSyncState();
  const cursor = scope === "user" ? { ...state.cursor, user: null } : { ...state.cursor, project: null };
  await store.writeSyncState({ ...state, cursor });
}
