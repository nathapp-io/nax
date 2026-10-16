/**
 * US-003 (SPEC-workflow-record-promote): the pure promotion text and forge argv — ticking the
 * open-item checklist in a PR body, the one evidence comment that states why each item is closed,
 * and the three forge command lines `nax workflow promote --yes` builds. Nothing here runs a
 * command; reading the PR and running these argv belongs to the command (US-004/US-005).
 */
import { describe, expect, test } from "bun:test";
import type { DecisionEntry, Disposition, SidecarKind } from "@/workflow/decisions-sidecar";
import { safeInline } from "@/workflow/pr-body-safe";
import { commentArgv, editBodyArgv, evidenceComment, markReadyArgv, tickChecklist } from "@/workflow/promote";

/** A `fixed` entry — the only disposition that carries a sha. */
const fixed = (id: string, over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id,
  kind: "finding",
  disposition: "fixed",
  reason: "retry fixed",
  sha: "a1b2c3d",
  ...over,
});

/** An entry for a disposition that takes no sha. */
const ruled = (id: string, disposition: Disposition, reason: string, kind: SidecarKind = "finding"): DecisionEntry => ({
  id,
  kind,
  disposition,
  reason,
});

const ZERO_WIDTH_SPACE = "\u200b";
const PR = "https://gh/pr/7";
const MR = "7";

describe("tickChecklist", () => {
  test("AC-1: ticks a fixed entry's line and names the id it ticked", () => {
    const body = "- [ ] **B1** (important, finding) `a.ts:3` — leak";
    const out = tickChecklist(body, [fixed("B1")]);
    expect(out.body).toBe("- [x] **B1** (important, finding) `a.ts:3` — leak — fixed in a1b2c3d");
    expect(out.ticked).toEqual(["B1"]);
  });

  test("AC-2: verified, confirmed, waived and overridden each append their own suffix", () => {
    const body = [
      "- [ ] **V** (finding) — leak",
      "- [ ] **C** (finding) — leak",
      "- [ ] **W** (finding) — leak",
      "- [ ] **O** (finding) — leak",
    ].join("\n");
    const entries = [
      ruled("V", "verified", "checked by hand"),
      ruled("C", "confirmed", "deferral accepted"),
      ruled("W", "waived", "out of scope"),
      ruled("O", "overridden", "ship it"),
    ];
    const out = tickChecklist(body, entries);
    expect(out.body).toBe(
      [
        "- [x] **V** (finding) — leak — verified",
        "- [x] **C** (finding) — leak — confirmed",
        "- [x] **W** (finding) — leak — waived: out of scope",
        "- [x] **O** (finding) — leak — overridden: ship it",
      ].join("\n"),
    );
    expect(out.ticked).toEqual(["V", "C", "W", "O"]);
  });

  test("AC-3: the suffix lands on the first line and the indented lines stay in place", () => {
    const body = ["- [ ] **B1** (finding) — leak", "  Suggestion: add a guard", "  Advisor: fix — risk", ""].join("\n");
    const out = tickChecklist(body, [fixed("B1")]);
    expect(out.body).toBe(
      [
        "- [x] **B1** (finding) — leak — fixed in a1b2c3d",
        "  Suggestion: add a guard",
        "  Advisor: fix — risk",
        "",
      ].join("\n"),
    );
  });

  test("AC-4: `B1` does not match the `**B10**` line", () => {
    const body = "- [ ] **B10** (finding) — x";
    expect(tickChecklist(body, [fixed("B1")])).toEqual({ body, ticked: [] });
  });

  test("AC-5: an id with a colon and an underscore ticks its own line", () => {
    const body = "- [ ] **_run:ci** (ci) — CI failed";
    const out = tickChecklist(body, [ruled("_run:ci", "confirmed", "green now", "ci")]);
    expect(out.body).toBe("- [x] **_run:ci** (ci) — CI failed — confirmed");
    expect(out.ticked).toEqual(["_run:ci"]);
  });

  test("AC-6: a line already ticked is left alone", () => {
    const body = "- [x] **B1** (finding) — leak — fixed in a1b2c3d";
    expect(tickChecklist(body, [fixed("B1")])).toEqual({ body, ticked: [] });
  });

  test("AC-7: an entry on no checklist line leaves the body byte for byte", () => {
    const body = "## Summary\n\nNothing to tick here.\n\ttrailing tab  \n";
    expect(tickChecklist(body, [fixed("B1")])).toEqual({ body, ticked: [] });
  });

  test("AC-10: a waived suffix neutralises its reason through safeInline", () => {
    const out = tickChecklist("- [ ] **B1** (finding) — leak", [ruled("B1", "waived", "ask @octocat")]);
    expect(out.body).toBe(`- [x] **B1** (finding) — leak — waived: ${safeInline("ask @octocat")}`);
  });

  test("a body holding two lines for one id ticks the first only", () => {
    const body = ["- [ ] **B1** (finding) — leak", "- [ ] **B1** (finding) — leak again"].join("\n");
    const out = tickChecklist(body, [fixed("B1")]);
    expect(out.body).toBe(
      ["- [x] **B1** (finding) — leak — fixed in a1b2c3d", "- [ ] **B1** (finding) — leak again"].join("\n"),
    );
    expect(out.ticked).toEqual(["B1"]);
  });

  test("the checklist line of a gate item ticks like any other", () => {
    const body = "- [ ] **G1** (gate) — final gate G1 is red; see the excerpt under Gates and CI";
    const out = tickChecklist(body, [ruled("G1", "verified", "rerun green", "gate")]);
    expect(out.body).toBe("- [x] **G1** (gate) — final gate G1 is red; see the excerpt under Gates and CI — verified");
    expect(out.ticked).toEqual(["G1"]);
  });

  test("a `fixed` entry without a sha degrades to the plain suffix", () => {
    const out = tickChecklist("- [ ] **B1** (finding) — leak", [
      { id: "B1", kind: "finding", disposition: "fixed", reason: "retry fixed" },
    ]);
    expect(out.body).toBe("- [x] **B1** (finding) — leak — fixed");
    expect(out.ticked).toEqual(["B1"]);
  });

  test("no entries leaves the body unchanged", () => {
    const body = "- [ ] **B1** (finding) — leak";
    expect(tickChecklist(body, [])).toEqual({ body, ticked: [] });
  });
});

describe("evidenceComment", () => {
  test("AC-8: the heading, a blank line, then one line per entry", () => {
    const entries = [fixed("B1", { reason: "retry fixed" }), ruled("D-1", "confirmed", "deferral accepted", "advisor")];
    const out = evidenceComment(entries);
    expect(out).toBe(
      [
        "## Resolved before ready",
        "",
        "- B1 (finding) fixed: retry fixed (a1b2c3d)",
        "- D-1 (advisor) confirmed: deferral accepted",
      ].join("\n"),
    );
  });

  test("AC-9: a reason's `@` mention is neutralised with a zero-width space", () => {
    const out = evidenceComment([fixed("B1", { reason: "ask @octocat" })]);
    const neutralised = safeInline("ask @octocat");
    expect(neutralised).toContain(`@${ZERO_WIDTH_SPACE}`);
    expect(out).toBe(["## Resolved before ready", "", `- B1 (finding) fixed: ${neutralised} (a1b2c3d)`].join("\n"));
  });

  test("AC-11: an entry id is neutralised through safeInline", () => {
    const out = evidenceComment([fixed("@team")]);
    const neutralised = safeInline("@team");
    expect(neutralised).toContain(`@${ZERO_WIDTH_SPACE}`);
    expect(out).toBe(
      ["## Resolved before ready", "", `- ${neutralised} (finding) fixed: retry fixed (a1b2c3d)`].join("\n"),
    );
  });

  test("only a fixed entry carries the sha in parentheses", () => {
    const out = evidenceComment([fixed("B1", { reason: "fixed the leak" }), ruled("V", "verified", "checked")]);
    expect(out).toBe(
      [
        "## Resolved before ready",
        "",
        "- B1 (finding) fixed: fixed the leak (a1b2c3d)",
        "- V (finding) verified: checked",
      ].join("\n"),
    );
  });

  test("no entries renders the heading alone", () => {
    expect(evidenceComment([])).toBe("## Resolved before ready\n");
  });
});

describe("forge argv", () => {
  test("AC-12: the body-writing argv of each forge", () => {
    expect(editBodyArgv("github", PR, "B")).toEqual(["gh", "pr", "edit", PR, "--body", "B"]);
    expect(editBodyArgv("gitlab", MR, "B")).toEqual(["glab", "mr", "update", MR, "--description", "B"]);
  });

  test("AC-13: the comment argv of each forge", () => {
    expect(commentArgv("github", PR, "T")).toEqual(["gh", "pr", "comment", PR, "--body", "T"]);
    expect(commentArgv("gitlab", MR, "T")).toEqual(["glab", "mr", "note", "create", MR, "-m", "T"]);
  });

  test("AC-14: the mark-ready argv of each forge", () => {
    expect(markReadyArgv("github", PR)).toEqual(["gh", "pr", "ready", PR]);
    expect(markReadyArgv("gitlab", MR)).toEqual(["glab", "mr", "update", MR, "--ready"]);
  });

  test("a multi-line body is passed as one argv element, unescaped", () => {
    const body = "## Summary\n\nline — two\n";
    expect(editBodyArgv("github", PR, body)).toEqual(["gh", "pr", "edit", PR, "--body", body]);
    expect(commentArgv("gitlab", MR, body)).toEqual(["glab", "mr", "note", "create", MR, "-m", body]);
  });
});
