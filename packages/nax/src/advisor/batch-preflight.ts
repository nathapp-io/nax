/** A5 PR3: turn the batch op's raw pre-flight conflicts into menu-bound advisor questions (spec §8, P3-R2). */
import { getSafeLogger } from "../logger";
import type { RawPreflightConflict } from "../operations";
import { buildMenu } from "./menus";
import type { AdviceQuestion } from "./types";

export interface PreflightItem {
  question: AdviceQuestion;
  /** The story ids the ruling applies to (the conflict's ids that exist in the batch). */
  appliesTo: string[];
  /** The advisor's reply for this conflict, validated by the caller against `question.options`. */
  raw: Record<string, unknown>;
}

/** The conflict's AC target, only when its story is in the batch (no decision may cite a story that does not exist). */
function checkedAcRef(conflict: RawPreflightConflict, knownStoryIds: readonly string[]): RawPreflightConflict["acRef"] {
  if (!conflict.acRef) return undefined;
  if (knownStoryIds.includes(conflict.acRef.storyId)) return conflict.acRef;
  getSafeLogger()?.warn("advisor", "Pre-flight AC target names a story that is not in the batch — target dropped", {
    storyId: conflict.acRef.storyId,
    acId: conflict.acRef.acId,
    description: conflict.description,
  });
  return undefined;
}

/** The batch story ids a conflict applies to; with none listed, its AC's story when known (PR3 M2). */
function appliesToOf(conflict: RawPreflightConflict, knownStoryIds: readonly string[]): string[] {
  const kept = conflict.storyIds.filter((id) => knownStoryIds.includes(id));
  for (const dropped of conflict.storyIds.filter((id) => !knownStoryIds.includes(id))) {
    getSafeLogger()?.warn("advisor", "Pre-flight conflict names a story that is not in the batch — dropped", {
      storyId: dropped,
      description: conflict.description,
    });
  }
  if (kept.length > 0) return kept;
  const acStory = conflict.acRef?.storyId;
  if (acStory !== undefined && knownStoryIds.includes(acStory)) return [acStory];
  getSafeLogger()?.warn("advisor", "Pre-flight conflict names no story in the batch — dropped", {
    storyId: "_run",
    description: conflict.description,
  });
  return [];
}

export function preflightItems(
  conflicts: readonly RawPreflightConflict[],
  knownStoryIds: readonly string[],
  base: { feature: string; askedAtSha: string; newId: () => string },
): PreflightItem[] {
  const out: PreflightItem[] = [];
  for (const conflict of conflicts) {
    const appliesTo = appliesToOf(conflict, knownStoryIds);
    const storyId = appliesTo[0];
    if (storyId === undefined) continue;
    const acRef = checkedAcRef(conflict, knownStoryIds);
    if (conflict.acRef && !acRef && !conflict.specSection) continue;
    out.push({
      question: {
        id: base.newId(),
        askedAtSha: base.askedAtSha,
        kind: "preflight",
        feature: base.feature,
        storyId,
        summary: conflict.description,
        evidence: [
          {
            source: "spec",
            ...(conflict.specSection ? { ref: conflict.specSection } : {}),
            text: conflict.description,
          },
        ],
        options: buildMenu({
          kind: "preflight",
          ...(acRef ? { acRef } : {}),
          ...(conflict.specSection ? { specSection: conflict.specSection } : {}),
        }),
      },
      appliesTo,
      raw: conflict.raw,
    });
  }
  return out;
}
