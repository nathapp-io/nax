/**
 * Spec story structure — the ids, workdirs and dependencies a spec declares.
 *
 * A spec that lists 5 stories can be planned to 4: the planner folds one story
 * into another, and the folded story's `### Modifies` entry — the only channel
 * that authorises an implementer to update a test its change breaks — is dropped
 * as an orphan with a warn log. Nothing downstream reports the divergence, so
 * the run deadlocks against a red suite it may not touch.
 *
 * This module reads the spec's own declarations (pure, no I/O, no LLM) so the
 * plan write step can reject a PRD that diverges from them, and can backfill a
 * workdir the spec states that the planner omitted. The line grammar itself —
 * what counts as a declaring line, a `Workdir` statement, a dependency list —
 * lives in `./spec-structure-grammar`.
 *
 * Two statements a reader would find ambiguous (two Workdir values for one
 * story, or `none` beside an id list) are NOT guessed at: the field stays
 * undefined and a warning is reported, so the write step can say the field is
 * unenforced rather than enforce a coin flip.
 */

import { normalizeWorkdir } from "../utils/path-frame";
import { extractSpecModifiedFiles } from "./modifies-extract";
import { collectStoryDeclarations, GROUPED_PATH_SUBSECTION, type StoryDeclarations } from "./spec-structure-grammar";
import type { PRD } from "./types";

/** One story the spec declares, as the spec declares it. */
export interface SpecStoryStructure {
  readonly id: string;
  /** undefined = the spec states no workdir. `"."` is a stated root workdir. */
  readonly workdir?: string;
  /** undefined = the spec states nothing; [] = "no dependencies". */
  readonly dependsOn?: readonly string[];
}

/** A field the grammar could not read unambiguously, so it is not enforced. */
export interface SpecStructureWarning {
  readonly storyId: string;
  readonly field: "workdir" | "dependsOn";
  readonly message: string;
}

/** Everything `## Stories` declares, in document order. */
export interface SpecStructure {
  readonly stories: readonly SpecStoryStructure[];
  readonly warnings: readonly SpecStructureWarning[];
}

/** One way a PRD diverges from the structure its spec declares. */
export type SpecStructureViolation =
  | { readonly kind: "missing-story"; readonly storyId: string }
  | { readonly kind: "extra-story"; readonly storyId: string }
  | {
      readonly kind: "workdir-mismatch";
      readonly storyId: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: "dependencies-mismatch";
      readonly storyId: string;
      readonly expected: readonly string[];
      readonly actual: readonly string[];
    }
  | { readonly kind: "orphan-modifies"; readonly storyId: string | null; readonly path: string };

/**
 * Story ids the spec declares in `## Stories` / `## Acceptance Criteria`.
 *
 * Moved unchanged from `./spec-lint` (US-002): the linter's unknown-story check
 * and the structure gate must agree on what "the spec declares" means, so there
 * is exactly one reader of it.
 *
 * The `### Modifies` / `### Context Files` / `### Creates` / `### Seams`
 * subsections are skipped deliberately: their own `**US-00N**` group lead-ins
 * are the thing being validated, so counting them as declarations would make
 * the unknown-story check self-satisfying.
 */
export function declaredStoryIds(lines: readonly string[]): string[] {
  const ids = new Set<string>();
  let inScope = false;
  // Heading level of the grouped-path subsection being skipped; 0 = not skipping.
  // Only a heading at that level or shallower ends it: `#### US-009` inside
  // `### Modifies` is still Modifies content (#26).
  let skipLevel = 0;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inScope = /^##\s+(Stories|Acceptance Criteria)\b/i.test(line);
      skipLevel = 0;
      continue;
    }
    if (!inScope) continue;
    const level = /^(#{3,6})\s/.exec(line)?.[1]?.length;
    if (level !== undefined && (skipLevel === 0 || level <= skipLevel)) {
      skipLevel = GROUPED_PATH_SUBSECTION.test(line) ? level : 0;
    }
    if (skipLevel > 0) continue;

    const heading = /^#{1,6}\s+(US-\d+)\b/i.exec(line);
    if (heading?.[1]) {
      ids.add(heading[1].toUpperCase());
      continue;
    }
    const bold = /^\s*\*\*\s*(US-\d+)\b/i.exec(line);
    if (bold?.[1]) ids.add(bold[1].toUpperCase());
  }
  return [...ids];
}

/** One story's collected declarations, read as a structure entry plus its warnings. */
function readDeclarations(declarations: StoryDeclarations): {
  story: SpecStoryStructure;
  warnings: SpecStructureWarning[];
} {
  const { id } = declarations;
  const warnings: SpecStructureWarning[] = [];

  const workdirs = [...declarations.workdirs];
  if (workdirs.length > 1) {
    warnings.push({
      storyId: id,
      field: "workdir",
      message: `${id} states ${workdirs.length} different Workdir values (${workdirs.join(", ")}) — the spec names no single package for it, so the field is not enforced`,
    });
  }

  const conflictsWithNone = declarations.statesNone && declarations.dependencyLists.length > 0;
  if (conflictsWithNone) {
    warnings.push({
      storyId: id,
      field: "dependsOn",
      message: `${id} states both "no dependencies" and a dependency list — the spec is self-contradictory, so the field is not enforced`,
    });
  }

  // Three states, not two: `[]` is the spec SAYING "no dependencies", and
  // undefined is the spec saying nothing. Only the first is enforced.
  const stated = declarations.statesNone || declarations.dependencyLists.length > 0;
  const dependsOn = !stated || conflictsWithNone ? undefined : [...new Set(declarations.dependencyLists.flat())];

  return {
    story: {
      id,
      ...(workdirs.length === 1 ? { workdir: workdirs[0] } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    },
    warnings,
  };
}

/** Read the ids, workdirs and dependencies `## Stories` declares. */
export function extractSpecStructure(specContent: string): SpecStructure {
  const stories: SpecStoryStructure[] = [];
  const warnings: SpecStructureWarning[] = [];
  for (const declarations of collectStoryDeclarations(specContent)) {
    const read = readDeclarations(declarations);
    stories.push(read.story);
    warnings.push(...read.warnings);
  }
  return { stories, warnings };
}

/** Fill each PRD story's missing workdir from the spec. Returns the filled ids. */
export function backfillSpecWorkdirs(prd: PRD, structure: SpecStructure): { prd: PRD; backfilled: string[] } {
  const statedWorkdirs = new Map(structure.stories.map((story) => [story.id, story.workdir]));
  const backfilled: string[] = [];

  const userStories = prd.userStories.map((story) => {
    // Only an ABSENT workdir is filled. A declared value is never overwritten —
    // and "." is a declared repo root, not a spelling of absent.
    // workdir-access-allow: the backfill fills absences only; "." is a declared value it must not overwrite
    if (story.workdir !== undefined) return story;
    const workdir = statedWorkdirs.get(story.id.toUpperCase());
    if (workdir === undefined) return story;
    backfilled.push(story.id);
    return { ...story, workdir };
  });

  return { prd: { ...prd, userStories }, backfilled };
}

/** Same members, ignoring order and case — the PRD's dependency spelling is the planner's. */
function sameDependencySet(expected: readonly string[], actual: readonly string[]): boolean {
  const normalize = (ids: readonly string[]): Set<string> => new Set(ids.map((id) => id.toUpperCase()));
  const expectedSet = normalize(expected);
  const actualSet = normalize(actual);
  if (expectedSet.size !== actualSet.size) return false;
  for (const id of expectedSet) {
    if (!actualSet.has(id)) return false;
  }
  return true;
}

/** The stories one side declares and the other does not, in the order that names them. */
function storyIdViolations(
  specStories: readonly SpecStoryStructure[],
  prdStories: PRD["userStories"],
): SpecStructureViolation[] {
  const specIds = new Set(specStories.map((story) => story.id));
  const prdIds = new Set(prdStories.map((story) => story.id.toUpperCase()));
  const violations: SpecStructureViolation[] = [];
  for (const specStory of specStories) {
    if (!prdIds.has(specStory.id)) violations.push({ kind: "missing-story", storyId: specStory.id });
  }
  for (const prdStory of prdStories) {
    if (!specIds.has(prdStory.id.toUpperCase())) violations.push({ kind: "extra-story", storyId: prdStory.id });
  }
  return violations;
}

/** One spec story's workdir/dependency divergence from the PRD story of the same id. */
function fieldViolations(
  specStory: SpecStoryStructure,
  prdStory: PRD["userStories"][number],
): { workdir: SpecStructureViolation[]; dependencies: SpecStructureViolation[] } {
  const workdir: SpecStructureViolation[] = [];
  const dependencies: SpecStructureViolation[] = [];

  // A PRD story with NO workdir is not a divergence: the backfill fills it. A
  // declared value — the repo root "." included — is a stated workdir, compared
  // after normalisation, so a declared root against a spec-named package reads
  // as the mismatch it is.
  // workdir-access-allow: "." is a DECLARED root here, distinct from the absent workdir the backfill fills
  const declaredWorkdir = prdStory.workdir;
  if (
    specStory.workdir !== undefined &&
    declaredWorkdir !== undefined &&
    normalizeWorkdir(declaredWorkdir) !== normalizeWorkdir(specStory.workdir)
  ) {
    workdir.push({
      kind: "workdir-mismatch",
      storyId: specStory.id,
      expected: specStory.workdir,
      actual: declaredWorkdir,
    });
  }

  if (specStory.dependsOn !== undefined) {
    const expected = [...specStory.dependsOn];
    const actual = [...(prdStory.dependencies ?? [])];
    if (!sameDependencySet(expected, actual)) {
      dependencies.push({ kind: "dependencies-mismatch", storyId: specStory.id, expected, actual });
    }
  }
  return { workdir, dependencies };
}

/** Every way `prd` diverges from the structure `specContent` declares. */
export function findSpecStructureViolations(prd: PRD, specContent: string): SpecStructureViolation[] {
  // Enforcement is scoped to what `## Stories` declares, read by the same
  // grammar that reads workdirs and dependencies — so the guard and the
  // comparison cannot disagree on what a declaring line is (numbered bullets
  // included). A spec whose stories cannot be read (none declared, or ids
  // under Acceptance Criteria only) is not a scope to enforce — planning it is
  // unchanged, rather than reading every PRD story as an intruder.
  const structure = extractSpecStructure(specContent);
  if (structure.stories.length === 0) return [];

  const prdById = new Map(prd.userStories.map((story) => [story.id.toUpperCase(), story]));
  const violations = storyIdViolations(structure.stories, prd.userStories);
  // The two field kinds are enumerated as separate groups — every workdir
  // divergence is listed before every dependency divergence, never interleaved
  // per story, because the refusal message lists these lines in order.
  const workdirMismatches: SpecStructureViolation[] = [];
  const dependenciesMismatches: SpecStructureViolation[] = [];
  for (const specStory of structure.stories) {
    const prdStory = prdById.get(specStory.id);
    if (!prdStory) continue;
    const found = fieldViolations(specStory, prdStory);
    workdirMismatches.push(...found.workdir);
    dependenciesMismatches.push(...found.dependencies);
  }
  violations.push(...workdirMismatches, ...dependenciesMismatches);

  for (const entry of extractSpecModifiedFiles(specContent)) {
    const owner = entry.storyId?.toUpperCase() ?? null;
    if (owner === null || !prdById.has(owner)) {
      violations.push({ kind: "orphan-modifies", storyId: entry.storyId, path: entry.path });
    }
  }
  return violations;
}

/** One human-readable line naming a violation and what to do about it. */
export function formatSpecStructureViolation(violation: SpecStructureViolation): string {
  switch (violation.kind) {
    case "missing-story":
      return `${violation.storyId}: missing — the spec declares it; never merge or rename a spec story`;
    case "extra-story":
      return `${violation.storyId}: not in the spec — remove it or move its ACs back to their spec story`;
    case "workdir-mismatch":
      return `${violation.storyId}: workdir is "${violation.actual}"; the spec says "${violation.expected}"`;
    case "dependencies-mismatch":
      return `${violation.storyId}: dependencies are [${violation.actual.join(", ")}]; the spec says [${violation.expected.join(", ")}]`;
    case "orphan-modifies":
      return `Modifies "${violation.path}" (${violation.storyId ?? "unattributed"}): no PRD story owns it`;
  }
}
