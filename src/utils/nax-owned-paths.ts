/**
 * nax-owned paths, in the two pathspec forms its consumers need.
 *
 * nax writes run state under `.nax/` (and process scratch under `.nax-pids`),
 * and that state is git-tracked during a run. An unscoped `git status`/`diff`
 * therefore reports it as the agent's own changes — nax#2007. Two callers hide
 * it, and they need different syntax:
 *
 * - The read-only Git TOOL scopes its DEFAULT view with long-form `:(exclude)`
 *   pathspecs (consumer: `src/tools/git.ts`). The long form is preferred there
 *   because it is what lands in the tool-audit ledger and it reads clearly.
 * - The review diff collector scopes `git diff` with git's short `:!` form
 *   (consumer: `src/review/diff-utils.ts`'s `ALWAYS_EXCLUDED`).
 *
 * The two forms are NOT mechanically derivable from one another (`:!` has no
 * leading-doublestar equivalent, and the review set also covers `.nax-pids`),
 * so both are stored here rather than "simplified" into one. This neutral,
 * dependency-free module is the single source of truth so `src/tools/` need not
 * import from `src/review/` (which would trip check:import-cycles) and the
 * strings cannot drift apart.
 */

/** Long-form excludes for the Git tool's default (no explicit paths) view. */
export const NAX_OWNED_GIT_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nax", ":(exclude)**/.nax"];

/** Short-form excludes for the review diff collector (`collectDiff` & friends). */
export const NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS: readonly string[] = [":!.nax/", ":!.nax-pids"];
