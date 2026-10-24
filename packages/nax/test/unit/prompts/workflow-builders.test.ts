import { describe, expect, test } from "bun:test";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowContinuePrompt,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReportPrompt,
  buildWorkflowReReviewPrompt,
  buildWorkflowRestartPrompt,
  buildWorkflowStoryReviewPrompt,
  REPAIR_VERIFICATION_RULE,
  WORKFLOW_REPLY_CONTRACT,
} from "@/prompts";
import { renderWorkflowFindings, WORKFLOW_ARTIFACTS_RULE } from "@/prompts/builders/workflow-implementer-builder";

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

  test.each([
    ["green", "green"],
    [undefined, "not run"],
    ["skipped", "skipped"],
    ["red", "red"],
  ] as const)("story review states full suite %s on the gates line (suite AC-1/2/3)", (suite, rendered) => {
    const text = buildWorkflowStoryReviewPrompt({
      ...storyReviewBase,
      gates: { lint: "green", typecheck: "green", scoped: "green", ...(suite ? { "full-suite": suite } : {}) },
    });
    expect(text.split("\n")).toContain(
      `nax ran these gates on this story before your review: lint green, typecheck green, scoped tests green, full suite ${rendered}.`,
    );
    expect(text).not.toContain("After your review nax runs the full test suite");
    expect(text).toContain('Do not list these gates in "cannotVerify": their results are stated here.');
    expect(text.includes("The full suite is red")).toBe(suite === "red");
  });

  test("story review no longer places the full suite after review (suite AC-4)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).not.toContain(
      "After your review nax runs the full test suite",
    );
  });

  test("story review excludes stated gates from cannotVerify (suite AC-5)", () => {
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).toContain(
      'Do not list these gates in "cannotVerify": their results are stated here.',
    );
  });

  test("story review leaves repository gates to nax's record (suite AC-6)", () => {
    const text = buildWorkflowStoryReviewPrompt(storyReviewBase);
    expect(text).toContain(
      'Once every story is done nax runs the repository gates; nax records whether they ran and what they returned, so do not list the repository gates in "cannotVerify" either.',
    );
    expect(text).not.toContain("if nax never reached one");
    expect(text.split("\n")).toContain(
      "nax ran these gates on this story before your review: lint not run, typecheck not run, scoped tests not run, full suite not run.",
    );
  });

  test("story review avoids duplicate red-suite findings immediately after the gates line (suite AC-7)", () => {
    const text = buildWorkflowStoryReviewPrompt({ ...storyReviewBase, gates: { "full-suite": "red" } });
    expect(text).toContain(
      "full suite red.\nThe full suite is red; nax already records its failures as open findings, so do not repeat them as findings.",
    );
  });

  test("story review preserves the host e2e rule (suite AC-9)", () => {
    expect(buildWorkflowStoryReviewPrompt({ ...storyReviewBase, e2eGate: true })).toContain(
      "nax runs the e2e suite as a repository gate on the host; do not list e2e journeys in cannotVerify.",
    );
    expect(buildWorkflowStoryReviewPrompt(storyReviewBase)).not.toContain("do not list e2e journeys in cannotVerify");
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

// US-003: the two warm-session prompts the workflow sends around an interrupted turn.
const continueInput = {
  storyId: "US-005",
  reportPath: "/r/report.md",
  limitMinutes: 60,
  budgetMinutes: 30,
  attempt: 1,
  maxAttempts: 1,
  changedFiles: ["src/a.ts"],
};

describe("buildWorkflowContinuePrompt", () => {
  test("AC-9: opens with the limit, the story, and the attempt's budget", () => {
    const text = buildWorkflowContinuePrompt(continueInput);
    expect(
      text.startsWith(
        "You were stopped at the 60-minute step limit before you finished story US-005. This is continue attempt 1 of 1; you have up to 30 minutes.",
      ),
    ).toBe(true);
  });

  test("AC-10: lists the changed files under their heading", () => {
    const text = buildWorkflowContinuePrompt({ ...continueInput, changedFiles: ["src/a.ts", "test/a.test.ts"] });
    expect(text).toContain("Files changed since the story base:\n- src/a.ts\n- test/a.test.ts");
  });

  test("AC-11: an empty list says nothing changed", () => {
    expect(buildWorkflowContinuePrompt({ ...continueInput, changedFiles: [] })).toContain(
      "No files have changed since the story base.",
    );
  });

  test("AC-12: an unreadable list tells the agent to check git status itself", () => {
    expect(buildWorkflowContinuePrompt({ ...continueInput, changedFiles: undefined })).toContain(
      "The changed-file list could not be read; check git status yourself.",
    );
  });

  test("AC-13: forbids redoing the work already on disk", () => {
    expect(buildWorkflowContinuePrompt(continueInput)).toContain(
      "Do not revert, delete or redo work that is already on disk.",
    );
  });

  test("AC-14: names the report path and the finishing steps, including the DONE_WITH_CONCERNS escape", () => {
    const text = buildWorkflowContinuePrompt(continueInput);
    expect(text).toContain(
      "When you are done, commit your work, write /r/report.md, and end your reply with the json status block.",
    );
    expect(text).toContain(
      "If you cannot finish in this turn, commit what you have, write the report marking each unfinished acceptance criterion, and reply DONE_WITH_CONCERNS.",
    );
  });

  test("AC-15: ends with the reply contract", () => {
    expect(buildWorkflowContinuePrompt(continueInput).endsWith(WORKFLOW_REPLY_CONTRACT)).toBe(true);
  });

  test("the blocks appear in the order the story specifies", () => {
    const text = buildWorkflowContinuePrompt(continueInput);
    const at = (needle: string) => {
      const index = text.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    expect(at("You were stopped at the 60-minute step limit")).toBe(0);
    expect(at("Files changed since the story base:")).toBeLessThan(at("Continue from where you stopped."));
    expect(at("Continue from where you stopped.")).toBeLessThan(at("When you are done, commit your work"));
    expect(at("When you are done, commit your work")).toBeLessThan(at(WORKFLOW_REPLY_CONTRACT));
  });

  test("it does not resend the brief: the warm session already holds it", () => {
    const text = buildWorkflowContinuePrompt(continueInput);
    expect(text).not.toContain("Read the brief");
    expect(text).not.toContain("# Brief:");
    expect(text).not.toContain("Acceptance criteria");
  });
});

describe("buildWorkflowReportPrompt", () => {
  const reportInput = { storyId: "US-005", reportPath: "/r/report.md" };

  test("AC-16: opens by naming the missing report", () => {
    expect(
      buildWorkflowReportPrompt(reportInput).startsWith(
        "Your report for story US-005 is missing: /r/report.md does not exist.",
      ),
    ).toBe(true);
  });

  test("AC-17: forbids touching any other file", () => {
    expect(buildWorkflowReportPrompt(reportInput)).toContain("Do not change any other file.");
  });

  test("AC-18: carries the artifacts rule and ends with the reply contract", () => {
    const text = buildWorkflowReportPrompt(reportInput);
    expect(text).toContain(WORKFLOW_ARTIFACTS_RULE);
    expect(text.endsWith(WORKFLOW_REPLY_CONTRACT)).toBe(true);
    expect(text.indexOf(WORKFLOW_ARTIFACTS_RULE)).toBeLessThan(text.indexOf(WORKFLOW_REPLY_CONTRACT));
  });

  test("names the four report sections the implement prompt asked for", () => {
    expect(buildWorkflowReportPrompt(reportInput)).toContain(
      "What was built, TDD evidence, Files changed, Decisions & assumptions",
    );
  });
});

describe("the interrupted-turn prompts are public", () => {
  test("AC-19: both builders are importable from the prompts barrel and return strings", () => {
    expect(typeof buildWorkflowContinuePrompt).toBe("function");
    expect(typeof buildWorkflowReportPrompt).toBe("function");
    expect(buildWorkflowContinuePrompt(continueInput)).toBeString();
    expect(buildWorkflowReportPrompt({ storyId: "US-005", reportPath: "/r/report.md" })).toBeString();
  });
});

/**
 * US-002: a check the session could not run is not a check it ran. The rule is shared by every
 * repair brief, so it lives beside the reply contract and is exported from the barrel.
 */
describe("REPAIR_VERIFICATION_RULE (US-002)", () => {
  test("AC-11: the barrel export is the exact rule", () => {
    expect(REPAIR_VERIFICATION_RULE).toBe(
      'If you cannot run a check here (for example the sandbox blocks its network, or its tool is missing), reply DONE_WITH_CONCERNS and name each such check in "concerns". Never reply DONE for a check you only reasoned about.',
    );
  });
});
