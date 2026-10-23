import { describe, expect, test } from "bun:test";
import {
  buildBranchPackageReadingNote,
  buildWorkflowBranchCoverageRetry,
  buildWorkflowBranchFixPrompt,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
  WORKFLOW_DESIGN_DECISIONS_ITEM,
  WORKFLOW_ENUMERATION_INSTRUCTION,
  WORKFLOW_QUALITY_CHECKLIST,
  WORKFLOW_REPLY_CONTRACT,
} from "@/prompts";

const finding = { id: "B1", kind: "quality", severity: "important", issue: "US-2 never calls the US-1 lock" };

describe("buildWorkflowBranchReviewPrompt", () => {
  const prompt = buildWorkflowBranchReviewPrompt({
    specPath: ".nax/features/f/spec.md",
    prdPath: "/repo/.nax/features/f/prd.json",
    preflightPath: "/out/workflow/f/r1/preflight.json",
    packagePath: "/out/workflow/f/r1/package-branch.diff",
    range: "seed0..HEAD",
    stories: [
      { id: "US-001", state: "complete" },
      { id: "US-002", state: "complete-gate-open", note: "red: lint" },
      { id: "US-003", state: "not-run" },
    ],
    minors: [{ id: "M1", storyId: "US-001", text: "rename tmp var" }],
    parked: [{ storyId: "US-002", text: "hold F3: flaky timer" }],
    cannotVerify: [{ storyId: "US-001", text: "Redis TTL behaviour" }],
    gateFindings: [{ id: "B1", kind: "gate", severity: "important", issue: "repo gate lint failed" }],
  });

  test("US-014 AC-7 lists shared design decisions as a remit bullet", () => {
    const remit = prompt.slice(prompt.indexOf("## Your remit"), prompt.indexOf(WORKFLOW_QUALITY_CHECKLIST));
    expect(remit).toContain(`\n- ${WORKFLOW_DESIGN_DECISIONS_ITEM}\n`);
    expect(remit).not.toContain("If project decisions are listed below");
  });

  test("names every input file", () => {
    for (const path of ["spec.md", "prd.json", "preflight.json", "package-branch.diff"]) expect(prompt).toContain(path);
  });

  test("lists story states, minors with ids, parked rulings, cannot-verify items and gate findings", () => {
    expect(prompt).toContain("- US-002: complete-gate-open (red: lint)");
    expect(prompt).toContain("- US-003: not-run");
    expect(prompt).toContain("[M1] US-001: rename tmp var");
    expect(prompt).toContain("US-002: hold F3: flaky timer");
    expect(prompt).toContain("US-001: Redis TTL behaviour");
    expect(prompt).toContain("[B1] [important/gate] repo gate lint failed");
  });

  test("states the remit, the shared checklist and the reply shape with minorTriage", () => {
    expect(prompt).toContain("Cross-story integration");
    expect(prompt).toContain("Reachability");
    expect(prompt).toContain(WORKFLOW_QUALITY_CHECKLIST);
    expect(prompt).toContain(WORKFLOW_ENUMERATION_INSTRUCTION);
    expect(prompt).toContain('"minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]');
  });

  test("checks storage against every declared limit and gives the per-file diff command (nax#2486)", () => {
    expect(prompt).toContain("Storage against contracts");
    expect(prompt).toMatch(/column type and width/);
    expect(prompt).toContain("git diff seed0..HEAD -- <path>");
    expect(prompt).toContain("migration");
  });

  test("reviews its own files: no inlined diff, no truncation list, no do-not-re-review sentence (AC-9, AC-10, AC-15)", () => {
    expect(prompt).not.toContain("Do not re-review each story line by line");
    expect(prompt).not.toContain("full diff with context");
    expect(prompt).not.toContain("Files not shown in the diff");
  });

  test("asks for the most severe findings first, the inspected files and the observed excerpt (AC-11 to AC-14)", () => {
    expect(prompt).toContain("Put the most severe findings first");
    expect(prompt).toContain("List in inspectedFiles every file you read or diffed.");
    expect(prompt).toContain('"inspectedFiles": ["path"]');
    expect(prompt).toContain('"observed"');
  });

  test("the reading note carries the supplied range (AC-23)", () => {
    expect(buildBranchPackageReadingNote("seed0..HEAD")).toContain("git diff seed0..HEAD -- <path>");
  });

  test("empty sections read as none", () => {
    const empty = buildWorkflowBranchReviewPrompt({
      prdPath: "p",
      packagePath: "k",
      range: "seed0..HEAD",
      stories: [],
      minors: [],
      parked: [],
      cannotVerify: [],
      gateFindings: [],
    });
    expect(empty).toContain("(no spec file found)");
    expect(empty).toContain("(none)");
    expect(empty).not.toContain("preflight.json");
    expect(empty).not.toContain("an item you leave out is reported as verified");
  });

  // Story-level cannot-verify items reach the record only through the branch verdict.
  test("asks the reviewer to settle or carry each story cannot-verify item", () => {
    expect(prompt).toContain('Repeat in your "cannotVerify" every one you still cannot verify');
    expect(prompt).toContain("an item you leave out is reported as verified");
  });

  test("tells the reviewer a deferred minor is triaged, never repeated as a finding", () => {
    expect(prompt).toContain("do not repeat a deferred minor as a finding");
  });

  // US-006 (nax#2527): the branch reviewer sees the repo-gate summary nax already recorded.
  const gateBase = {
    prdPath: "p",
    packagePath: "k",
    range: "seed0..HEAD",
    stories: [],
    minors: [],
    parked: [],
    cannotVerify: [],
    gateFindings: [],
  };

  test("states the repo gates that ran before this review (AC-12)", () => {
    const text = buildWorkflowBranchReviewPrompt({
      ...gateBase,
      repoGates: { ran: ["build", "test"], failing: [] },
    });
    expect(text).toContain("Repository gates before this review: build, test; failing: none.");
  });

  test("names the failing repo gates (AC-13)", () => {
    const text = buildWorkflowBranchReviewPrompt({
      ...gateBase,
      repoGates: { ran: ["build", "test"], failing: ["test"] },
    });
    expect(text).toContain("failing: test.");
  });

  test("no repo-gate summary reads as not run (AC-14)", () => {
    expect(buildWorkflowBranchReviewPrompt(gateBase)).toContain(
      "Repository gates before this review: not run; failing: none.",
    );
  });

  test("narrows cannotVerify to what neither the gates nor a scoped command can check (AC-15)", () => {
    const text = buildWorkflowBranchReviewPrompt(gateBase);
    expect(text).toContain("only what neither nax's gates nor a scoped command can check");
  });

  test("requires the command and error behind an unavailability claim (AC-19)", () => {
    expect(buildWorkflowBranchReviewPrompt(gateBase)).toContain(
      "Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.",
    );
  });

  // US-009: the reviewer cannot look for the story reports, so nax lists them with their state.
  const reports = (list: { storyId: string; path: string; present: boolean }[] | undefined) =>
    buildWorkflowBranchReviewPrompt({ ...gateBase, ...(list !== undefined ? { storyReports: list } : {}) });

  test("lists a present story report under a ## Story reports section right after ## Stories (AC-1)", () => {
    const text = reports([{ storyId: "US-001", path: "/r/US-001/report.md", present: true }]);
    expect(text).toContain("## Story reports");
    expect(text).toContain("- US-001: /r/US-001/report.md");
    expect(text.indexOf("## Story reports")).toBeGreaterThan(text.indexOf("## Stories"));
    expect(text.indexOf("## Story reports")).toBeLessThan(text.indexOf("## Repo gate failures"));
  });

  test("names a missing report and the path that does not exist (AC-2)", () => {
    const text = reports([{ storyId: "US-002", path: "/r/US-002/report.md", present: false }]);
    expect(text).toContain("- US-002: no report (/r/US-002/report.md does not exist)");
  });

  test("says how a stale missing-report claim is settled (AC-3)", () => {
    const text = reports([{ storyId: "US-001", path: "/r/US-001/report.md", present: true }]);
    expect(text).toContain(
      "A deferred minor or cannot-verify item that says a story's report is missing or unreadable is settled by this list",
    );
    expect(text).toContain('triage that minor "leave" and do not repeat the claim in "cannotVerify"');
  });

  test("no reports: no ## Story reports section, absent or empty (AC-4)", () => {
    expect(reports(undefined)).not.toContain("## Story reports");
    expect(reports([])).not.toContain("## Story reports");
  });
});

describe("buildWorkflowBranchCoverageRetry (US-003, nax#2532)", () => {
  const retry = buildWorkflowBranchCoverageRetry("seed0..HEAD", ["src/a.ts", "src/b.ts"]);

  test("lists every missing path, one per line (AC-2)", () => {
    expect(retry).toContain("- src/a.ts");
    expect(retry).toContain("- src/b.ts");
  });

  test("gives the per-file diff command for the branch range (AC-3)", () => {
    expect(retry).toContain("git diff seed0..HEAD -- <path>");
  });

  test("asks for the whole JSON object again (AC-4)", () => {
    expect(retry).toContain("Re-send the whole JSON object");
  });

  test("asks for every file read or diffed in this session, not only the new ones (AC-5)", () => {
    expect(retry).toContain(
      "List in inspectedFiles every file you have read or diffed in this session, not only the new ones.",
    );
  });
});

describe("buildWorkflowBranchReReviewPrompt", () => {
  test("scopes to the fix diff and asks for a verdict per id", () => {
    const prompt = buildWorkflowBranchReReviewPrompt({
      reportPath: "/out/feature-report.md",
      packagePath: "/out/package-branch-fix.diff",
      findings: [finding],
    });
    expect(prompt).toContain("/out/package-branch-fix.diff");
    expect(prompt).toContain("[B1]");
    expect(prompt).toContain("ADDRESSED|PARTIAL|NOT_ADDRESSED");
    expect(prompt).toContain("Do not re-review the rest of the branch");
    expect(prompt).toContain('Never list a residual again in "newFindings".');
  });
});

describe("buildWorkflowBranchFixPrompt", () => {
  test("fix everything now, full package suites, findings verbatim, report section, no sub-agents, the reply contract", () => {
    const prompt = buildWorkflowBranchFixPrompt({
      prdPath: "/repo/.nax/features/f/prd.json",
      reportPath: "/out/feature-report.md",
      findings: [finding],
    });
    expect(prompt).toContain("Fix every finding in this pass");
    expect(prompt).not.toContain("only fix pass");
    expect(prompt).toContain("run the full test command of every package you changed");
    expect(prompt).toContain("[B1] [important/quality] US-2 never calls the US-1 lock");
    expect(prompt).toContain('append a "Branch fix" section to /out/feature-report.md');
    expect(prompt).toContain("Do not dispatch sub-agents");
    expect(prompt).toContain(WORKFLOW_REPLY_CONTRACT);
  });
});
