/**
 * US-005 — `checkStoryDependencies`, the advisory check for a story that states
 * nothing about its dependencies (#2459).
 *
 * `Depends on` and the `Dependencies:` label are both read by the grammar, but a
 * story that states neither is not an error anywhere: `nax plan` writes
 * `"dependencies": []`, the story is scheduled as if it were first, and an
 * author who simply forgot is never told (#2459). This check is the warning.
 *
 * It reads the structure the plan's own gate reads (`extractSpecStructure`) so
 * the two cannot disagree about what a story stated, and it is a WARN: a spec
 * whose stories genuinely have no ordering is legal, and the plan gate must
 * still pass — see AC-16/AC-17.
 */
import { describe, expect, test } from "bun:test";
import { checkStoryDependencies } from "@/prd";

/** A spec whose `## Stories` is `storiesBody`, with the sections real specs carry. */
function specOf(storiesBody: string): string {
  return `# SPEC: fixture

## Stories

${storiesBody}

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;
}

/** The two-story body every AC here builds on: neither story states a dependency. */
const TWO_STORIES_NO_DEPENDENCIES = `### US-001 — Core

### US-002 — API`;

const MESSAGE = (id: string) =>
  `${id} states no dependencies: write "Depends on US-00N", "No dependencies." or "Dependencies: US-00N" on its story line`;

describe("checkStoryDependencies (US-005)", () => {
  test("AC-11: warns once per story that states nothing, in story order", () => {
    const findings = checkStoryDependencies(specOf(TWO_STORIES_NO_DEPENDENCIES));

    expect(findings).toHaveLength(2);
    expect(findings[0]?.level).toBe("warn");
    expect(findings[1]?.level).toBe("warn");
    expect(findings.map((f) => f.code)).toEqual(["story-dependencies-not-stated", "story-dependencies-not-stated"]);
    // The message names the story, and nothing else in the finding does — so
    // this is how "the first is US-001 and the second US-002" is observable.
    expect(findings[0]?.message).toStartWith("US-001 states no dependencies:");
    expect(findings[1]?.message).toStartWith("US-002 states no dependencies:");
  });

  test("AC-11 boundary: a story that states a dependency is not warned about", () => {
    const spec = specOf(`### US-001 — Core

Dependencies: none.

### US-002 — API`);

    const findings = checkStoryDependencies(spec);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toStartWith("US-002 states no dependencies:");
  });

  test("AC-12: the finding carries the exact fix, naming all three accepted phrasings", () => {
    const findings = checkStoryDependencies(specOf(TWO_STORIES_NO_DEPENDENCIES));

    expect(findings[1]).toEqual({
      level: "warn",
      code: "story-dependencies-not-stated",
      message: MESSAGE("US-002"),
    });
  });

  test("AC-13: returns nothing when both stories state their dependencies", () => {
    const spec = specOf(`### US-001 — Core

No dependencies.

### US-002 — API

Dependencies: US-001.`);

    expect(checkStoryDependencies(spec)).toEqual([]);
  });

  test("AC-14: returns nothing for a story whose conflicting statements already warn", () => {
    const spec = specOf(`### US-001 — Core

No dependencies.

### US-002 — API

Dependencies: none

Depends on US-001`);

    // `dependsOn` is undefined here, but the story DID state something — the
    // spec contradicts itself, and the grammar's own conflict warning is the
    // actionable message. A second one would bury it.
    expect(checkStoryDependencies(spec)).toEqual([]);
  });

  test("AC-15: returns nothing on a single-story spec, where ordering says nothing", () => {
    const spec = specOf("### US-001 — Core");

    expect(checkStoryDependencies(spec)).toEqual([]);
    // Positive control: the same story body with a second story IS checked, so
    // the empty result above is the story count and not a dead check.
    expect(checkStoryDependencies(specOf(TWO_STORIES_NO_DEPENDENCIES))).toHaveLength(2);
  });
});
