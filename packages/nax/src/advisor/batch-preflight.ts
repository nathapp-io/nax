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

export function preflightItems(
  conflicts: readonly RawPreflightConflict[],
  knownStoryIds: readonly string[],
  base: { feature: string; askedAtSha: string; newId: () => string },
): PreflightItem[] {
  const out: PreflightItem[] = [];
  for (const conflict of conflicts) {
    const kept = conflict.storyIds.filter((id) => knownStoryIds.includes(id));
    for (const dropped of conflict.storyIds.filter((id) => !knownStoryIds.includes(id))) {
      getSafeLogger()?.warn("advisor", "Pre-flight conflict names a story that is not in the batch — dropped", {
        storyId: dropped,
        description: conflict.description,
      });
    }
    const storyId = kept[0];
    if (storyId === undefined) continue;
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
          ...(conflict.acRef ? { acRef: conflict.acRef } : {}),
          ...(conflict.specSection ? { specSection: conflict.specSection } : {}),
        }),
      },
      appliesTo: kept,
      raw: conflict.raw,
    });
  }
  return out;
}
