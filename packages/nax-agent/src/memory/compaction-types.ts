/**
 * The compaction contract: the shapes one confirmed compaction is planned, applied and
 * undone with, and the two constants the whole surface is spelled with.
 *
 * A plan is what a model proposes and a person confirms: the notes to retire, each with a
 * justification, and the merges that fold several notes into one. It carries no id, no
 * timestamps and no counts — those belong to the result of an apply, so a plan a preview
 * showed is the value the apply is given. The result and the undo result report only what
 * changed (slugs and note counts), never note bodies: the archive holds the originals, and
 * a value that reached a session transcript is not a backup.
 *
 * `MEMORY_COMPACTION_SOURCE` is the `source` a merged note carries, so a note this feature
 * wrote is recognisable in the index and at a provider. `MEMORY_COMPACTION_ID_RE` is both
 * the shape an id is minted in — a UTC timestamp plus six hex characters, which sorts by
 * creation time as text — and the name check the archive prunes and an undo resolves by,
 * so a directory that is not one of ours is never read as a compaction.
 */

/** The label a note a compaction wrote carries as its `source`. */
export const MEMORY_COMPACTION_SOURCE = "nax-compact";

/** A compaction id: `YYYYMMDDThhmmssZ-` and six hex characters, e.g. `20261125T101500Z-3fa2c1`. */
export const MEMORY_COMPACTION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/**
 * One note a plan retires, and why. The reason is not decoration: it is the justification
 * the forget this retire enqueues is delivered with.
 */
export interface MemoryCompactionRetire {
  readonly slug: string;
  readonly reason: string;
}

/**
 * Several notes folded into one: the sources that go, and the note that replaces them.
 * `into.type` is the type its sources already share — a merge never mixes types.
 */
export interface MemoryCompactionMerge {
  readonly from: readonly string[];
  readonly into: {
    readonly slug: string;
    readonly type: "project" | "reference";
    readonly description: string;
    readonly body: string;
  };
}

/** What a compaction does to the mirror: retire these notes, merge those. */
export interface MemoryCompactionPlan {
  readonly retire: readonly MemoryCompactionRetire[];
  readonly merge: readonly MemoryCompactionMerge[];
}

/** Whether a plan may be applied; an invalid plan carries every reason, not only the first. */
export type MemoryCompactionPlanCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** What an apply did, and how the mirror's note count moved. */
export interface MemoryCompactionResult {
  readonly id: string;
  readonly retired: readonly string[];
  readonly merged: readonly { readonly from: readonly string[]; readonly into: string }[];
  readonly notesBefore: number;
  readonly notesAfter: number;
}

/** What an undo did: the notes it wrote back, and the merged notes it removed. */
export interface MemoryUndoResult {
  readonly id: string;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
}
