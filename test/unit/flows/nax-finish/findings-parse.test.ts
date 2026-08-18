import { describe, expect, test } from "bun:test";
import { parseDispositions, parseReviewReport } from "@flows/nax-finish/findings-parse";

const FULL_REPLY = `## TOUCHPOINTS
- src/agents/registry.ts:resolveDefaultAgent — every caller of the changed arg
- \`src/config/permissions.ts:resolvePermissions\` — the sibling implementations
- none-of-the-above.ts — deliberately not a sentinel

## WALK
AC-1 Covered — the loader reads the new key
AC-2 Missing — no test file exists for the refresh path

## FINDINGS
[HIGH] Loader ignores the validated value
  Problem: src/config/loader.ts:88 computes \`resolved\` and then builds the
  request from the raw input, so validation is dead.
  Fix: pass \`resolved\` into buildRequest.
[LOW] Stale docstring
  Problem: src/config/loader.ts:12 still names the removed key.
  Fix: update the docstring.
  Judgment: yes — the right wording is a call for the module owner.
`;

describe("parseReviewReport", () => {
  test("parses all three sections of a well-formed reply", () => {
    const r = parseReviewReport(FULL_REPLY);
    expect(r.sawTouchpointsSection).toBe(true);
    expect(r.sawWalkSection).toBe(true);
    expect(r.touchpoints).toHaveLength(3);
    expect(r.touchpoints[0]).toEqual({
      path: "src/agents/registry.ts",
      symbol: "resolveDefaultAgent",
      note: "every caller of the changed arg",
    });
    expect(r.walk).toEqual([
      "AC-1 Covered — the loader reads the new key",
      "AC-2 Missing — no test file exists for the refresh path",
    ]);
  });

  test("strips backticks from a touchpoint locator", () => {
    expect(parseReviewReport(FULL_REPLY).touchpoints[1].path).toBe("src/config/permissions.ts");
  });

  test("parses findings with multi-line Problem/Fix fields", () => {
    const r = parseReviewReport(FULL_REPLY);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].severity).toBe("HIGH");
    expect(r.findings[0].title).toBe("Loader ignores the validated value");
    expect(r.findings[0].problem).toContain("validation is dead");
    expect(r.findings[0].fix).toBe("pass `resolved` into buildRequest.");
  });

  test("reads a per-finding judgment marker", () => {
    const r = parseReviewReport(FULL_REPLY);
    expect(r.findings[0].judgment).toBeUndefined();
    expect(r.findings[1].judgment).toBe(true);
    expect(r.findings[1].judgmentReason).toBe("the right wording is a call for the module owner.");
  });

  test("recognises the No findings. sentinel", () => {
    const r = parseReviewReport("## TOUCHPOINTS\n- none — one-line docstring diff\n\n## WALK\nAC-1 Covered\n\n## FINDINGS\nNo findings.\n");
    expect(r.sawNoFindings).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.touchpoints).toEqual([{ path: "none", note: "one-line docstring diff" }]);
  });

  test("salvages findings from a reply with no headings at all", () => {
    const r = parseReviewReport("Here is what I found.\n[MEDIUM] Leaky handle\n  Problem: a.ts:3 never closes it.\n  Fix: close it.\n");
    expect(r.findings).toHaveLength(1);
    expect(r.sawTouchpointsSection).toBe(false);
    expect(r.sawWalkSection).toBe(false);
  });

  test("returns an empty report for prose that contains no blocks", () => {
    const r = parseReviewReport("I reviewed the diff and it all looks reasonable to me.");
    expect(r.findings).toEqual([]);
    expect(r.sawNoFindings).toBe(false);
  });

  test("reads a heading glued to the tail of the preceding narration line", () => {
    // acpx joins the agent's messages with no separator, so the first heading of
    // the final report lands mid-line whenever the last narration message did not
    // end in a newline. Real reply, run-2026-08-18T04-13-00-511Z.
    const r = parseReviewReport(
      "No defects cleared the confidence bar.## TOUCHPOINTS\n- a.ts:sym — why\n\n## WALK\nb.ts:fn — earns its place\n\n## FINDINGS\nNo findings.\n",
    );
    expect(r.sawTouchpointsSection).toBe(true);
    expect(r.touchpoints).toEqual([{ path: "a.ts", symbol: "sym", note: "why" }]);
    expect(r.walk).toEqual(["b.ts:fn — earns its place"]);
    expect(r.sawNoFindings).toBe(true);
  });

  test("leaves a well-formed heading at line start untouched", () => {
    const r = parseReviewReport(FULL_REPLY);
    expect(r.touchpoints).toHaveLength(3);
    expect(r.walk).toHaveLength(2);
  });

  // The three guards on GLUED_HEADING, each pinned by the case that fails
  // without it. Relaxing any of them silently costs a finding's detail, which is
  // the failure this whole seam exists to prevent — so none may go untested.

  test("does not split when whitespace separates the prose from the #", () => {
    // Adjacency is the signal: a concatenation artifact has no space before the
    // `#`, prose always does. Without the `\\s` half of `[^\\s#]` this splits, the
    // spurious heading flushes the finding, and its `Fix:` line is dropped.
    const r = parseReviewReport(
      "## FINDINGS\n[HIGH] t\n  Problem: see the block marked ## FINDINGS\n  Fix: do the thing\n",
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toBe("see the block marked ## FINDINGS");
    expect(r.findings[0].fix).toBe("do the thing");
  });

  test("does not split when the section word is not at end of line", () => {
    // Adjacency holds here (`.` abuts `##`), so only the `$` anchor rejects it.
    const r = parseReviewReport("## FINDINGS\n[HIGH] t\n  Problem: as noted.## FINDINGS below\n  Fix: f\n");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toBe("as noted.## FINDINGS below");
    expect(r.findings[0].fix).toBe("f");
  });

  test("does not split a well-formed heading at its own leading #", () => {
    // Without the `#` half of `[^\\s#]` the leading `#` satisfies the prefix
    // group and `## WALK` is rewritten to `#` + `# WALK`.
    const r = parseReviewReport("## WALK\nAC-1 Covered\n");
    expect(r.sawWalkSection).toBe(true);
    expect(r.walk).toEqual(["AC-1 Covered"]);
  });

  test("parses correctly even when sections appear out of the prescribed order", () => {
    const r = parseReviewReport(
      "## FINDINGS\n[MEDIUM] Out of order\n  Problem: p\n  Fix: f\n\n## WALK\nAC-1 Covered\n\n## TOUCHPOINTS\n- a.ts:sym — reason\n",
    );
    expect(r.sawTouchpointsSection).toBe(true);
    expect(r.sawWalkSection).toBe(true);
    expect(r.touchpoints).toEqual([{ path: "a.ts", symbol: "sym", note: "reason" }]);
    expect(r.walk).toEqual(["AC-1 Covered"]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe("Out of order");
  });
});

describe("parseDispositions", () => {
  test("parses fixed and rejected entries with evidence", () => {
    const d = parseDispositions(
      "## DISPOSITIONS\n[1] fixed\n[2] rejected — evidence: test/unit/config/loader.test.ts:42\n",
    );
    expect(d).toEqual([
      { index: 1, disposition: "fixed" },
      { index: 2, disposition: "rejected", evidence: "test/unit/config/loader.test.ts:42" },
    ]);
  });

  test("returns an empty list when the section is absent", () => {
    expect(parseDispositions('{"route":"proceed"}')).toEqual([]);
  });
});
