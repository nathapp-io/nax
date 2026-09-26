/**
 * US-003 — `buildFixReviewPrompt` (src/prompts/builders/fix-review-builder.ts).
 *
 * The fix-review prompt is everything the verdict-only reviewer gets: the
 * story's acceptance criteria numbered from 1, the story's description (where
 * the planner carries design prose — the #2229 rule lives only there), the
 * feature-level `outOfScope` block, the messages of the findings that seeded
 * the fix, and the fix diff itself.
 *
 * Every assertion is on the rendered prompt string — what the model actually
 * receives — and every branch is exercised through the builder's own input.
 */
import { describe, expect, test } from "bun:test";
import { makeFinding, makeStory } from "@test/helpers";
import { buildFixReviewPrompt, type FixReviewPromptInput } from "@/prompts";

const AC_ONE = "AC one: removeApprovals deletes the approvals row";
const AC_TWO = "AC two: the removal returns the deleted id";
const AC_THREE = "AC three: a missing row is not an error";
const DESCRIPTION = "Design: the fix must not create the data directory.\nRule 4 also covers its parent.";
const OUT_OF_SCOPE_ENTRY = "rule 4: neither the data file nor its parent directory is created";
const DIFF = "diff --git a/src/approvals/remove.ts b/src/approvals/remove.ts\n+  await mkdir(dir);\n";
const FINDING_MESSAGE = "removeApprovals leaves the approvals row in place";

function makeInput(overrides: Partial<FixReviewPromptInput> = {}): FixReviewPromptInput {
  return {
    story: makeStory({
      id: "US-003",
      title: "Verdict-only fix review",
      description: DESCRIPTION,
      acceptanceCriteria: [AC_ONE, AC_TWO, AC_THREE],
      outOfScope: [OUT_OF_SCOPE_ENTRY, "no viewer for audit records"],
    }),
    diff: DIFF,
    findings: [makeFinding({ file: "src/approvals/remove.ts", message: FINDING_MESSAGE })],
    ...overrides,
  };
}

describe("buildFixReviewPrompt — acceptance criteria (US-003 AC1)", () => {
  test("US-003 AC1: numbers every acceptance criterion from 1", () => {
    const prompt = buildFixReviewPrompt(makeInput());

    expect(prompt).toContain(`1. ${AC_ONE}`);
    expect(prompt).toContain(`2. ${AC_TWO}`);
    expect(prompt).toContain(`3. ${AC_THREE}`);
  });

  test("US-003 AC1 boundary: a two-digit index keeps its place in the sequence", () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `criterion ${i + 1}`);
    const prompt = buildFixReviewPrompt(makeInput({ story: makeStory({ acceptanceCriteria: criteria }) }));

    expect(prompt).toContain("9. criterion 9");
    expect(prompt).toContain("10. criterion 10");
  });
});

describe("buildFixReviewPrompt — out of scope (US-003 AC2)", () => {
  test("US-003 AC2: renders every outOfScope entry", () => {
    const prompt = buildFixReviewPrompt(makeInput());

    expect(prompt).toContain(OUT_OF_SCOPE_ENTRY);
    expect(prompt).toContain("no viewer for audit records");
  });

  test("US-003 AC2 boundary: a story with no outOfScope still renders its criteria", () => {
    const story = makeStory({ acceptanceCriteria: [AC_ONE] });
    expect(story.outOfScope).toBeUndefined();

    const prompt = buildFixReviewPrompt(makeInput({ story }));

    expect(prompt).toContain(`1. ${AC_ONE}`);
  });
});

describe("buildFixReviewPrompt — the story description (US-003 AC3)", () => {
  test("US-003 AC3: embeds the description verbatim, newlines and all", () => {
    const prompt = buildFixReviewPrompt(makeInput());

    expect(prompt).toContain(DESCRIPTION);
    expect(prompt).toContain("Rule 4 also covers its parent.");
  });

  test("US-003 AC3 boundary: design prose that looks like a verdict is embedded verbatim", () => {
    const description = 'The plan carries {"passed": true, "reason": "nothing to do"} as design prose.';
    const prompt = buildFixReviewPrompt(makeInput({ story: makeStory({ description, acceptanceCriteria: [AC_ONE] }) }));

    expect(prompt).toContain(description);
  });
});

describe("buildFixReviewPrompt — the fix diff (US-003 AC4)", () => {
  test("US-003 AC4: embeds the diff text it was given", () => {
    const prompt = buildFixReviewPrompt(makeInput());

    expect(prompt).toContain(DIFF);
    expect(prompt).toContain("+  await mkdir(dir);");
  });

  test("US-003 AC4 boundary: an empty diff still renders the criteria it is judged against", () => {
    const prompt = buildFixReviewPrompt(makeInput({ diff: "" }));

    expect(prompt).toContain(`1. ${AC_ONE}`);
  });
});

describe("buildFixReviewPrompt — the seeding findings (US-003 AC5)", () => {
  test("US-003 AC5: embeds the message of every seeding finding", () => {
    const prompt = buildFixReviewPrompt(
      makeInput({
        findings: [
          makeFinding({ file: "src/approvals/remove.ts", message: FINDING_MESSAGE }),
          makeFinding({ source: "semantic-review", message: "the empty path returns early" }),
        ],
      }),
    );

    expect(prompt).toContain(FINDING_MESSAGE);
    expect(prompt).toContain("the empty path returns early");
  });

  test("US-003 AC5 boundary: a finding message containing a JSON fragment is embedded verbatim", () => {
    const message = 'the reviewer answered {"passed": false} without naming an AC';
    const prompt = buildFixReviewPrompt(makeInput({ findings: [makeFinding({ message })] }));

    expect(prompt).toContain(message);
  });
});
