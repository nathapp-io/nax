/**
 * Deterministic fix-scope classification (US-002, ADR-033 §1).
 *
 * The scope half of the scoped fix review: given the repo-root-relative paths a
 * fix changed, decide whether every non-test file among them is one the story
 * was already authorised to touch. No LLM call is made when this fails.
 *
 * The allowed set is the union of `storyFiles`, `getContextFiles(story)`,
 * `getExpectedFiles(story)`, `story.modifiedFiles[].path` (all repo-root-relative,
 * ADR-032) and each finding's `file` joined onto `packageDirRel`. A changed path
 * is exempt when `isTestFile` matches it or it lies under `.nax/`.
 */

import type { Finding } from "@/findings";
import { getContextFiles, getExpectedFiles, type UserStory } from "@/prd";

export interface FixScopeInput {
  /** Repo-root-relative paths the fix changed. */
  readonly changedFiles: readonly string[];
  /** Repo-root-relative paths the story had changed before the fix; undefined when unknown. */
  readonly storyFiles: readonly string[] | undefined;
  readonly story: Pick<UserStory, "contextFiles" | "relevantFiles" | "expectedFiles" | "modifiedFiles">;
  /** Seeding findings; `file` is workdir-relative (src/findings/types.ts). */
  readonly findings: readonly Pick<Finding, "file">[];
  /** The story package dir relative to the repo root; "" at the root. */
  readonly packageDirRel: string;
  readonly isTestFile: (repoRelPath: string) => boolean;
}

export interface FixScopeResult {
  readonly inScope: boolean;
  readonly outOfScopeFiles: readonly string[];
  /** True when storyFiles was undefined and the check did not run. */
  readonly skipped: boolean;
}

/**
 * Build the set of repo-root-relative paths the story was already authorised
 * to touch — pre-fix edits the story made, files it declared, and files its
 * seeding findings named. Pure set arithmetic, no git, no I/O.
 */
function buildAllowedSet(input: FixScopeInput): Set<string> {
  const allowed = new Set<string>();

  for (const path of input.storyFiles ?? []) allowed.add(path);
  for (const path of getContextFiles(input.story as UserStory)) allowed.add(path);
  for (const path of getExpectedFiles(input.story as UserStory)) allowed.add(path);
  for (const entry of input.story.modifiedFiles ?? []) allowed.add(entry.path);

  // Seeding findings carry a `file` that is workdir-relative (ADR-021). The
  // scope check runs at the repo root, so the package dir is joined onto the
  // finding's path. An empty `packageDirRel` joins without a stray separator —
  // the package dir is the repo root, the workdir is the repo root, and the
  // finding's path is already repo-root-relative.
  const packagePrefix = input.packageDirRel === "" ? "" : `${input.packageDirRel}/`;
  for (const finding of input.findings) {
    if (finding.file !== undefined) allowed.add(`${packagePrefix}${finding.file}`);
  }

  return allowed;
}

/**
 * A path is `.nax/` when it IS `.nax` or starts with `.nax/`. `docs/.nax-notes.md`
 * and `.nax-backup/state.json` are NOT under `.nax/` — only the bare `.nax/`
 * directory and anything beneath it. A simple prefix on the string would let
 * those through; the slash keeps the boundary at the directory.
 */
function isUnderNaxDir(path: string): boolean {
  return path === ".nax" || path.startsWith(".nax/");
}

export function checkFixScope(input: FixScopeInput): FixScopeResult {
  // ADR-033 §1: when the caller does not know what the story had changed, the
  // scope check has nothing to compare against. Skip rather than synthesise a
  // verdict — a false positive here would block a fix that is actually in
  // scope, which is worse than an ungraded verdict.
  if (input.storyFiles === undefined) {
    return { inScope: true, outOfScopeFiles: [], skipped: true };
  }

  const allowed = buildAllowedSet(input);
  const outOfScope: string[] = [];

  for (const path of input.changedFiles) {
    // `.nax/` is nax's own artefact directory — every run touches it, and the
    // fix review should never count a `.nax/` edit as scope creep. The
    // directory-segment boundary is important: `docs/.nax-notes.md` is a real
    // source path the story might or might not own.
    if (isUnderNaxDir(path)) continue;
    // A test file is exempt — fixing a test the story wrote is the normal
    // TDD loop, never scope creep. The classifier gets the repo-root-relative
    // path (the spelling the rest of the check operates on), not a path
    // re-spelled into the package dir.
    if (input.isTestFile(path)) continue;
    if (allowed.has(path)) continue;
    outOfScope.push(path);
  }

  return { inScope: outOfScope.length === 0, outOfScopeFiles: outOfScope, skipped: false };
}
