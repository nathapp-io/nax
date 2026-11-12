import { redactSecrets } from "@nathapp/nax-agent/internal";
import type { PRD } from "./types";

export interface PrdSecretShape {
  readonly storyId: string;
  readonly field: string;
}

/** Injectable boundary for the shared redactor. */
export const _secretShapesDeps = { redactSecrets };

/** Find secret-shaped story strings without retaining or changing their contents. */
export function findPrdSecretShapes(prd: PRD, scope?: ReadonlySet<string>): PrdSecretShape[] {
  const findings: PrdSecretShape[] = [];
  for (const story of prd.userStories) {
    if (scope && !scope.has(story.id)) continue;
    const fields: Array<[string, string]> = [
      ["title", story.title],
      ["description", story.description],
      ...story.acceptanceCriteria.map((value, index): [string, string] => [`acceptanceCriteria[${index}]`, value]),
    ];
    for (const [field, value] of fields) {
      if (_secretShapesDeps.redactSecrets(value) !== value) findings.push({ storyId: story.id, field });
    }
  }
  return findings;
}
