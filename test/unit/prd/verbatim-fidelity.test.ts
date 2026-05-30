import { describe, expect, test } from "bun:test";
import { extractVerbatimAcLines, findMissingVerbatimAcs } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

function prdWithAcs(...acs: string[]) {
  return makePRD({ userStories: [makeStory({ acceptanceCriteria: acs })] });
}

describe("extractVerbatimAcLines", () => {
  test("returns only lines tagged [verbatim], trimmed", () => {
    const spec = [
      "## Acceptance Criteria",
      "- [unit] login() returns true for valid credentials",
      "   - [verbatim] `grep -rn \"oldSymbol\" src/` returns zero matches  ",
      "- [file] `src/foo.ts` contains the substring `bar`",
      "- [verbatim] File `src/legacy.ts` does not exist after this story",
    ].join("\n");
    expect(extractVerbatimAcLines(spec)).toEqual([
      '- [verbatim] `grep -rn "oldSymbol" src/` returns zero matches',
      "- [verbatim] File `src/legacy.ts` does not exist after this story",
    ]);
  });

  test("returns empty when no [verbatim] lines exist", () => {
    expect(extractVerbatimAcLines("- [unit] does a thing\nplain prose")).toEqual([]);
  });

  test("matches the tag case-insensitively", () => {
    expect(extractVerbatimAcLines("- [VERBATIM] `x` is gone")).toHaveLength(1);
  });
});

describe("findMissingVerbatimAcs", () => {
  test("empty when the spec has no [verbatim] ACs", () => {
    const spec = "- [unit] login works\n- [file] `a.ts` contains `b`";
    expect(findMissingVerbatimAcs(spec, prdWithAcs("anything"))).toEqual([]);
  });

  test("not missing when the backtick command survives verbatim in a PRD AC", () => {
    const spec = '- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches';
    const prd = prdWithAcs('When cleanup completes, `grep -rn "runThreeSessionTdd" src/ test/` returns 0 matches.');
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("tolerates whitespace and backtick-formatting differences", () => {
    const spec = '- [verbatim] `grep -rn "oldSym"   src/` returns zero matches';
    // PRD dropped backticks and reflowed whitespace — still the same literal tokens.
    const prd = prdWithAcs('After this story, grep -rn "oldSym" src/ returns zero matches.');
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("missing when the command was paraphrased away", () => {
    const spec = '- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches';
    const prd = prdWithAcs("runThreeSessionTdd exports and usages are removed from the src and test trees.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  test("missing when a file-existence verbatim AC is dropped", () => {
    const spec = "- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story";
    const prd = prdWithAcs("The orchestrator module is deleted.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([spec.trim()]);
  });

  test("not missing when a file-existence verbatim AC path is preserved", () => {
    const spec = "- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story";
    const prd = prdWithAcs("When the story completes, file src/tdd/orchestrator.ts does not exist.");
    expect(findMissingVerbatimAcs(spec, prd)).toEqual([]);
  });

  test("missing when only some of the required tokens survive", () => {
    const spec = "- [verbatim] `src/a.ts` contains `EXPECTED_TOKEN` exactly `2` times";
    // a.ts present, count present, but the discriminating EXPECTED_TOKEN is gone.
    const prd = prdWithAcs("src/a.ts is referenced 2 times in the suite.");
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

  test("flags every dropped verbatim AC independently", () => {
    const spec = [
      "- [verbatim] `grep -rn \"A\" src/` returns zero matches",
      "- [verbatim] File `src/b.ts` does not exist",
    ].join("\n");
    const prd = prdWithAcs('grep -rn "A" src/ returns zero matches'); // first survives, second dropped
    expect(findMissingVerbatimAcs(spec, prd)).toEqual(["- [verbatim] File `src/b.ts` does not exist"]);
  });
});
