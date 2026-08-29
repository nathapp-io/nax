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
});
