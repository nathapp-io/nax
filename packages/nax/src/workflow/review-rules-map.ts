/**
 * US-006 (SPEC-lazy-rules-delivery) — the "## Rules for the changed files"
 * section a review package carries.
 *
 * A branch review package lists hundreds of files, and a large diff can match
 * most of a repository's rules. Telling the reviewer which rule *files* govern
 * the surviving changed files costs one line per rule and no rule body at all, so
 * the reviewer opens the file it needs and nothing else.
 *
 * The per-file answer comes from `rulesForFile` — the same resolver the
 * rule-delivery handlers (US-005) and the brief's rules index (US-003) use — so
 * layering (repo, package, override) and `appliesTo` glob matching have exactly
 * one implementation. This module owns no layer, glob or frontmatter logic.
 *
 * Paths under a `.nax/` directory are skipped, root or nested: nax's own state is
 * never governed by a rule, and it is exactly what the review package's own
 * surfaces (briefs, prds, feature records) are made of.
 *
 * The section's text lives in `src/prompts/builders/rules-index-builder.ts` per
 * the Prompt Builder Convention; this module only decides which files land in it.
 */

import { type ResolvedRule, type RulesForFileInput, rulesForFile } from "@/context/rules/rule-set";
import {
  buildChangedFileRulesSection,
  type ChangedFileRuleGroup,
  type RulesIndexEntry,
  toRulesIndexEntry,
} from "@/prompts";

/** What a review package's rule map needs to know about the run. */
export interface AppendChangedFileRulesInput {
  readonly repoRoot: string;
  /** Absolute override directory, laid out like `.nax/rules/`. */
  readonly overrideDir?: string;
  readonly overrideMode: "merge" | "replace";
}

/** The resolver seam: a test drives the map without a rules directory on disk. */
export const _reviewRulesMapDeps: { rulesForFile: typeof rulesForFile } = { rulesForFile };

/** A group being built: `paths` are appended in diff order. */
interface MutableGroup {
  readonly rule: RulesIndexEntry;
  readonly paths: string[];
}

/** `.nax/` is nax's own state — a rule never governs a read of it, root or nested. */
function isNaxPath(path: string): boolean {
  return path === ".nax" || path.startsWith(".nax/") || path.includes("/.nax/");
}

/** The resolver input for one changed path; the override keys are omitted when unset. */
function fileRuleInput(path: string, input: AppendChangedFileRulesInput): RulesForFileInput {
  return {
    repoRoot: input.repoRoot,
    path,
    ...(input.overrideDir !== undefined && { overrideDir: input.overrideDir }),
    overrideMode: input.overrideMode,
  };
}

/**
 * Add one path to its rule's group, creating the group on first sight.
 *
 * Keyed by display path rather than rule id: two layers can carry the same rule
 * id for changed files in different packages (a repo rule and that package's own
 * `packages/api/.nax/rules/<id>.md`), and each is a separate file the reviewer
 * must open, so each gets its own line.
 */
function addToGroup(groups: Map<string, MutableGroup>, rule: ResolvedRule, path: string): void {
  const existing = groups.get(rule.displayPath) ?? { rule: toRulesIndexEntry(rule), paths: [] };
  groups.set(rule.displayPath, existing);
  if (!existing.paths.includes(path)) existing.paths.push(path);
}

/**
 * The rules governing each changed path, grouped per rule, in diff order.
 *
 * Every path is resolved concurrently and the results are collected in the given
 * order, so the section's lines and example paths follow the diff.
 */
async function changedFileRuleGroups(
  changedPaths: readonly string[],
  input: AppendChangedFileRulesInput,
): Promise<ChangedFileRuleGroup[]> {
  const resolved = await Promise.all(
    changedPaths
      .filter((path) => !isNaxPath(path))
      .map(async (path) => ({
        path,
        rules: await _reviewRulesMapDeps.rulesForFile(fileRuleInput(path, input)),
      })),
  );
  const groups = new Map<string, MutableGroup>();
  for (const { path, rules } of resolved) {
    for (const rule of rules) addToGroup(groups, rule, path);
  }
  return [...groups.values()];
}

/**
 * A blank line before the appended `##` heading: without it Markdown renders the
 * heading as part of the package's last block. An empty file (or one that already
 * ends in a blank line) needs nothing.
 */
function blankLineBefore(text: string): string {
  if (text === "" || text.endsWith("\n\n")) return text;
  return text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
}

/**
 * Append the "## Rules for the changed files" section to a review package.
 *
 * `changedPaths` are the repo-relative paths a review package reports (the
 * surviving paths `writeReviewPackage` / `writeBranchReviewPackage` return). When
 * no rule governs any of them the file is left byte-identical and untouched — a
 * package with no rules to name carries no empty section.
 */
export async function appendChangedFileRules(
  packagePath: string,
  changedPaths: readonly string[],
  input: AppendChangedFileRulesInput,
): Promise<void> {
  const groups = await changedFileRuleGroups(changedPaths, input);
  if (groups.length === 0) return;
  const file = Bun.file(packagePath);
  const prior = (await file.exists()) ? await file.text() : "";
  await Bun.write(packagePath, `${blankLineBefore(prior)}${buildChangedFileRulesSection(groups)}`);
}
