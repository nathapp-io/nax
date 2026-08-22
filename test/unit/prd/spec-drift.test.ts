import { describe, expect, test } from "bun:test";
import { findSpecDriftViolations } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

function prdWithAcs(...acs: string[]) {
  return makePRD({ userStories: [makeStory({ acceptanceCriteria: acs })] });
}

describe("findSpecDriftViolations", () => {
  describe("deprecated-tag detection", () => {
    test.each([
      ["[grep] tag", "- [grep] `grep -rn foo src/` returns zero matches"],
      ["[file] tag", "- [file] `src/foo.ts` contains the string `bar`"],
      ["[verbatim] tag", "- [verbatim] File `src/old.ts` does not exist"],
      ["[GREP] uppercase", "- [GREP] `grep foo src/` returns 0"],
      ["numbered bullet with tag", "1. [file] `a.ts` contains `X`"],
    ])("flags %s as deprecated-tag", (_label, ac) => {
      const violations = findSpecDriftViolations(prdWithAcs(ac));
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("deprecated-tag");
      expect(violations[0].acIndex).toBe(0);
      expect(violations[0].ac).toBe(ac);
    });

    test("does not flag [unit], [integration], [cli] tags", () => {
      const prd = prdWithAcs(
        "- [unit] login() returns true for valid credentials",
        "- [integration] POST /users returns 201 with valid body",
        "- [cli] nax run --help exits 0",
      );
      expect(findSpecDriftViolations(prd)).toHaveLength(0);
    });

    test("does not flag untagged ACs", () => {
      expect(findSpecDriftViolations(prdWithAcs("saveUser() persists to database"))).toHaveLength(0);
    });
  });

  describe("shell-pattern detection", () => {
    test("flags shell pipe with a known command keyword on either side", () => {
      const violations = findSpecDriftViolations(prdWithAcs("- [unit] `grep -rn foo src/ | wc -l` returns 0"));
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("shell-pattern");
    });

    test("does not flag TypeScript union types inside backticks", () => {
      expect(findSpecDriftViolations(prdWithAcs("result is `Success | Failure`"))).toHaveLength(0);
      expect(findSpecDriftViolations(prdWithAcs("type is `'left' | 'right'`"))).toHaveLength(0);
    });

    test("flags wc inside backticks", () => {
      const violations = findSpecDriftViolations(prdWithAcs("`wc -l src/foo.ts` returns less than 600"));
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("shell-pattern");
    });

    test("flags grep with flags inside backticks", () => {
      const violations = findSpecDriftViolations(
        prdWithAcs("foo() throws when `grep -rn oldSymbol src/` returns matches"),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("shell-pattern");
    });

    test("does not flag pipe outside backticks", () => {
      expect(findSpecDriftViolations(prdWithAcs("accepts | as a separator in the input string"))).toHaveLength(0);
    });

    test("does not flag grep without flags", () => {
      // only 'grep -flag' is flagged; plain 'grep' in prose is not a reliable signal
      expect(findSpecDriftViolations(prdWithAcs("search result does not contain grep output"))).toHaveLength(0);
    });
  });

  describe("deprecated-tag takes priority over shell-pattern", () => {
    test("AC with both deprecated tag and shell pattern reports deprecated-tag", () => {
      const violations = findSpecDriftViolations(prdWithAcs("- [grep] `grep -rn foo src/ | wc -l` returns 0"));
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("deprecated-tag");
    });
  });

  describe("multi-story PRDs", () => {
    test("returns violations from all stories with correct storyId and acIndex", () => {
      const prd = makePRD({
        userStories: [
          makeStory({
            id: "US-001",
            acceptanceCriteria: ["- [unit] login works", "- [grep] `grep foo` returns 0"],
          }),
          makeStory({
            id: "US-002",
            acceptanceCriteria: ["- [unit] signup works", "`find src/ -name '*.ts' | wc -l` returns less than 100"],
          }),
        ],
      });
      const violations = findSpecDriftViolations(prd);
      expect(violations).toHaveLength(2);
      expect(violations[0]).toMatchObject({ storyId: "US-001", acIndex: 1, reason: "deprecated-tag" });
      expect(violations[1]).toMatchObject({ storyId: "US-002", acIndex: 1, reason: "shell-pattern" });
    });

    test("returns empty for a clean PRD", () => {
      const prd = makePRD({
        userStories: [
          makeStory({ id: "US-001", acceptanceCriteria: ["- [unit] login works"] }),
          makeStory({ id: "US-002", acceptanceCriteria: ["- [integration] POST /users returns 201"] }),
        ],
      });
      expect(findSpecDriftViolations(prd)).toHaveLength(0);
    });

    test("handles stories with empty acceptanceCriteria", () => {
      const prd = makePRD({
        userStories: [makeStory({ id: "US-001", acceptanceCriteria: [] })],
      });
      expect(findSpecDriftViolations(prd)).toHaveLength(0);
    });
  });
});
