/**
 * host-index.ts — the index a host renders, and the projection a save is measured against.
 *
 * The index is one render (`renderMemoryIndex`) over both scopes, the project's decisions,
 * the notes a pending forget still holds and the byte cap the config sets. It lives here
 * rather than in `host.ts` because two callers need it: `renderIndex`, which hands a session
 * its snapshot, and the `indexOverflows` hook a save is checked against — which is the same
 * render with one note added to its own scope's list.
 *
 * That projection is the whole reason the hook can be exact. A note the mirror does not hold
 * yet is in neither of the host's lists, and a repository note of the same slug is still in
 * the project scope until the mirror's own note shadows it — so the projection adds the new
 * note to the list its scope renders and drops the repository note it would shadow. Counting
 * the line the save is about to replace would refuse a save the index can hold; counting the
 * new note nowhere would let a save past a cap it is already over.
 *
 * Every type it needs comes from `host.ts` type-only: those imports are erased, so this leaf
 * cannot join an initialisation cycle with the module that calls it.
 *
 * Internal to `src/memory/`: the host answers `renderIndex` with `readIndex` and hands
 * `createIndexOverflows` to its write surface.
 */
import { type MemoryNote, type RenderedMemoryIndex, renderMemoryIndex } from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import type { HostInput, HostReads } from "./host";
import { readForgetPendingKeys } from "./host-forget-keys";

/** Slug order, as code points: the one order every note listing is served in. */
function bySlug(left: MemoryNote, right: MemoryNote): number {
  return byCodePoint(left.slug, right.slug);
}

/**
 * The index a session starts with: feature 1's renderer over both scopes, the project's
 * decisions, the keys a pending forget holds and the byte cap the config sets. Every part is
 * read now — the index is a snapshot, not a view.
 */
export async function readIndex(reads: HostReads, input: HostInput): Promise<RenderedMemoryIndex> {
  const [projectNotes, userNotes, decisions, heldForgets] = await Promise.all([
    reads.notesOf("project"),
    reads.notesOf("user"),
    input.parts.store.readDecisions(),
    readForgetPendingKeys(input.parts),
  ]);
  return renderMemoryIndex({ projectNotes, userNotes, decisions, heldForgets, maxBytes: input.config.indexBytes });
}

/** The two lists an index renders, each as the surface of its scope sees it. */
interface ProjectedScopes {
  /** The project scope: the mirror's own notes, the unshadowed repository notes, and `note`. */
  readonly projectNotes: readonly MemoryNote[];
  /** The user scope: the user mirror's notes, and `note`. */
  readonly userNotes: readonly MemoryNote[];
}

/**
 * What both scopes render once `note` is saved into its own.
 *
 * A project note joins the mirror's list, and the repository note of the same slug is left
 * out: the save shadows it, so the line it renders is the line the save replaces. A user note
 * joins the user list, and nothing in the project scope moves — a user-scope slug never
 * shadows a repository note, which is project-scoped by construction. The caller asks only
 * about a slug the mirror does not hold (feature 1's save skips the guard for an overwrite),
 * so adding the note never doubles a line it already renders.
 */
async function projectedScopes(reads: HostReads, note: MemoryNote): Promise<ProjectedScopes> {
  if (note.scope === "user") {
    const [projectNotes, userNotes] = await Promise.all([reads.notesOf("project"), reads.mirrorNotes("user")]);
    return { projectNotes, userNotes: [...userNotes, note].sort(bySlug) };
  }
  const scope = await reads.projectScope();
  const unshadowed = scope.unshadowed.filter((repo) => repo.slug !== note.slug);
  return {
    projectNotes: [...scope.mirror, note, ...unshadowed].sort(bySlug),
    userNotes: await reads.mirrorNotes("user"),
  };
}

/**
 * The hook a save of a new slug is measured against: whether the index rendered with `note`
 * added to its scope drops entries off the end.
 *
 * It is the index render the session would start with, one note heavier, and nothing else —
 * so a save is refused exactly when accepting it would lose a line a session currently reads.
 */
export function createIndexOverflows(reads: HostReads, input: HostInput): (note: MemoryNote) => Promise<boolean> {
  return async (note) => {
    const [scopes, decisions, heldForgets] = await Promise.all([
      projectedScopes(reads, note),
      input.parts.store.readDecisions(),
      readForgetPendingKeys(input.parts),
    ]);
    const index = renderMemoryIndex({
      projectNotes: scopes.projectNotes,
      userNotes: scopes.userNotes,
      decisions,
      heldForgets,
      maxBytes: input.config.indexBytes,
    });
    return index.omitted > 0;
  };
}
