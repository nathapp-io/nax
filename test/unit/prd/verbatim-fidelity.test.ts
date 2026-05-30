import { describe, expect, test } from "bun:test";
import { extractVerbatimAcs, findMissingVerbatimAcs } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

function prdWithAcs(...acs: string[]) {
  return makePRD({ userStories: [makeStory({ acceptanceCriteria: acs })] });
}

describe("extractVerbatimAcs", () => {
  test("returns only [verbatim]-tagged AC bullets, trimmed", () => {
    const spec = [
      "## Acceptance Criteria",
      "- [unit] login() returns true for valid credentials",
      "   - [verbatim] `grep -rn \"oldSym\" src/` returns zero matches  ",
      "- [file] `src/foo.ts` contains the substring `bar`",
      "- [verbatim] File `src/legacy.ts` does not exist after this story",
    ].join("\n");
    expect(extractVerbatimAcs(spec)).toEqual([
      '- [verbatim] `grep -rn "oldSym" src/` returns zero matches',
      "- [verbatim] File `src/legacy.ts` does not exist after this story",
    ]);
  });

  test("returns empty when no [verbatim] bullets exist", () => {
    expect(extractVerbatimAcs("- [unit] does a thing\nplain prose")).toEqual([]);
  });

  test("matches the tag case-insensitively", () => {
    expect(extractVerbatimAcs("- [VERBATIM] `x` is gone")).toHaveLength(1);
  });

  test("accepts numbered bullets and combined tag groups", () => {
    const spec = "1. [file] [verbatim] `a.ts` contains `X`";
    expect(extractVerbatimAcs(spec)).toEqual(["1. [file] [verbatim] `a.ts` contains `X`"]);
  });

  // H2 regression — prose that merely mentions the tag is not an AC bullet.
  test("ignores prose lines that merely mention [verbatim]", () => {
    const spec = [
      "## Spec Fidelity Rules",
      "Note: the [verbatim] tag means the AC must be copied unchanged.",
      "The planner must respect [verbatim] markers.",
    ].join("\n");
    expect(extractVerbatimAcs(spec)).toEqual([]);
  });

  // H1 regression — a wrapped AC folds its continuation lines into one block.
  test("folds continuation lines of a wrapped verbatim AC", () => {
    const spec = [
      "- [verbatim] after the migration,",
      '  `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches',
      "",
      "- [unit] unrelated",
    ].join("\n");
    expect(extractVerbatimAcs(spec)).toEqual([
      '- [verbatim] after the migration, `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches',
    ]);
  });
});

describe("findMissingVerbatimAcs", () => {
  test("empty when the spec has no [verbatim] ACs", () => {
    const spec = "- [unit] login works\n- [file] `a.ts` contains `b`";
    expect(findMissingVerbatimAcs(spec, prdWithAcs("anything"))).toEqual([]);
  });

  test("not missing when the full verbatim phrase survives in a PRD AC", () => {
    const spec = '- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches';
    const prd = prdWithAcs(
      'When cleanup completes, `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches.',
    );
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("tolerates whitespace and backtick-formatting differences", () => {
    const spec = '- [verbatim] `grep -rn "oldSym"   src/` returns zero matches';
    const prd = prdWithAcs('After this story, grep -rn "oldSym" src/ returns zero matches.');
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("missing when the assertion was paraphrased away", () => {
    const spec = '- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches';
    const prd = prdWithAcs("runThreeSessionTdd exports and usages are removed from the src and test trees.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  test("not missing when a file-existence verbatim AC is preserved whole", () => {
    const spec = "- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story";
    const prd = prdWithAcs("When the story completes, File src/tdd/orchestrator.ts does not exist after this story.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  // C1 regression — polarity inversion must be caught (the whole reason the gate exists).
  test("missing when a 'does not exist' AC is inverted to 'still exists'", () => {
    const spec = "- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story";
    const prd = prdWithAcs("src/tdd/orchestrator.ts still exists for backward compatibility.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  // C1 regression — a superstring path must not satisfy the AC.
  test("missing when only a superstring of the path is present", () => {
    const spec = "- [verbatim] File `src/a.ts` does not exist after this story";
    const prd = prdWithAcs("src/a.ts.bak is created during migration.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  // C2 regression — a count-only AC must not be satisfied by an unrelated stray digit.
  test("missing when a count assertion survives only as a stray digit", () => {
    const spec = "- [verbatim] `src/a.ts` contains the regex `^export` exactly `2` times";
    const prd = prdWithAcs("The module is referenced 2 places across the suite.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  test("not missing when the count assertion is preserved whole", () => {
    const spec = "- [verbatim] `src/a.ts` contains the regex `^export` exactly `2` times";
    const prd = prdWithAcs("src/a.ts contains the regex ^export exactly 2 times.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("preserves polarity / scope by matching within a single PRD AC, not across ACs", () => {
    const spec = "- [verbatim] `grep -rn \"A\" src/` returns zero matches";
    // The tokens exist but split across two different ACs — must NOT count as preserved.
    const prd = prdWithAcs('grep -rn "A" src/ is run during cleanup', "the suite returns zero matches overall");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  test("searches across all stories' acceptance criteria", () => {
    const spec = "- [verbatim] `grep -rn \"X\" src/` returns zero matches";
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", acceptanceCriteria: ["unrelated"] }),
        makeStory({ id: "US-002", acceptanceCriteria: ['grep -rn "X" src/ returns zero matches'] }),
      ],
    });
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  // M2 — documented limitation: a verbatim AC written as a fenced code block
  // folds the fences/command into the payload, so a faithfully-preserved command
  // still reads as "missing". Acceptable because the warning is non-fatal; pinned
  // here so the behavior is intentional, not an accidental regression.
  test("fenced multi-line verbatim AC yields a (tolerated) spurious warning", () => {
    const spec = ["- [verbatim] run the check:", "  ```", '  grep -rn "X" src/', "  ```"].join("\n");
    const prd = prdWithAcs('grep -rn "X" src/ returns zero matches'); // command IS preserved
    expect(findMissingVerbatimAcs(spec, prd)).toHaveLength(1);
  });

  test("flags every dropped verbatim AC independently", () => {
    const spec = [
      "- [verbatim] `grep -rn \"A\" src/` returns zero matches",
      "- [verbatim] File `src/b.ts` does not exist",
    ].join("\n");
    const prd = prdWithAcs('grep -rn "A" src/ returns zero matches'); // first survives, second dropped
    expect(findMissingVerbatimAcs(spec, prd)).toEqual(["- [verbatim] File `src/b.ts` does not exist"]);
  });
});
