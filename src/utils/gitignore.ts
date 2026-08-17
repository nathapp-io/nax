/**
 * Shared nax ignore-file entries and the reconciler that applies them.
 *
 * Two lists live here, for two different consumers:
 *  - `NAX_GITIGNORE_ENTRIES` — runtime files that must never be committed.
 *    Used by `nax init` (project .gitignore) and
 *    `WorktreeManager.ensureGitExcludes()` (.git/info/exclude — no commit,
 *    applies to all worktrees).
 *  - `NAX_NAXIGNORE_ENTRIES` — paths nax's own context engine, review and
 *    verification passes should not scan. Used by `nax init` only; read back
 *    by `src/utils/path-filters.ts`.
 *
 * `patchIgnoreFile` is the shared, additive reconciler both use.
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

/**
 * Paths excluded from nax's context, review and verification scanning.
 *
 * Deliberately generic — anything repo-specific belongs in the commented
 * suggestion block written at file creation (`NAX_NAXIGNORE_SUGGESTIONS`),
 * not here. Only the entries in this list take part in re-run reconciliation.
 */
export const NAX_NAXIGNORE_ENTRIES = [
  // nax's own state: prd.json, run logs, fragments. Feeding these back into
  // the context engine as if they were project source is pure noise.
  ".nax/",
  "dist/",
  "build/",
  "coverage/",
  "node_modules/",
];

/** Explanatory preamble, written only when `.naxignore` is first created. */
export const NAX_NAXIGNORE_HEADER = `# nax - paths excluded from context, review
# and verification scanning.
# gitignore syntax. Also honoured per-package.

`;

/**
 * Commented starting points, written only when `.naxignore` is first created.
 *
 * These stay commented so re-runs never resurrect a line the user deliberately
 * removed — the reconciler treats a comment as absent by design.
 */
export const NAX_NAXIGNORE_SUGGESTIONS = `
# Uncomment what applies to this repo:
# examples/
# fixtures/
# vendor/
# *.generated.*
`;

/** Outcome of reconciling one ignore file. */
export interface PatchIgnoreFileResult {
  /** True when the file did not exist (or held only whitespace) beforehand. */
  created: boolean;
  /** Entries actually appended; empty when the file was already complete. */
  added: string[];
}

/** Options for {@link patchIgnoreFile}. */
export interface PatchIgnoreFileOptions {
  /** Preamble written above the entries, on creation only. */
  header?: string;
  /** Trailing block written below the entries, on creation only. */
  footer?: string;
  /** Comment introducing the appended section of an existing file. */
  sectionComment?: string;
}

/**
 * Active (rule-bearing) lines of an ignore file.
 *
 * Comments and blanks are excluded deliberately: a commented-out entry means
 * the rule is NOT in force, so it must still count as missing. A substring
 * scan over the raw text would read `# dist/` as "already present" and
 * silently never apply the rule.
 */
function activeIgnoreLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Additively reconcile an ignore file against a list of entries.
 *
 * Creates the file when absent. When it exists, appends only the entries that
 * are not already active, under a marked section — user content is never
 * removed, reordered or rewritten, so the operation is idempotent.
 */
export async function patchIgnoreFile(
  filePath: string,
  entries: readonly string[],
  options: PatchIgnoreFileOptions = {},
): Promise<PatchIgnoreFileResult> {
  const { header = "", footer = "", sectionComment = "# nax - generated files" } = options;

  const file = Bun.file(filePath);
  const existing = (await file.exists()) ? await file.text() : "";
  // A whitespace-only file has no content worth preserving; treating it as new
  // avoids emitting a section appended to a run of blank lines.
  const isNew = existing.trim().length === 0;

  const active = new Set(activeIgnoreLines(existing));
  const missing = entries.filter((entry) => !active.has(entry));

  if (missing.length === 0) return { created: false, added: [] };

  if (isNew) {
    await Bun.write(filePath, `${header}${missing.join("\n")}\n${footer}`);
    return { created: true, added: [...missing] };
  }

  // Guarantee the section starts on its own line even when the existing file
  // lacks a trailing newline — otherwise the last user rule and the section
  // comment would merge and neither would match.
  const separator = existing.endsWith("\n") ? "" : "\n";
  await Bun.write(filePath, `${existing}${separator}\n${sectionComment}\n${missing.join("\n")}\n`);
  return { created: false, added: [...missing] };
}
