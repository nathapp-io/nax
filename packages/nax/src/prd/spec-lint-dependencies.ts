/**
 * Spec lint — does a spec say what each story depends on?
 *
 * A story's dependencies decide when it may run. When a spec states them, the
 * grammar reads them (`./spec-structure-grammar`) and the plan's own gate
 * enforces them (`findSpecStructureViolations`). When a spec says NOTHING,
 * `dependsOn` is legitimately undefined — and there is no error anywhere: the
 * planner is free to schedule the story first, and an author who simply forgot
 * to write the line is told nothing (#2459).
 *
 * That silence is what this check costs. `Dependencies: US-001.` was read by
 * neither the `Depends on` phrase nor the label form, so a story that DID
 * declare a dependency landed in the same silent state as one that forgot —
 * the motivation for closing #2459 rather than leaving it as an authoring
 * complaint.
 *
 * It is a WARN, deliberately outside `BLOCKING_SPEC_LINT_CODES`. Not every spec
 * is ordered: two stories in the same package with no shared file genuinely
 * have no dependency, and refusing to plan them would be the undeployable gate
 * that `BLOCKING_SPEC_LINT_CODES` exists to avoid. The finding is the nudge.
 *
 * The check reads the structure the plan reads (`extractSpecStructure`) rather
 * than re-parsing the lines: a linter that disagrees with the tool it guards is
 * worse than no linter.
 */

import type { SpecLintFinding } from "./spec-lint";
import { extractSpecStructure } from "./spec-structure";

/**
 * One story in this spec states nothing about its dependencies.
 *
 * The message names the three phrasings the grammar reads, because the whole
 * failure mode is an author who wrote a fourth one (`Depends: US-001`,
 * `### Dependencies`) that extracts to nothing.
 */
const STORY_DEPENDENCIES_NOT_STATED = "story-dependencies-not-stated";

function findingFor(storyId: string): SpecLintFinding {
  return {
    level: "warn",
    code: STORY_DEPENDENCIES_NOT_STATED,
    message: `${storyId} states no dependencies: write "Depends on US-00N", "No dependencies." or "Dependencies: US-00N" on its story line`,
  };
}

/**
 * Warn, once per story, when a spec that declares multiple stories leaves a
 * story's dependencies unstated.
 *
 * Three states are told apart, exactly as the grammar does. `dependsOn` `[]`
 * means the story said "no dependencies" and is silent here; `undefined` means
 * it said nothing. A story that said two contradictory things also has
 * `undefined`, but it carries a `dependsOn` warning from the same structure —
 * reporting it twice would bury the actionable message under a restatement.
 *
 * Fewer than two stories returns nothing: with one story there is no ordering
 * to get wrong, and every single-story spec would otherwise carry a warning
 * nobody can act on.
 */
export function checkStoryDependencies(text: string): SpecLintFinding[] {
  const structure = extractSpecStructure(text);
  if (structure.stories.length < 2) return [];

  const alreadyWarned = new Set(
    structure.warnings.filter((warning) => warning.field === "dependsOn").map((warning) => warning.storyId),
  );

  return structure.stories
    .filter((story) => story.dependsOn === undefined && !alreadyWarned.has(story.id))
    .map((story) => findingFor(story.id));
}
