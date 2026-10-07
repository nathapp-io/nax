import type { RepositoryInstructions } from "./repository-instructions.ts";
import type { TranscriptStore } from "./transcript-types.ts";

/** Preserve instruction provenance alongside history, including compacted snapshots. */
export function instructionTranscriptStore(
  store: TranscriptStore,
  instructions: RepositoryInstructions,
): TranscriptStore {
  return {
    load: (id) => store.load(id),
    save: (id, doc) =>
      store.save(id, {
        ...doc,
        instructionSources: instructions.sources,
        instructionDirectories: instructions.directories,
      }),
    delete: (id) => store.delete(id),
    retainFailed: (id) => store.retainFailed(id),
    markTurn: (id, marker) => store.markTurn(id, marker),
  };
}
