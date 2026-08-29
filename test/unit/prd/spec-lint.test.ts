import { describe, expect, test } from "bun:test";
import { lintSpecContent } from "@/prd";

/**
 * The regression this gate exists for: a `### Modifies` entry written with the
 * `**US-00N**` lead-in inline on the same bullet as the path extracts to
 * NOTHING, and `nax plan` reports no error. The only prior way to notice was a
 * full re-plan and a PRD diff.
 */
function specWith(modifiesBlock: string): string {
  return `# SPEC: Fixture

## Summary
A fixture.

## Stories

### US-001 — Do the thing

- Creates: none

${modifiesBlock}

## Acceptance Criteria

### US-001 — Do the thing

1. \`[unit]\` calling \`doThing()\` returns \`true\`.
`;
}

function lintText(content: string) {
  // Only paths under scripts/ are asserted to exist; everything else is absent.
  return lintSpecContent(content, { fileExists: (p) => p.startsWith("scripts/") });
}

const INLINE_LEAD_IN = `- Modifies:
  - **US-001** \`scripts/check-spec-extractable.ts\` — reason`;

const OWN_LINE_LEAD_IN = `### Modifies

**US-001**

- \`scripts/check-spec-extractable.ts\` — reason`;

describe("check-spec-extractable", () => {
  test("flags a Modifies block whose lead-in is inline, which extracts to nothing", async () => {
    const findings = lintText(specWith(INLINE_LEAD_IN));
    const codes = findings.filter((f) => f.level === "error").map((f) => f.code);
    expect(codes).toContain("modifies-declared-but-empty");
  });

  test("accepts the own-line lead-in form the extractor actually parses", async () => {
    const findings = lintText(specWith(OWN_LINE_LEAD_IN));
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
  });

  test("flags a bullet naming two paths, since only the first is authorised", async () => {
    const twoPaths = `### Modifies

**US-001**

- \`scripts/check-spec-extractable.ts\` and \`package.json\` — reason`;
    const codes = lintText(specWith(twoPaths)).map((f) => f.code);
    expect(codes).toContain("modifies-multi-path-bullet");
  });

  test("flags a path that does not resolve, which authorises nothing", async () => {
    const ghost = `### Modifies

**US-001**

- \`test/unit/does-not-exist.test.ts\` — reason`;
    const codes = lintText(specWith(ghost)).map((f) => f.code);
    expect(codes).toContain("modifies-path-missing");
  });

  test("does not treat a prose reference to another spec's story as a malformed hoist", async () => {
    const spec = `${specWith(OWN_LINE_LEAD_IN)}
## Out of Scope

- Implementing the thing described by US-001 of \`docs/specs/SPEC-other.md\`, which is retired.
`;
    const codes = lintText(spec).map((f) => f.code);
    expect(codes).not.toContain("out-of-scope-unprefixed-hoist");
  });

  test("flags an AC carrying a banned file-content tag", async () => {
    const spec = specWith(OWN_LINE_LEAD_IN).replace(
      "1. `[unit]` calling `doThing()` returns `true`.",
      "1. `[file]` `src/thing.ts` contains the substring `doThing`.",
    );
    const codes = lintText(spec)
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).toContain("ac-banned-tag");
  });
});
