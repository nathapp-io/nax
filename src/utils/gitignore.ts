/**
 * Shared nax gitignore entries — runtime files that must never be committed.
 *
 * Used by:
 *  - `nax init` → appends to project .gitignore
 *  - `WorktreeManager.ensureGitExcludes()` → writes to .git/info/exclude (no commit, all worktrees)
 */

import { PROJECT_FEATURES_DIR } from "@/config";

export const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  ".nax/**/runs/",
  ".nax/metrics.json",
  `${PROJECT_FEATURES_DIR}/*/status.json`,
  `${PROJECT_FEATURES_DIR}/*/plan/`,
  // Per-story context fragments, rewritten by every run. Like the sibling
  // feature-tree entries above and below, this is subsumed by the blanket
  // `**/<features>/*/` rule further down — it is listed explicitly because a
  // repo that narrows that blanket rule to keep `prd.json` / `spec.md` under
  // version control (as the nax repo itself does) must not silently start
  // committing run artifacts. Kept in sync with `fragmentPath()` in
  // src/context/fragments/store.ts.
  `${PROJECT_FEATURES_DIR}/*/fragments/`,
  `${PROJECT_FEATURES_DIR}/*/acp-sessions.json`,
  `${PROJECT_FEATURES_DIR}/*/interactions/`,
  `${PROJECT_FEATURES_DIR}/*/progress.txt`,
  `${PROJECT_FEATURES_DIR}/*/acceptance-refined.json`,
  ".nax-pids",
  ".nax-wt/",
  "**/.nax-acceptance*",
  "**/_nax_acceptance_test.py",
  "**/_nax_suggested_test.py",
  `**/${PROJECT_FEATURES_DIR}/*/`,
  ".nax/prompt-audit/",
  // Only reached when a run has no outputDir — nax-finish normally writes its
  // audit under `~/.nax/<project>/finish-audit/`. It still must be ignored:
  // the flow's `commit_*` nodes run `git add -A`, so an un-ignored artifact
  // here lands in the feature branch's history.
  ".nax/finish-audit/",
  // In-flight mutation-spot-check journal. Same reasoning as finish-audit
  // above, and more urgent: the journal exists precisely in the window where a
  // run died mid-mutation, so a later `git add -A` is exactly what would sweep
  // it into the feature branch. Kept in sync with `journalDir()` in
  // src/verification/mutation/journal.ts.
  ".nax/mutation-journal/",
];
