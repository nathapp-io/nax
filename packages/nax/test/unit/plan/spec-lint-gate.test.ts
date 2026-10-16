import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import { assertSpecLintClean } from "@/plan";

/**
 * The gate exists because `lintSpecContent`'s only caller was the `spec:lint`
 * npm script, so it fired only when an author already suspected a problem
 * (#1989). A dropped `Modifies` entry is silent, survives the plan, and is
 * findable only by diffing the PRD — after the plan spend.
 */
function spec(body: string): string {
  return `# SPEC: Fixture

## Stories

### US-001 — Do the thing

${body}

## Acceptance Criteria

### US-001 — Do the thing

1. \`[unit]\` calling \`doThing()\` returns \`true\`.
`;
}

const CLEAN = `### Modifies

None. Nothing existing changes shape.`;

/** Narrow the thrown value without a cast, so the test ratchets can see it. */
function caughtNaxError(run: () => void): NaxError {
  try {
    run();
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new NaxError("expected assertSpecLintClean to throw", "TEST_EXPECTED_THROW");
}

const OPTIONS = { specPath: "docs/specs/SPEC-fixture.md", featureName: "fixture", workdir: "/tmp/nonexistent-workdir" };

/**
 * US-005: two stories that state nothing about their dependencies, and are
 * otherwise clean — no path-bearing section, so nothing here needs a real file.
 */
const TWO_STORIES_NO_DEPENDENCIES = `# SPEC: Fixture

## Stories

### US-001 — Do the thing

### US-002 — Do the other thing

## Acceptance Criteria

### US-001 — Do the thing

1. \`[unit]\` calling \`doThing()\` returns \`true\`.

### US-002 — Do the other thing

1. \`[unit]\` calling \`doOtherThing()\` returns \`true\`.
`;

describe("assertSpecLintClean", () => {
  test("throws on a Modifies block that declares intent but extracts nothing; skips every check when the caller opted out", () => {
    const dropped = `Modifies:
- **US-001** \`src/a.ts\` — reason`;
    expect(() => assertSpecLintClean(spec(dropped), OPTIONS)).toThrow(NaxError);
    expect(assertSpecLintClean(spec(dropped), { ...OPTIONS, skip: true })).toEqual([]);
  });

  test("names the blocking codes and the spec path in the thrown error's context", () => {
    const dropped = `Modifies:
- **US-001** \`src/a.ts\` — reason`;
    const err = caughtNaxError(() => assertSpecLintClean(spec(dropped), OPTIONS));
    expect(err.code).toBe("PLAN_SPEC_LINT_FAILED");
    expect(err.context?.specPath).toBe("docs/specs/SPEC-fixture.md");
    expect(err.context?.codes).toEqual(["modifies-declared-but-empty"]);
  });

  test("does not throw on a finding outside the extraction-integrity set, returning it instead", () => {
    const untagged = spec(CLEAN).replace(
      "1. `[unit]` calling `doThing()` returns `true`.",
      "1. calling `doThing()` returns `true`.",
    );
    const warned = assertSpecLintClean(untagged, OPTIONS);
    expect(warned.map((f) => f.code)).toContain("ac-untagged");
  });

  test("returns no findings for a spec whose sections all round-trip", () => {
    expect(assertSpecLintClean(spec(CLEAN), OPTIONS)).toEqual([]);
  });

  test("US-002 AC-12: does not throw on an AC bullet that references AC-1 by number, and returns the warn in its findings", () => {
    const refSpec = `# SPEC: Reference

## Acceptance Criteria

### US-001 — Reference story

1. \`[unit]\` foo() returns 1.
2. \`[unit]\` In the AC-1 setup, foo() returns 2.
`;
    const findings = assertSpecLintClean(refSpec, OPTIONS);
    const numericRefs = findings.filter((f) => f.code === "ac-numeric-reference");
    expect(numericRefs).toHaveLength(1);
    expect(numericRefs[0].level).toBe("warn");
  });

  test("US-005 AC-17: does not throw on an otherwise-clean two-story spec that states no dependency", () => {
    // The gate refuses only `BLOCKING_SPEC_LINT_CODES`; an unstated dependency
    // is legal on a spec whose stories are genuinely unordered, so it must
    // reach the caller as a finding rather than fail the plan.
    expect(() => assertSpecLintClean(TWO_STORIES_NO_DEPENDENCIES, OPTIONS)).not.toThrow();

    const findings = assertSpecLintClean(TWO_STORIES_NO_DEPENDENCIES, OPTIONS);
    expect(findings.map((f) => f.code)).toEqual(["story-dependencies-not-stated", "story-dependencies-not-stated"]);
  });
});
