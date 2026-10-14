import { describe, expect, test } from "bun:test";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReReviewPrompt,
  buildWorkflowRestartPrompt,
  buildWorkflowStoryReviewPrompt,
  WORKFLOW_REPLY_CONTRACT,
} from "@/prompts";
import { renderWorkflowFindings } from "@/prompts/builders/workflow-implementer-builder";

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

  test("restart prompt names the story and both paths, and carries the reply contract (US-001)", () => {
    const text = buildWorkflowRestartPrompt({
      storyId: "US-001",
      briefPath: "/b/brief.md",
      reportPath: "/b/report.md",
    });
    expect(text.startsWith("You have not started story US-001")).toBe(true);
    expect(text).toContain("/b/brief.md");
    expect(text).toContain("/b/report.md");
    // The spec's text verbatim, apart from the interpolations.
    expect(
      text,
    ).toBe(`You have not started story US-001: there are no commits, no changes and no report yet. Read the brief at
/b/brief.md now and implement it as it says. Write /b/report.md, commit your work, and end your reply with
the json status block.

${WORKFLOW_REPLY_CONTRACT}`);
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

  test("rendered findings carry the observed excerpt to the fixer (nax#2486)", () => {
    const text = renderWorkflowFindings([
      {
        id: "F1",
        kind: "spec",
        severity: "important",
        issue: "too narrow",
        observed: "note VARCHAR(191)",
        suggestion: "widen",
      },
    ]);
    expect(text).toContain("Observed: note VARCHAR(191)");
    expect(text.indexOf("Observed:")).toBeLessThan(text.indexOf("Suggestion:"));
  });

  test("story review does not demand an excerpt for a missing-test finding (nax#2486)", () => {
    const text = buildWorkflowStoryReviewPrompt({
      briefPath: "/b.md",
      reportPath: "/r.md",
      packagePath: "/p.diff",
      concerns: [],
    });
    expect(text).toContain("Start with these three files");
    expect(text).toContain("names the AC and the test file you checked instead");
    expect(text).toContain("Files not shown in the diff");
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

  // US-006 (nax#2527): the story reviewer sees nax's own gate results, so "not re-run" reads as a real gap.
  const storyReviewBase = { briefPath: "/b.md", reportPath: "/r.md", packagePath: "/p.diff", concerns: [] };

  test("story review states the recorded gate results (AC-1)", () => {
    const text = buildWorkflowStoryReviewPrompt({
      ...storyReviewBase,
      gates: { lint: "green", typecheck: "green", scoped: "green" },
    });
    expect(text).toContain("lint green, typecheck green, scoped tests green");
  });

  test("story review renders a gate with no recorded state as not run (AC-2)", () => {
    const text = buildWorkflowStoryReviewPrompt(storyReviewBase);
    expect(text).toContain("lint not run, typecheck not run, scoped tests not run");
  });

  test("story review names a skipped gate (AC-4)", () => {
    expect(buildWorkflowStoryReviewPrompt({ ...storyReviewBase, gates: { scoped: "skipped" } })).toContain(
      "scoped tests skipped",
    );
  });

  test("story review names a red gate (AC-5)", () => {
    expect(buildWorkflowStoryReviewPrompt({ ...storyReviewBase, gates: { lint: "red" } })).toContain("lint red");
  });

  test("story review says which gates run after it (AC-6)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).toContain(
      "After your review nax runs the full test suite on this story",
    );
  });

  // F1 (fix round 1): the suite is conditional — a red gate or an open finding ends the story first,
  // so a gate nax never reached stays reportable instead of being suppressed.
  test("story review qualifies the suite as conditional and keeps an unreached gate reportable (F1)", () => {
    const text = buildWorkflowStoryReviewPrompt(storyReviewBase);
    expect(text).toContain(
      "Both run only when the workflow reaches them: a red gate, or a finding left open, can end the story before the suite.",
    );
    expect(text).toContain(
      'Do not list any of these as something you could not verify; if nax never reached one, that is a real gap, so say so in "cannotVerify" and name it.',
    );
  });

  test("story review expects one scoped command over the story's own tests (AC-7)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).toContain(
      "run this story's own test files with one scoped test command",
    );
  });

  test("story review replaces the open-ended cannotVerify sentence (AC-8)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).not.toContain("Put anything you could not check in");
  });

  test("story review narrows cannotVerify to what neither the gates nor a scoped command can check (AC-9)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).toContain(
      "only what neither nax's gates nor a scoped command can check",
    );
  });

  test("story review requires the command and error behind an unavailability claim (AC-18)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).toContain(
      "Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.",
    );
  });

  // US-004 (nax#2524): the third verdict, the residual it must carry, and the dedupe it enables.
  test("re-review offers PARTIAL with a residual and forbids restating it in newFindings (AC-21)", () => {
    const text = buildWorkflowReReviewPrompt({
      briefPath: "/b.md",
      reportPath: "/r.md",
      packagePath: "/p-2.diff",
      findings: [{ id: "F1", kind: "quality", severity: "critical", issue: "leak" }],
    });
    expect(text).toContain("ADDRESSED|PARTIAL|NOT_ADDRESSED");
    expect(text).toContain('Never list a residual again in "newFindings".');
    expect(text).toContain('"residual": {"issue": "...", "suggestion": "...", "file": "path", "line": 0}');
    expect(text).toContain("describe only what remains");
    expect(text).not.toContain("ADDRESSED or NOT_ADDRESSED");
  });
});
