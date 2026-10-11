import { describe, expect, test } from "bun:test";
import {
  buildFinishBranchReviewPrompt,
  buildFinishFixPrompt,
  buildFinishReviewJsonRetry,
  buildFinishReviewJsonRetryCondensed,
  buildFinishSpecReviewPrompt,
} from "@/prompts";

describe("finish review prompts", () => {
  test("spec prompt names spec, PRD, changed files, decisions and the no-AC-rewalk remit", () => {
    const p = buildFinishSpecReviewPrompt({
      base: "origin/main",
      specPath: ".nax/features/f/spec.md",
      prdPath: ".nax/features/f/prd.json",
      changedFiles: ["src/a.ts"],
      decisions: "- D1 waived X",
    });
    expect(p).toContain(".nax/features/f/spec.md");
    expect(p).toContain(".nax/features/f/prd.json");
    expect(p).toContain("src/a.ts");
    expect(p).toContain("- D1 waived X");
    expect(p).toContain("Do not re-check acceptance criteria one by one");
    expect(p).toContain('"findings"');
    expect(p).not.toContain("## WALK");
    expect(p).not.toContain("BRANCH_FIELDS");
    expect(p).not.toContain('"summary"');
  });

  test("branch prompt lists stories by id and title only, plus A3 hints, and asks for title + summary", () => {
    const p = buildFinishBranchReviewPrompt({
      base: "origin/main",
      stories: [{ id: "US-001", title: "Add store" }],
      changedFiles: ["src/a.ts"],
      hints: [{ file: "src/a.ts", line: 3, severity: "info", message: "stale comment", reason: "later only" }],
    });
    expect(p).toContain("US-001: Add store");
    expect(p).toContain("Previously skipped as not worth fixing");
    expect(p).toContain("src/a.ts:3 — stale comment (skipped: later only)");
    expect(p).toContain('"title"');
    expect(p).toContain('"summary"');
    expect(p).not.toContain("## WALK");
  });

  test("branch prompt without hints has no hints section", () => {
    const p = buildFinishBranchReviewPrompt({ base: "b", stories: [], changedFiles: [], hints: [] });
    expect(p).not.toContain("Previously skipped");
  });

  test("review fix prompt groups findings by source and keeps 1-based numbering across groups", () => {
    const p = buildFinishFixPrompt("review", {
      findings: [
        { severity: "HIGH", title: "Q1", problem: "qp", fix: "qf", source: "quality" },
        { severity: "MEDIUM", title: "S1", problem: "sp", fix: "sf", source: "spec" },
      ],
    });
    expect(p.indexOf("## Spec findings")).toBeLessThan(p.indexOf("## Quality findings"));
    expect(p).toContain("[1] [MEDIUM] S1");
    expect(p).toContain("[2] [HIGH] Q1");
    expect(p).toContain("## DISPOSITIONS");
  });

  test("gate fix prompt carries the gate output", () => {
    expect(buildFinishFixPrompt("gate", { gateOutput: "lint failed" })).toContain("lint failed");
  });

  test("acceptance fix prompt carries the acceptance output", () => {
    expect(buildFinishFixPrompt("acceptance", { acceptanceOutput: "AC-1 failed" })).toContain("AC-1 failed");
  });

  test("json retry asks for the object only", () => {
    expect(buildFinishReviewJsonRetry()).toContain('{"findings"');
  });

  test("condensed retry asks for shorter fields", () => {
    expect(buildFinishReviewJsonRetryCondensed()).toContain("shorter");
  });
});
