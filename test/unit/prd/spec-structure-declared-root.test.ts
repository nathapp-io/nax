/**
 * US-002 — a DECLARED workdir is never conflated with an absent one.
 *
 * `storyPackageDir` reads "." and absent as the same "names no package" answer —
 * the right selector for consumers that want a package. The spec-structure
 * decisions need the distinction the selector erases: the backfill fills only an
 * absent workdir, and the mismatch check compares every stated one, the repo
 * root included. These tests pin both sides of that line.
 */
import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { backfillSpecWorkdirs, findSpecStructureViolations, type SpecStructure } from "@/prd";

/** A spec whose `## Stories` is `storiesBody`, with the sections real specs carry. */
function specOf(storiesBody: string): string {
  return `# SPEC: fixture

## Stories

${storiesBody}

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;
}

describe("declared root workdir (US-002)", () => {
  const specStatingWorkdir = specOf(`### US-004 — API

- Workdir: apps/api`);

  test("fills an omitted workdir when the spec explicitly declares the repo root", () => {
    const structure: SpecStructure = { stories: [{ id: "US-004", workdir: "." }], warnings: [] };
    const prd = makePRD({ userStories: [makeStory({ id: "US-004" })] });

    const result = backfillSpecWorkdirs(prd, structure);

    expect(result.prd.userStories[0]?.workdir).toBe(".");
    expect(result.backfilled).toEqual(["US-004"]);
    expect(prd.userStories[0]?.workdir).toBeUndefined();
  });

  test("US-002: the backfill leaves a story that declared the repo root alone", () => {
    const structure: SpecStructure = { stories: [{ id: "US-004", workdir: "apps/api" }], warnings: [] };
    const prd = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "." })] });

    const result = backfillSpecWorkdirs(prd, structure);

    // "." is a declared value, not an absence: overwriting it would silently
    // rewrite what the planner stated, and report the rewrite as a fill.
    expect(result.prd.userStories[0]?.workdir).toBe(".");
    expect(result.backfilled).toEqual([]);
  });

  test("US-002: a declared repo root against the spec's package is a workdir-mismatch", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "." })] });

    expect(findSpecStructureViolations(prd, specStatingWorkdir)).toEqual([
      { kind: "workdir-mismatch", storyId: "US-004", expected: "apps/api", actual: "." },
    ]);
  });

  test("US-002: a declared repo root matching the spec's stated root is no mismatch", () => {
    // Both sides state the root, spelled differently: normalisation, not the
    // "." conflation, is what makes this empty — the mismatch case above proves
    // the comparison itself fires.
    const specStatingRoot = specOf(`### US-004 — API

- Workdir: ./`);

    const prd = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "." })] });

    expect(findSpecStructureViolations(prd, specStatingRoot)).toEqual([]);
  });
});
