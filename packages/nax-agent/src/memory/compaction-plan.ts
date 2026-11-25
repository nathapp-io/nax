/**
 * Compaction candidates: the notes a plan may act on, before anyone has proposed one.
 *
 * The rule is deliberately narrow, because everything it lets through is a note a person
 * can lose. A candidate is what the *project* mirror holds, still `active`, of type
 * `project` or `reference`, and not already on its way out through a queued forget. That
 * leaves the note kinds a compaction must never touch untouched:
 *
 * - a `feedback` or `user` note is a standing instruction, not project knowledge that goes
 *   stale, and rewriting it would change how the agent behaves rather than what it knows;
 * - a user-scope note belongs to the person across every project, so one project's
 *   compaction has no standing to fold it;
 * - a `pending` note is one already awaiting a decision — retiring it would decide it;
 * - a note a queued forget already holds is going regardless, so listing it would let a
 *   plan take credit for work the outbox is doing and archive a note nobody chose to lose;
 * - decisions and repository notes are not in the mirror at all (the index and the host
 *   hold them), so they are out of reach here by construction rather than by a check.
 *
 * The answer is in slug order so the same mirror always produces the same candidate list,
 * and a plan built from it is reproducible rather than dependent on directory read order.
 */
import { byCodePoint } from "#src/internal/sort";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import { type MemoryNote, type MemoryNoteType, memoryNoteKey } from "./types.ts";

/** The two note types a compaction may rewrite: project knowledge and the references to it. */
const COMPACTABLE_TYPES: ReadonlySet<MemoryNoteType> = new Set<MemoryNoteType>(["project", "reference"]);

/** Whether one listed note may be acted on, given the keys a queued forget already holds. */
function isCandidate(note: MemoryNote, heldForgets: ReadonlySet<string>): boolean {
  if (note.scope !== "project") return false;
  if (note.status !== "active") return false;
  if (!COMPACTABLE_TYPES.has(note.type)) return false;
  return !heldForgets.has(memoryNoteKey(note.scope, note.slug));
}

/**
 * The notes a compaction may act on, in slug order.
 *
 * `store.listNotes("project")` is a listing, not a promise: a failing scope answers `[]`,
 * and a note whose frontmatter declares another scope is still returned. The `scope` check
 * is therefore part of the rule, not a restatement of the listing.
 */
export async function memoryCompactionCandidates(input: {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
}): Promise<readonly MemoryNote[]> {
  const projectNotes = await input.store.listNotes("project");
  const heldForgets = await input.outbox.heldKeys("forget");
  return projectNotes.filter((note) => isCandidate(note, heldForgets)).sort((a, b) => byCodePoint(a.slug, b.slug));
}
