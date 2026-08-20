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

/**
 * Run artifacts written inside `<features>/<name>/`.
 *
 * Each is listed individually rather than ignoring the feature directory
 * wholesale: `spec.md`, `prd.json`, `prd-fidelity-report.md`,
 * `acceptance-meta.json` and the planning notes beside them are the feature's
 * source of truth and belong in version control. A rule that ignores the
 * whole `<features>/<name>` directory hides those too — silently, since git
 * never reports an ignored file.
 *
 * Each is prefixed with a `**` path segment so the rule also covers a monorepo
 * package's own `.nax/`, which is where nax writes when a story carries a
 * `workdir`.
 */
const FEATURE_RUN_ARTIFACTS = [
  "runs/",
  "plan/",
  "sessions/",
  "stories/",
  // Per-story context fragments, rewritten by every run. Kept in sync with
  // `fragmentPath()` in src/context/fragments/store.ts.
  "fragments/",
  "interactions/",
  "semantic-verdicts/",
  "status.json",
  "checkpoint.jsonl",
  "progress.txt",
  "acp-sessions.json",
  "acceptance-refined.json",
  // Backups the LLM-recovery path drops beside the file it rewrote.
  "*.bak",
].map((artifact) => `**/${PROJECT_FEATURES_DIR}/*/${artifact}`);

export const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  ".nax/**/runs/",
  ".nax/metrics.json",
  ...FEATURE_RUN_ARTIFACTS,
  ".nax-pids",
  ".nax-wt/",
  "**/.nax-acceptance*",
  "**/_nax_acceptance_test.py",
  "**/_nax_suggested_test.py",
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
 * Whether the file already states a position on `entry`.
 *
 * A negation (`!dist/`) counts: the user has deliberately un-ignored the path,
 * and since later rules win in gitignore syntax, appending the bare entry
 * below would silently reverse that choice on every init.
 */
function hasOpinionOn(activeLines: ReadonlySet<string>, entry: string): boolean {
  return activeLines.has(entry) || activeLines.has(`!${entry}`);
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
  const { footer = "", sectionComment = "# nax - generated files" } = options;
  // Without a header the created file is a bare list of paths, giving the
  // reader no clue where it came from. Fall back to the section comment.
  const header = options.header ?? `${sectionComment}\n`;

  const file = Bun.file(filePath);
  const existing = (await file.exists()) ? await file.text() : "";
  // A whitespace-only file has no content worth preserving; treating it as new
  // avoids emitting a section appended to a run of blank lines.
  const isNew = existing.trim().length === 0;

  const active = new Set(activeIgnoreLines(existing));
  const missing = entries.filter((entry) => !hasOpinionOn(active, entry));

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
