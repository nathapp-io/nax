/**
 * Modified-Files Section
 *
 * Renders `story.modifiedFiles` — the existing files the spec explicitly
 * authorises this story to change, extracted from its `### Modifies` block
 * (src/prd/modifies-extract.ts).
 *
 * This block exists to break one specific deadlock. When a story's own correct
 * change makes an existing assertion fail, an implementer with no authorisation
 * has exactly two moves: leave the suite red, or revert its change until the old
 * assertion passes again. nax has been observed taking the second (#1450). The
 * spec author's reason is carried verbatim precisely because the useful content
 * is the specifics — which test, which assertion, what the new invariant is.
 *
 * Rendered as its own labelled block rather than folded into the description,
 * for the same reason the out-of-scope block is: an authorisation read as a task
 * becomes busywork, and this list is permission, never instruction.
 */

import type { ModifiedFileEntry } from "@/prd/types";

/**
 * Imperative block for a story-implementing role. Returned as lines so callers
 * can spread it into an existing section array; `[]` when the story carries no
 * authorisations.
 *
 * An entry whose `reason` is empty renders as a bare path — the spec author
 * listed one without a rationale, and a permission with no stated reason is
 * still a permission.
 */
export function buildModifiedFilesLines(entries: readonly ModifiedFileEntry[] | undefined): string[] {
  if (!entries || entries.length === 0) return [];
  return [
    "",
    "**Existing files this story is authorised to modify:**",
    ...entries.map((entry) => (entry.reason ? `- \`${entry.path}\` — ${entry.reason}` : `- \`${entry.path}\``)),
    "",
    "These files already exist and this story's change is expected to break them. You are permitted to",
    "update them to match the new behaviour. If an assertion in one of them fails against an",
    "implementation you believe is correct, update the assertion — do NOT revert your change to make the",
    "old assertion pass. This list is permission, not a task: touch these files only if your change",
    "actually requires it.",
  ];
}
