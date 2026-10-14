/**
 * US-007 AC-1…AC-6: `parseClosingIssues` reads the explicit `Closes:` declarations of a feature
 * spec. Only a line that *starts* with `Closes:` outside a fenced code block declares anything,
 * and only bare `#N` tokens on it count.
 */
import { describe, expect, test } from "bun:test";
import { parseClosingIssues } from "@/workflow/closing-issues";

describe("parseClosingIssues (US-007)", () => {
  test("AC-1: a Closes: line lists its issues in the order written", () => {
    expect(parseClosingIssues("Closes: #2508, #2507")).toEqual([2508, 2507]);
  });

  test("AC-2: the keyword is case-insensitive and whitespace separates as well as a comma", () => {
    expect(parseClosingIssues("closes: #12 #13")).toEqual([12, 13]);
  });

  test("AC-3: two Closes: lines are deduped in first-appearance order", () => {
    expect(parseClosingIssues("Closes: #5, #6\nCloses: #6, #7")).toEqual([5, 6, 7]);
  });

  test("AC-4: a cross-repo reference and a bare number are not closing issues", () => {
    expect(parseClosingIssues("Closes: #12, koda#270, owner/repo#9, 14")).toEqual([12]);
  });

  test("AC-5: a Closes: line inside a fenced code block declares nothing", () => {
    const spec = ["# Spec", "", "```markdown", "Closes: #12", "```", "", "More prose."].join("\n");
    expect(parseClosingIssues(spec)).toEqual([]);
  });

  test("AC-6: prose that merely mentions an issue number declares nothing", () => {
    expect(parseClosingIssues("The retry has been bounded since #2491.")).toEqual([]);
  });

  test("a Closes: line mid-sentence is not a declaration", () => {
    expect(parseClosingIssues("See Closes: #9 for the rationale.")).toEqual([]);
  });

  test("a tilde fence hides a Closes: line the same way a backtick fence does", () => {
    expect(parseClosingIssues("~~~\nCloses: #12\n~~~")).toEqual([]);
  });

  test("a close declaration after the fence ends is read again", () => {
    const spec = ["```", "Closes: #12", "```", "Closes: #13"].join("\n");
    expect(parseClosingIssues(spec)).toEqual([13]);
  });

  test("leading whitespace on a declaration line is tolerated", () => {
    expect(parseClosingIssues("  Closes: #3")).toEqual([3]);
  });

  test("no Closes: line at all yields an empty list", () => {
    expect(parseClosingIssues("# Spec\n\nNothing to close here.\n")).toEqual([]);
  });

  test("a bare Closes: with no issue is an empty list", () => {
    expect(parseClosingIssues("Closes:\n")).toEqual([]);
  });
});
