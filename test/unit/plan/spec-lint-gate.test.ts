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

describe("assertSpecLintClean", () => {
  test("throws on a Modifies block that declares intent but extracts nothing", () => {
    const dropped = `Modifies:
- **US-001** \`src/a.ts\` — reason`;
    expect(() => assertSpecLintClean(spec(dropped), OPTIONS)).toThrow(NaxError);
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

  test("skips every check when the caller opted out", () => {
    const dropped = `Modifies:
- **US-001** \`src/a.ts\` — reason`;
    expect(assertSpecLintClean(spec(dropped), { ...OPTIONS, skip: true })).toEqual([]);
  });
});
