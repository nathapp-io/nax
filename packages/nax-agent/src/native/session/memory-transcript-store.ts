/**
 * An in-process `TranscriptStore` for tests and simple embedders (S3 spec 5.5).
 * Every document crossing the boundary is copied, so a caller mutating what it
 * saved or loaded cannot rewrite stored history. History is lost with the
 * process; an embedder that must resume after a restart injects a durable store.
 */

import type { TranscriptDoc, TranscriptStore, TurnMarker } from "./transcript-types.ts";

export interface MemoryTranscriptStore extends TranscriptStore {
  /** The last document `retainFailed` moved aside for `sessionId`, if any. */
  retained(sessionId: string): TranscriptDoc | undefined;
}

export function createMemoryTranscriptStore(): MemoryTranscriptStore {
  const live = new Map<string, TranscriptDoc>();
  const failed = new Map<string, TranscriptDoc>();
  const copy = (doc: TranscriptDoc | undefined): TranscriptDoc | undefined =>
    doc === undefined ? undefined : structuredClone(doc);

  return {
    load: (sessionId) => Promise.resolve(copy(live.get(sessionId)) ?? null),
    save: (sessionId, doc) => {
      live.set(sessionId, structuredClone(doc));
      return Promise.resolve();
    },
    retainFailed: (sessionId) => {
      const doc = live.get(sessionId);
      if (doc !== undefined) {
        failed.set(sessionId, doc);
        live.delete(sessionId);
      }
      return Promise.resolve();
    },
    delete: (sessionId) => {
      live.delete(sessionId);
      return Promise.resolve();
    },
    markTurn: (sessionId: string, marker: TurnMarker) => {
      const base: TranscriptDoc = live.get(sessionId) ?? { savedAt: new Date().toISOString(), messages: [] };
      live.set(sessionId, { ...base, turn: { ...marker } });
      return Promise.resolve();
    },
    retained: (sessionId) => copy(failed.get(sessionId)),
  };
}
