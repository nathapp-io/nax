import { SECRET_VALUE_PATTERNS, type SecretValuePattern } from "@nathapp/nax-agent/internal";
import type { PRD } from "./types";

export interface PrdSecretShape {
  readonly storyId: string;
  readonly field: string;
  /** The `SECRET_VALUE_PATTERNS` kind that matched first, never the matched text. */
  readonly kind: string;
}

/**
 * The credential shapes a planner can paste into story text by accident and
 * a human can act on.
 *
 * Deliberately NOT the whole of `SECRET_VALUE_PATTERNS`: the structured kinds
 * (`assignment`, `bearer`, `basic`, `api-key-header`, `cookie`,
 * `url-credentials`) are shapes the redactor masks as part of a key/value pair,
 * and prose that mentions `TOKEN=...` or `Authorization: Bearer ...` while
 * describing a story is ordinary planning text. Reporting them produced one
 * warning per field — 37 on a single feature — which taught users to ignore the
 * warning entirely.
 */
export const PROVIDER_SECRET_KINDS: ReadonlySet<string> = new Set([
  "openai",
  "github",
  "github-pat",
  "npm",
  "aws",
  "gitlab",
  "google",
  "stripe",
  "slack",
  "telegram",
  "pem",
  "jwt",
]);

/** The allowlisted patterns, in `SECRET_VALUE_PATTERNS` order so priority is preserved. */
const PROVIDER_PATTERNS: readonly SecretValuePattern[] = SECRET_VALUE_PATTERNS.filter(({ kind }) =>
  PROVIDER_SECRET_KINDS.has(kind),
);

/**
 * The kind of the first provider-format pattern `value` matches, or `undefined`.
 *
 * `lastIndex` is reset before every test: these patterns carry the `/g` flag for
 * `String.replace`, so a stale index from an earlier call would silently skip a
 * match and make the second `findPrdSecretShapes` over the same PRD disagree
 * with the first.
 */
function firstProviderKind(value: string): string | undefined {
  for (const { kind, re, acceptMatch } of PROVIDER_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(value);
    if (match === null) continue;
    if (acceptMatch !== undefined && !acceptMatch(match[0])) continue;
    return kind;
  }
  return undefined;
}

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
      const kind = firstProviderKind(value);
      if (kind !== undefined) findings.push({ storyId: story.id, field, kind });
    }
  }
  return findings;
}
