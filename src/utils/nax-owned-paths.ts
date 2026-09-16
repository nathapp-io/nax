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
 * dependency-free module is the shared definition for these two consumers, so
 * `src/tools/` need not import from `src/review/` (which would trip
 * check:import-cycles). It is not the sole place in the tree that spells a nax
 * exclude: pre-existing sites still hardcode their own `:!` forms.
 */

/**
 * Long-form excludes for the Git tool's default (no explicit paths) view.
 *
 * The second pattern needs the explicit `:(glob)` magic: without it git does
 * not treat a leading `**` as a cross-directory glob, so the nested form
 * matched only the repository root and left `packages/app/.nax/...` visible —
 * the leak this fix closes (#2007). The trailing `**` after the directory is
 * what excludes its contents. Real-git verified; do not "simplify" the
 * `:(glob,exclude)` prefix away.
 */
export const NAX_OWNED_GIT_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nax", ":(glob,exclude)**/.nax/**"];

/** Short-form excludes for the review diff collector (`collectDiff` & friends). */
export const NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS: readonly string[] = [":!.nax/", ":!.nax-pids"];

/**
 * Repository-root-anchored excludes, for a collector whose cwd varies.
 *
 * The two sets above are interpreted relative to git's cwd, which is fine for
 * their consumers: the review collectors run at the story workdir and mean
 * "this package's artifacts". The story-fragment collector cannot use them —
 * its cwd is the repo root for a single-package repo and a package dir for a
 * monorepo story, but its OUTPUT is repo-rooted and is read by a *different*
 * story in a *different* package. Run from `packages/lib`, a cwd-relative
 * exclude hides `packages/lib/.nax/` and leaves the repo-root `.nax/` visible,
 * so the same fragment gained or lost entries depending on which package
 * happened to produce it (#2072).
 *
 * `top` anchors each pattern at the repository root, so the set is identical
 * from either cwd. `glob` is still required for the nested pattern — without
 * it git does not treat a leading `**` as a cross-directory glob (same reason
 * as `NAX_OWNED_GIT_EXCLUDE_PATHSPECS` above). These exclude ONLY nax's own
 * artifacts: they must not double as a cwd scope, because a fragment names
 * where a dependency landed and a sibling package's file has to survive.
 * Real-git verified in test/integration/pipeline/completion-fragment-paths.test.ts.
 */
export const NAX_OWNED_TOP_EXCLUDE_PATHSPECS: readonly string[] = [
  ":(top,exclude).nax",
  ":(glob,top,exclude)**/.nax/**",
  ":(top,exclude).nax-pids",
];
