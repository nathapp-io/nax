import { describe, expect, test } from "bun:test";
import { BLOCKING_SPEC_LINT_CODES, lintSpecContent } from "@/prd";

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

  test("flags a Modifies bullet with no story lead-in above it", async () => {
    const noLeadIn = `### Modifies

- \`scripts/check-spec-extractable.ts\` — reason`;
    const codes = lintText(specWith(noLeadIn)).map((f) => f.code);
    expect(codes).toContain("modifies-unattributed");
  });

  test("flags a Modifies bullet grouped under a story the spec never declares", async () => {
    const unknownStory = `### Modifies

**US-999**

- \`scripts/check-spec-extractable.ts\` — reason`;
    const codes = lintText(specWith(unknownStory)).map((f) => f.code);
    expect(codes).toContain("modifies-unknown-story");
  });

  test("US-002 AC22: still flags a Modifies entry grouped under a story ## Stories never declares", async () => {
    const unknownStory = `### Modifies

**US-009**

- \`scripts/check-spec-extractable.ts\` — reason`;
    const findings = lintText(specWith(unknownStory));

    const unknown = findings.find((f) => f.code === "modifies-unknown-story");
    expect(unknown?.level).toBe("error");
    expect(unknown?.message).toContain("US-009");
    expect(unknown?.message).toContain("scripts/check-spec-extractable.ts");
  });

  test("warns on a Modifies bullet with no reason after the path", async () => {
    const bareBullet = `### Modifies

**US-001**

- \`scripts/check-spec-extractable.ts\``;
    const codes = lintText(specWith(bareBullet)).map((f) => f.code);
    expect(codes).toContain("modifies-no-reason");
  });

  test("warns when the Modifies section hits the entry cap", async () => {
    const bullets = Array.from(
      { length: 25 },
      (_, i) => `- \`scripts/check-spec-extractable.ts?${i}\` — reason ${i}`,
    ).join("\n");
    const atCap = `### Modifies

**US-001**

${bullets}`;
    const codes = lintText(specWith(atCap)).map((f) => f.code);
    expect(codes).toContain("modifies-at-cap");
  });

  test("flags an Out of Scope heading that extracts 0 items", async () => {
    const spec = `${specWith(OWN_LINE_LEAD_IN)}
## Out of Scope

## Seams
`;
    const codes = lintText(spec).map((f) => f.code);
    expect(codes).toContain("out-of-scope-not-extractable");
  });

  test("warns on a feature-level Out of Scope bullet that hoists a story id without the 'only:' prefix", async () => {
    const spec = `${specWith(OWN_LINE_LEAD_IN)}
## Out of Scope

- US-001 does not need this behaviour, deferred for later.
`;
    const codes = lintText(spec).map((f) => f.code);
    expect(codes).toContain("out-of-scope-unprefixed-hoist");
  });

  test("warns when story bullets mention Context Files but the extractor finds 0", async () => {
    const inlineContextFiles = `### Modifies

**US-001**

- \`scripts/check-spec-extractable.ts\` — reason

- Context Files:
  - **US-001** \`scripts/check-spec-extractable.ts\` — reason`;
    const codes = lintText(specWith(inlineContextFiles)).map((f) => f.code);
    expect(codes).toContain("context-files-not-extractable");
  });

  test("warns on a Context Files entry whose path does not exist", async () => {
    const contextFiles = `${OWN_LINE_LEAD_IN}

### Context Files

**US-001**

- \`test/unit/does-not-exist.test.ts\` — reason`;
    const codes = lintText(specWith(contextFiles)).map((f) => f.code);
    expect(codes).toContain("context-file-missing");
  });

  test("flags a story with more ACs than the configured cap", async () => {
    const acs = Array.from(
      { length: 3 },
      (_, i) => `${i + 1}. \`[unit]\` calling \`doThing()\` returns \`${i}\`.`,
    ).join("\n");
    const spec = specWith(OWN_LINE_LEAD_IN).replace("1. `[unit]` calling `doThing()` returns `true`.", acs);
    const codes = lintSpecContent(spec, {
      fileExists: (p) => p.startsWith("scripts/"),
      maxAcCount: 2,
    }).map((f) => f.code);
    expect(codes).toContain("ac-count-over-cap");
  });

  test("flags an AC with no runtime mechanism tag", async () => {
    const spec = specWith(OWN_LINE_LEAD_IN).replace(
      "1. `[unit]` calling `doThing()` returns `true`.",
      "1. calling `doThing()` returns `true`.",
    );
    const codes = lintText(spec)
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).toContain("ac-untagged");
  });

  test("flags an AC that contains a shell fragment", async () => {
    const spec = specWith(OWN_LINE_LEAD_IN).replace(
      "1. `[unit]` calling `doThing()` returns `true`.",
      "1. `[unit]` running `grep -r doThing src/` finds one match.",
    );
    const codes = lintText(spec)
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).toContain("ac-shell-command");
  });

  test("warns when a spec declares more stories than the soft ceiling", async () => {
    const storyHeadings = Array.from({ length: 8 }, (_, i) => `### US-00${i + 1} — Story ${i + 1}`).join("\n\n");
    const spec = `# SPEC: Fixture

## Summary
A fixture.

## Stories

${storyHeadings}

## Acceptance Criteria

### US-001 — Story 1

1. \`[unit]\` calling \`doThing()\` returns \`true\`.
`;
    const codes = lintText(spec).map((f) => f.code);
    expect(codes).toContain("story-count-over-target");
  });

  test("flags a bare `Modifies:` label line, the shape that silently extracted nothing", async () => {
    const bareLabel = `Modifies:
- **US-001** \`scripts/check-spec-extractable.ts\` — reason`;
    const codes = lintText(specWith(bareLabel))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).toContain("modifies-declared-but-empty");
  });

  test("does not read a `Modifies:` label documented inside a fenced block as a declaration", async () => {
    const documented = `Authors sometimes write the section like this, which does not extract:

\`\`\`markdown
Modifies:
- **US-001** \`scripts/check-spec-extractable.ts\` — reason
\`\`\``;
    const codes = lintText(specWith(documented))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).not.toContain("modifies-declared-but-empty");
  });

  test("does not read a `### Modifies` heading documented inside a fenced block as a declaration", async () => {
    const documented = `Write the section like this:

\`\`\`markdown
### Modifies

**US-001**

- \`scripts/check-spec-extractable.ts\` — reason
\`\`\``;
    const codes = lintText(specWith(documented))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).not.toContain("modifies-declared-but-empty");
  });

  test("accepts a `### Modifies` section that declares None with a prose justification", async () => {
    const none = `### Modifies

None. No existing test pins a closed-world shape this feature changes.`;
    const codes = lintText(specWith(none))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).not.toContain("modifies-declared-but-empty");
  });

  test("sees a None declaration that follows an explanatory blockquote", async () => {
    const none = `### Modifies

> Write the section even when the answer is nothing — an absent section and an
> empty one read identically.

None. No existing test pins a closed-world shape this feature changes.`;
    const codes = lintText(specWith(none))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).not.toContain("modifies-declared-but-empty");
  });

  test("accepts a bare `Modifies: none` label line as an explicit empty declaration", async () => {
    const codes = lintText(specWith("Modifies: none"))
      .filter((f) => f.level === "error")
      .map((f) => f.code);
    expect(codes).not.toContain("modifies-declared-but-empty");
  });
});

/**
 * US-002 — Numeric AC references.
 *
 * The plan prompt says "one assertion per AC", so the planner splits a
 * compound bullet into two and renumbers the rest. The split text can still
 * point at the old number, which then points at a different criterion in the
 * PRD. The check is non-blocking — a bare `ac-numeric-reference` is a warning
 * the author can act on, not a gate the plan refuses.
 */

/** The reference spec used in AC-7, AC-8, AC-10, AC-12, AC-13. */
function referenceSpecWithAc(acBullets: string): string {
  return `# SPEC: Reference

## Acceptance Criteria

### US-001 — Reference story

${acBullets}
`;
}

const REFERENCE_SPEC = referenceSpecWithAc(
  ["1. `[unit]` foo() returns 1.", "2. `[unit]` In the AC-1 setup, foo() returns 2."].join("\n"),
);

const BACKTICK_ONLY_SPEC = referenceSpecWithAc("1. `[unit]` the test titled `AC-1: a` passes.");

const DESIGN_PROSE_NO_BULLET_REFS = [
  "# SPEC: Design prose",
  "",
  "## Design",
  "",
  "see AC-3 below for the rationale.",
  "",
  "## Acceptance Criteria",
  "",
  "### US-001 — Reference story",
  "",
  "1. `[unit]` foo() returns 1.",
  "",
].join("\n");

describe("ac-numeric-reference (US-002)", () => {
  test("AC-7: emits exactly one ac-numeric-reference warn for a spec whose AC bullet references AC-1 by number", () => {
    const findings = lintText(REFERENCE_SPEC);
    const numericRefs = findings.filter((f) => f.code === "ac-numeric-reference");
    expect(numericRefs).toHaveLength(1);
    expect(numericRefs[0].level).toBe("warn");
  });

  test("AC-8: the warn's message contains both the story/AC position and the referenced number", () => {
    const findings = lintText(REFERENCE_SPEC);
    const finding = findings.find((f) => f.code === "ac-numeric-reference");
    expect(finding?.message).toContain("US-001 AC 2");
    expect(finding?.message).toContain("AC-1");
  });

  test("AC-9: ac-numeric-reference is not a blocking lint code", () => {
    expect(BLOCKING_SPEC_LINT_CODES.has("ac-numeric-reference")).toBe(false);
  });

  test("AC-10: an AC-1 token only inside backticks produces no ac-numeric-reference finding", () => {
    const findings = lintText(BACKTICK_ONLY_SPEC);
    const numericRefs = findings.filter((f) => f.code === "ac-numeric-reference");
    expect(numericRefs).toEqual([]);
  });

  test("AC-11: a ## Design reference to AC-3 with AC bullets that carry no numeric reference produces no finding", () => {
    const findings = lintText(DESIGN_PROSE_NO_BULLET_REFS);
    const numericRefs = findings.filter((f) => f.code === "ac-numeric-reference");
    expect(numericRefs).toEqual([]);
  });
});
