/**
 * US-002 — the enforcement guard reads the same grammar as the comparison.
 *
 * `findSpecStructureViolations` decides whether a spec is a scope to enforce by
 * reading `## Stories` with `extractSpecStructure` itself. These tests pin both
 * sides of that gate: a spec whose stories are numbered bullets (the AC1 shape)
 * IS enforced, and a spec whose ids sit only under Acceptance Criteria — stories
 * `## Stories` never declares — is not.
 */
import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { findSpecStructureViolations, type PRD } from "@/prd";

/** A spec whose `## Stories` is `storiesBody` and whose AC section is `acceptanceBody`. */
function specOf(storiesBody: string, acceptanceBody = `1. \`[unit]\` the behaviour holds.`): string {
  return `# SPEC: fixture

## Stories

${storiesBody}

## Acceptance Criteria

${acceptanceBody}
`;
}

/** A PRD holding exactly these story ids, each with no workdir and no dependencies. */
function prdOf(ids: readonly string[]): PRD {
  return makePRD({ userStories: ids.map((id) => makeStory({ id })) });
}

describe("findSpecStructureViolations guard (US-002)", () => {
  test("US-002: enforces a spec whose stories are numbered bullets — the numbered list is a declaration", () => {
    const spec = specOf(`1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001`);

    // The old guard read ids with a narrower grammar than the structure reader
    // (no numbered bullets), saw none, and skipped the comparison entirely — so
    // the folded US-002 was never reported.
    expect(findSpecStructureViolations(prdOf(["US-001"]), spec)).toEqual([
      { kind: "missing-story", storyId: "US-002" },
    ]);

    // A PRD that matches the numbered-bullet declarations is not flagged: the
    // gate opening must not turn into divergences that do not exist. (US-002
    // carries the dependency its bullet states; an absent workdir is backfilled,
    // not flagged.)
    const matching = makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002", dependencies: ["US-001"] })],
    });
    expect(findSpecStructureViolations(matching, spec)).toEqual([]);
  });

  test("US-002: does not enforce a spec whose ids sit only under Acceptance Criteria", () => {
    const spec = specOf(
      "Prose only — the stories are declared below.",
      `### US-001 — Core

1. \`[unit]\` the behaviour holds.`,
    );

    // `## Stories` declares nothing, so the structure cannot be read and every
    // PRD story would read as an intruder: enforcement stays off.
    expect(findSpecStructureViolations(prdOf(["US-001", "US-006"]), spec)).toEqual([]);
  });
});
