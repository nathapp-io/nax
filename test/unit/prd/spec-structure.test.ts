/**
 * US-002 — the spec's own declared story structure.
 *
 * A spec that lists 5 stories can be planned to 4. The planner folds one into
 * another, the folded story's `### Modifies` entry is dropped as an orphan, and
 * nothing reports the divergence — so the run deadlocks against a red suite its
 * implementer has no authorisation to touch.
 *
 * These tests drive the pure grammar (`extractSpecStructure`) and the two
 * decisions built on it (backfill, violations) with the phrasings this repo's
 * own specs use. Every fixture below is a spec body, because the grammar is the
 * contract: what the author wrote is what has to be read.
 */
import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import {
  backfillSpecWorkdirs,
  declaredStoryIds,
  extractSpecStructure,
  findSpecStructureViolations,
  formatSpecStructureViolation,
  type PRD,
  type SpecStructure,
} from "@/prd";

/** A spec whose `## Stories` is `storiesBody`, with the sections real specs carry. */
function specOf(storiesBody: string): string {
  return `# SPEC: fixture

## Stories

${storiesBody}

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;
}

/** A PRD holding exactly these story ids, each with no workdir and no dependencies. */
function prdOf(ids: readonly string[]): PRD {
  return makePRD({ userStories: ids.map((id) => makeStory({ id })) });
}

function story(structure: SpecStructure, id: string) {
  return structure.stories.find((s) => s.id === id);
}

describe("extractSpecStructure (US-002)", () => {
  test("AC1: reads numbered story bullets and returns workdir, dependsOn and no warnings", () => {
    const spec = specOf(`1. **US-001: Core** — Workdir: packages/core — no dependencies
2. **US-002: API** — Workdir: apps/api — depends on US-001`);

    const structure = extractSpecStructure(spec);

    expect(structure.stories).toEqual([
      { id: "US-001", workdir: "packages/core", dependsOn: [] },
      { id: "US-002", workdir: "apps/api", dependsOn: ["US-001"] },
    ]);
    expect(structure.warnings).toEqual([]);
  });

  test("AC2: reads a Workdir statement from the ### Context Files subsection", () => {
    const spec = specOf(`### US-001 — Core

### US-003 — Web

### Context Files

**US-003**

_Workdir \`apps/web\`._

- \`apps/web/src/a.ts\` — the web entry`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-003")?.workdir).toBe("apps/web");
    // Attribution is scoped: the subsection's statement is US-003's, not US-001's.
    expect(story(structure, "US-001")?.workdir).toBeUndefined();
  });

  test("AC3: reads the three dependency phrasings this repo's specs use", () => {
    const spec = specOf(`### US-001 — Core

- **Depends on:** US-001 (shared type)

### US-002 — API

*(depends on US-001, US-002 and US-003)*

### US-003 — Web

- Depends on: none`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-001")?.dependsOn).toEqual(["US-001"]);
    expect(story(structure, "US-002")?.dependsOn).toEqual(["US-001", "US-002", "US-003"]);
    expect(story(structure, "US-003")?.dependsOn).toEqual([]);
  });

  test("AC4: leaves dependsOn undefined for a story that states no dependency", () => {
    const spec = specOf(`### US-001 — Core

- Workdir: packages/core

### US-002 — API

- \`apps/api/src/x.ts\` — read this`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-001")).toBeDefined();
    expect(story(structure, "US-001")?.dependsOn).toBeUndefined();
    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
  });

  test("AC5: does not read a dependency mention inside a ### Modifies reason", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### US-003 — Web

### Modifies

**US-002**

- \`scripts/count.ts\` — the count test depends on US-003's registration`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-002")).toBeDefined();
    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
  });

  test("AC6: conflicting Workdir values leave workdir undefined and warn", () => {
    const spec = specOf(`### US-001 — Core

Workdir: packages/lib

- \`packages/lib/src/a.ts\` — read it

Workdir: apps/api`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-001")?.workdir).toBeUndefined();
    expect(structure.warnings).toHaveLength(1);
    expect(structure.warnings[0]?.storyId).toBe("US-001");
    expect(structure.warnings[0]?.field).toBe("workdir");
    expect((structure.warnings[0]?.message ?? "").length).toBeGreaterThan(0);
  });

  test("US-002: unions the dependency lists one story states", () => {
    const spec = specOf(`### US-003 — Lib

- Depends on: US-001

- Depends on: US-004 and US-002`);

    // One story, two statements: a later statement that only names one more
    // dependency must not be read as replacing what the story already said.
    expect(story(extractSpecStructure(spec), "US-003")?.dependsOn).toEqual(["US-001", "US-004", "US-002"]);
  });

  test("US-002: reads the dependency keyword, its ids and its none keyword case-insensitively", () => {
    const spec = specOf(`### US-001 — Core

- depends on us-001

### US-002 — API

No Dependencies.`);

    const structure = extractSpecStructure(spec);

    // A lowercase id is normalised, and the ids reach the PRD uppercase, so
    // comparing against `US-001` is only possible if the read is case-blind.
    expect(story(structure, "US-001")?.dependsOn).toEqual(["US-001"]);
    expect(story(structure, "US-002")?.dependsOn).toEqual([]);
  });

  test("US-002: attributes a statement above every story declaration to no story", () => {
    const spec = specOf(`Workdir: apps/api

### US-001 — Core`);

    // Attribution is to the nearest PRECEDING declaring line. With none above
    // it, the statement belongs to nothing -- reading it onto US-001 would
    // enforce a workdir the spec never stated for that story.
    expect(extractSpecStructure(spec).stories).toEqual([{ id: "US-001" }]);
  });

  test("AC23: a none statement together with an id list warns and leaves dependsOn undefined", () => {
    const spec = specOf(`### US-001 — Core

- Depends on: none

- Depends on: US-001`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-001")?.dependsOn).toBeUndefined();
    expect(structure.warnings).toHaveLength(1);
    expect(structure.warnings[0]?.storyId).toBe("US-001");
    expect(structure.warnings[0]?.field).toBe("dependsOn");
  });

  test("US-002: ignores a Workdir statement written inside a fenced example block", () => {
    const spec = specOf(`### US-001 — Core

Write the statement like this:

\`\`\`markdown
Workdir: apps/api
\`\`\`

- Workdir: packages/core`);

    const structure = extractSpecStructure(spec);

    // The fenced copy is documentation. Reading it would conflict with the real
    // statement and silently disable the field.
    expect(story(structure, "US-001")?.workdir).toBe("packages/core");
    expect(structure.warnings).toEqual([]);
  });
});

describe("declaredStoryIds (US-002)", () => {
  test("US-002: reads both id sections and skips the **US-00N** lead-ins of grouped-path subsections", () => {
    const spec = `# SPEC: fixture

## Stories

### US-001 — Core

### Modifies

**US-009**

## Acceptance Criteria

### US-002 — API
`;

    expect(declaredStoryIds(spec.split("\n"))).toEqual(["US-001", "US-002"]);
  });
});

describe("findSpecStructureViolations (US-002)", () => {
  test("AC7: returns no violations when the spec declares no story ids", () => {
    const spec = `# SPEC: fixture

## Summary

A spec that declares no story ids at all.

## Stories

Prose only.

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

    expect(findSpecStructureViolations(prdOf(["US-001", "US-006"]), spec)).toEqual([]);
    // Positive control: the same PRD is not waved through when the spec does
    // declare ids — the guard skips the comparison rather than the module.
    expect(findSpecStructureViolations(prdOf(["US-001", "US-006"]), specOf("### US-001 — Core"))).toEqual([
      { kind: "extra-story", storyId: "US-006" },
    ]);
  });

  test("AC8: reports a story the spec declares and the PRD omits", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### US-003 — Lib

### US-004 — API layer

### US-005 — Web`);

    expect(findSpecStructureViolations(prdOf(["US-001", "US-002", "US-003", "US-005"]), spec)).toEqual([
      { kind: "missing-story", storyId: "US-004" },
    ]);
  });

  test("AC9: reports a PRD story the spec never declares, after the missing ones", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### US-003 — Lib

### US-004 — API layer

### US-005 — Web`);

    expect(findSpecStructureViolations(prdOf(["US-001", "US-002", "US-003", "US-005", "US-006"]), spec)).toEqual([
      { kind: "missing-story", storyId: "US-004" },
      { kind: "extra-story", storyId: "US-006" },
    ]);
  });

  test("AC10: reports a PRD workdir that differs from the spec's", () => {
    const spec = specOf(`### US-004 — API

- Workdir: apps/api`);
    const prd = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "packages/lib" })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([
      { kind: "workdir-mismatch", storyId: "US-004", expected: "apps/api", actual: "packages/lib" },
    ]);
  });

  test("AC11: reports no workdir-mismatch when the PRD story states no workdir", () => {
    const spec = specOf(`### US-004 — API

- Workdir: apps/api`);
    // No workdir: the backfill handles it, so it is not a divergence to reject.
    const prd = makePRD({ userStories: [makeStory({ id: "US-004" })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([]);
    // Positive control: an unstated workdir is tolerated, a different one is not.
    const differing = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "packages/lib" })] });
    expect(findSpecStructureViolations(differing, spec).map((v) => v.kind)).toEqual(["workdir-mismatch"]);
  });

  test("AC10 boundary: compares both workdirs after normalisation, so spelling alone is not a mismatch", () => {
    const spec = specOf(`### US-004 — API

- Workdir: apps/api/`);
    // The same package spelled differently on each side: a trailing separator
    // and a leading `./` are normalisation, not a divergence.
    const prd = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "./apps/api" })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([]);
    // Positive control: the same comparison on a genuinely different package is
    // still reported, so the empty result above is normalisation and not a
    // comparison that never fires.
    const other = makePRD({ userStories: [makeStory({ id: "US-004", workdir: "packages/lib" })] });
    expect(findSpecStructureViolations(other, spec).map((v) => v.kind)).toEqual(["workdir-mismatch"]);
  });

  test("US-002: returns every workdir-mismatch before every dependencies-mismatch", () => {
    const spec = specOf(`### US-001 — Core

- Depends on: US-002

### US-002 — API

- Workdir: apps/api`);
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002", workdir: "packages/lib" })],
    });

    // The kinds are enumerated one after another, so the workdir mismatches are
    // the whole third group and the dependency mismatches the whole fourth:
    // US-002's workdir is reported before US-001's dependencies, not after it.
    // The refusal message lists these lines in order, so an interleaved result
    // reorders the list the operator reads.
    expect(findSpecStructureViolations(prd, spec)).toEqual([
      { kind: "workdir-mismatch", storyId: "US-002", expected: "apps/api", actual: "packages/lib" },
      { kind: "dependencies-mismatch", storyId: "US-001", expected: ["US-002"], actual: [] },
    ]);
  });

  test("AC12: reports a dependency set that differs from the spec's list", () => {
    const spec = specOf(`### US-005 — Reporting

- Depends on: US-001, US-003`);
    const prd = makePRD({ userStories: [makeStory({ id: "US-005", dependencies: ["US-001"] })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([
      { kind: "dependencies-mismatch", storyId: "US-005", expected: ["US-001", "US-003"], actual: ["US-001"] },
    ]);
  });

  test("AC13: reports an added dependency when the spec states none", () => {
    const spec = specOf(`### US-002 — API

No dependencies.`);
    const prd = makePRD({ userStories: [makeStory({ id: "US-002", dependencies: ["US-001"] })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([
      { kind: "dependencies-mismatch", storyId: "US-002", expected: [], actual: ["US-001"] },
    ]);
  });

  test("AC24: does not enforce dependencies the spec states nothing about", () => {
    const spec = specOf(`### US-001 — Core`);
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", dependencies: ["US-002"] })] });

    expect(findSpecStructureViolations(prd, spec)).toEqual([]);
    // Positive control: the same PRD against a spec that states "no dependencies"
    // IS a mismatch, so the silence above is about the missing statement.
    const stated = specOf(`### US-001 — Core

No dependencies.`);
    expect(findSpecStructureViolations(prd, stated).map((v) => v.kind)).toEqual(["dependencies-mismatch"]);
  });

  test("AC14: reports a Modifies entry no PRD story owns", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### US-003 — Lib

### Modifies

**US-004**

- \`apps/api/tests/test_count.py\` — the api count test`);
    const prd = prdOf(["US-001", "US-002", "US-003"]);

    const orphans = findSpecStructureViolations(prd, spec).filter((v) => v.kind === "orphan-modifies");

    expect(orphans).toEqual([{ kind: "orphan-modifies", storyId: "US-004", path: "apps/api/tests/test_count.py" }]);
  });

  test("AC14 boundary: reports an unattributed Modifies entry with a null storyId", () => {
    const spec = specOf(`### US-001 — Core

### Modifies

- \`apps/api/tests/test_count.py\` — no lead-in above it`);

    const orphans = findSpecStructureViolations(prdOf(["US-001"]), spec).filter((v) => v.kind === "orphan-modifies");

    expect(orphans).toEqual([{ kind: "orphan-modifies", storyId: null, path: "apps/api/tests/test_count.py" }]);
  });
});

describe("backfillSpecWorkdirs (US-002)", () => {
  test("AC15: fills a missing workdir from the spec without mutating the input PRD", () => {
    const structure: SpecStructure = { stories: [{ id: "US-004", workdir: "apps/api" }], warnings: [] };
    const prd = makePRD({ userStories: [makeStory({ id: "US-004" })] });

    const result = backfillSpecWorkdirs(prd, structure);

    expect(result.prd.userStories[0]?.workdir).toBe("apps/api");
    expect(result.backfilled).toEqual(["US-004"]);
    expect(result.prd).not.toBe(prd);
    expect(prd.userStories[0]?.workdir).toBeUndefined();
  });

  test("AC15 boundary: fills a stated root and package workdir but leaves existing and unstated values alone", () => {
    const structure: SpecStructure = {
      stories: [
        { id: "US-001", workdir: "." },
        { id: "US-002", workdir: "packages/lib" },
        { id: "US-003" },
        { id: "US-004", workdir: "packages/lib" },
      ],
      warnings: [],
    };
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001" }),
        makeStory({ id: "US-002" }),
        makeStory({ id: "US-003" }),
        makeStory({ id: "US-004", workdir: "apps/api" }),
      ],
    });

    const result = backfillSpecWorkdirs(prd, structure);

    expect(result.backfilled).toEqual(["US-001", "US-002"]);
    expect(result.prd.userStories.map((s) => s.workdir)).toEqual([".", "packages/lib", undefined, "apps/api"]);
  });
});

describe("formatSpecStructureViolation (US-002)", () => {
  test("AC16: renders a dependencies-mismatch as what the PRD has, then what the spec says", () => {
    expect(
      formatSpecStructureViolation({
        kind: "dependencies-mismatch",
        storyId: "US-005",
        expected: ["US-001", "US-003"],
        actual: ["US-001"],
      }),
    ).toBe("US-005: dependencies are [US-001]; the spec says [US-001, US-003]");
  });

  test("US-002: renders a missing story as never-merge-never-rename", () => {
    expect(formatSpecStructureViolation({ kind: "missing-story", storyId: "US-004" })).toBe(
      "US-004: missing — the spec declares it; never merge or rename a spec story",
    );
  });

  test("US-002: renders an extra story as remove-it or move-its-ACs-back", () => {
    expect(formatSpecStructureViolation({ kind: "extra-story", storyId: "US-006" })).toBe(
      "US-006: not in the spec — remove it or move its ACs back to their spec story",
    );
  });

  test("US-002: renders a workdir-mismatch with the PRD's workdir first", () => {
    expect(
      formatSpecStructureViolation({
        kind: "workdir-mismatch",
        storyId: "US-003",
        expected: "apps/api",
        actual: "packages/lib",
      }),
    ).toBe('US-003: workdir is "packages/lib"; the spec says "apps/api"');
  });

  test("US-002: renders an orphan Modifies entry with its path and owning story", () => {
    expect(
      formatSpecStructureViolation({
        kind: "orphan-modifies",
        storyId: "US-004",
        path: "apps/api/tests/test_x.py",
      }),
    ).toBe('Modifies "apps/api/tests/test_x.py" (US-004): no PRD story owns it');
  });
});
