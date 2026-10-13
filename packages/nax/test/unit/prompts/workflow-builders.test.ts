import { describe, expect, test } from "bun:test";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReReviewPrompt,
  buildWorkflowStoryReviewPrompt,
} from "@/prompts";

const brief = {
  storyId: "US-003",
  title: "Invoice totals",
  description: "Compute totals.",
  acceptanceCriteria: ["Totals include tax", "Rounds half-even"],
  contextFiles: ["src/invoice.ts"],
  expectedFiles: ["src/totals.ts"],
  specPath: ".nax/features/billing/spec.md",
  specExcerpts: ["## US-003 Totals\nTax applies."],
  storyContext: "STORY CONTEXT",
  rulings: ["US-003 Ruling: follow the spec on rounding"],
  redBaseDependencies: [{ storyId: "US-001", reason: "full-suite red" }],
  reportPath: "/out/US-003/report.md",
};

describe("workflow builders", () => {
  test("brief: ACs numbered verbatim, spec path, excerpts, rulings, red-base warning", () => {
    const text = buildWorkflowBrief(brief);
    expect(text).toContain("AC-1: Totals include tax");
    expect(text).toContain("AC-2: Rounds half-even");
    expect(text).toContain(".nax/features/billing/spec.md");
    expect(text).toContain("## US-003 Totals");
    expect(text).toContain("follow the spec on rounding");
    expect(text).toContain("building on a red base");
    expect(text).toContain("US-001");
    expect(text).toContain("/out/US-003/report.md");
  });

  test("brief: no red-base section when every dependency is green", () => {
    expect(buildWorkflowBrief({ ...brief, redBaseDependencies: [] })).not.toContain("red base");
  });

  test("implement prompt carries the contract sections (W-R2)", () => {
    const text = buildWorkflowImplementPrompt({ storyId: "US-003", briefPath: "/b.md", reportPath: "/r.md" });
    for (const needle of [
      "/b.md",
      "/r.md",
      "TDD evidence",
      "failing",
      "Decisions & assumptions",
      "Do not dispatch sub-agents",
      '"status"',
      "NEEDS_CONTEXT",
      "commit",
    ]) {
      expect(text).toContain(needle);
    }
  });

  test("fix prompt: warm lists findings verbatim; fresh frames ownership and uncommitted files", () => {
    const findings = [{ id: "F2", kind: "spec", severity: "important", issue: "AC-2 untested", acId: "AC-2" }];
    const warm = buildWorkflowFixPrompt({
      mode: "warm",
      round: 1,
      maxRounds: 5,
      priorRounds: 0,
      findings,
      briefPath: "/b.md",
      reportPath: "/r.md",
      uncommittedFiles: [],
    });
    expect(warm).toContain("[F2]");
    expect(warm).toContain("AC-2 untested");
    expect(warm).not.toContain("you own it now");
    const fresh = buildWorkflowFixPrompt({
      mode: "fresh",
      round: 4,
      maxRounds: 5,
      priorRounds: 3,
      findings,
      briefPath: "/b.md",
      reportPath: "/r.md",
      uncommittedFiles: ["src/totals.ts"],
    });
    expect(fresh).toContain("tried 3 times");
    expect(fresh).toContain("you own it now");
    expect(fresh).toContain("src/totals.ts");
  });

  test("answer prompt quotes the answer", () => {
    expect(buildWorkflowAnswerPrompt("Use Postgres.")).toContain("Use Postgres.");
  });

  test("story review asks for the JSON shape and reads the three files", () => {
    const text = buildWorkflowStoryReviewPrompt({
      briefPath: "/b.md",
      reportPath: "/r.md",
      packagePath: "/p.diff",
      concerns: ["BLOCKED: no DB"],
    });
    for (const needle of [
      "/b.md",
      "/r.md",
      "/p.diff",
      '"spec"',
      '"quality"',
      '"cannotVerify"',
      "TDD evidence",
      "BLOCKED: no DB",
    ]) {
      expect(text).toContain(needle);
    }
  });

  test("story review walks each AC against the current code, not only the diff, and asks for evidence (nax#2486)", () => {
    const text = buildWorkflowStoryReviewPrompt({
      briefPath: "/b.md",
      reportPath: "/r.md",
      packagePath: "/p.diff",
      concerns: [],
    });
    expect(text).toContain("not as the only source of truth");
    expect(text).toContain("an earlier story");
    expect(text).toMatch(/schema/i);
    expect(text).toContain("migration");
    expect(text).toContain('"inspectedFiles"');
    expect(text).toContain('"observed"');
  });

  test("re-review lists open ids and scopes new breakage to the fix diff", () => {
    const text = buildWorkflowReReviewPrompt({
      briefPath: "/b.md",
      reportPath: "/r.md",
      packagePath: "/p-2.diff",
      findings: [{ id: "F1", kind: "quality", severity: "critical", issue: "leak" }],
    });
    expect(text).toContain("[F1]");
    expect(text).toContain("ADDRESSED");
    expect(text).toContain("NOT_ADDRESSED");
    expect(text).toContain("only in this fix diff");
  });
});
