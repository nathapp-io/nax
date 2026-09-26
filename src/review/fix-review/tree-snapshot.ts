/**
 * Working-tree snapshot helpers for the scoped fix review (US-002).
 *
 * The scoped fix review (ADR-033) judges only what a fix pass changed *in the
 * working tree*, and neither existing collector can say that: the diff helpers
 * in `src/review/diff-utils.ts` are hard-wired to `<ref>..HEAD`, while
 * `captureWorkingTreeChanges` (`src/utils/git.ts`) collapses every git failure
 * to `[]` and lists every untracked file, pre-existing ones included.
 *
 * Contract (US-002):
 * - `snapshotWorkingTree` — tree id of the current working tree (tracked +
 *   untracked, `.gitignore` honoured). Mutates nothing: the repository's own
 *   index and working tree are exactly as they were found, so a caller can
 *   snapshot a tree that already holds staged changes.
 * - `changedPathsBetween` — repo-root-relative paths that differ between two
 *   tree-ishes, with no rename detection.
 * - `diffBetween` — unified diff between two tree-ishes, excluding paths under
 *   `.nax/`.
 * - All three throw `NaxError` with code `FIX_REVIEW_GIT_FAILED` on a non-zero
 *   git exit, so an empty result can never mean "git failed".
 *
 * STUBS (US-002 RED state): every body below returns a placeholder of the right
 * shape. The implementer supplies the real git work.
 */

/** Tree id of the current working tree (tracked + untracked, `.gitignore` honoured). Mutates nothing. */
export async function snapshotWorkingTree(_workdir: string): Promise<string> {
  return "";
}

/** Repo-root-relative paths that differ between two tree-ishes (no rename detection). */
export async function changedPathsBetween(_workdir: string, _from: string, _to: string): Promise<string[]> {
  return [];
}

/** Unified diff between two tree-ishes, excluding paths under `.nax/`. */
export async function diffBetween(_workdir: string, _from: string, _to: string): Promise<string> {
  return "";
}
