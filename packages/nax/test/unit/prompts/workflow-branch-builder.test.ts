import { describe, expect, test } from "bun:test";
import {
  buildWorkflowBranchFixPrompt,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
  WORKFLOW_REPLY_CONTRACT,
} from "@/prompts";

const finding = { id: "B1", kind: "quality", severity: "important", issue: "US-2 never calls the US-1 lock" };

describe("buildWorkflowBranchReviewPrompt", () => {
  const prompt = buildWorkflowBranchReviewPrompt({
    specPath: ".nax/features/f/spec.md",
    prdPath: "/repo/.nax/features/f/prd.json",
    preflightPath: "/out/workflow/f/r1/preflight.json",
    packagePath: "/out/workflow/f/r1/package-branch.diff",
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

  test("states the remit, no per-function walk, and the reply shape with minorTriage", () => {
    expect(prompt).toContain("Cross-story integration");
    expect(prompt).toContain("Reachability");
    expect(prompt).toContain("Do not re-review each story line by line");
    expect(prompt).toContain('"minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]');
  });

  test("empty sections read as none", () => {
    const empty = buildWorkflowBranchReviewPrompt({
      prdPath: "p",
      packagePath: "k",
      stories: [],
      minors: [],
      parked: [],
      cannotVerify: [],
      gateFindings: [],
    });
    expect(empty).toContain("(no spec file found)");
    expect(empty).toContain("(none)");
    expect(empty).not.toContain("preflight.json");
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
    expect(prompt).toContain("ADDRESSED|NOT_ADDRESSED");
    expect(prompt).toContain("Do not re-review the rest of the branch");
  });
});

describe("buildWorkflowBranchFixPrompt", () => {
  test("one pass only, findings verbatim, report section, no sub-agents, the reply contract", () => {
    const prompt = buildWorkflowBranchFixPrompt({
      prdPath: "/repo/.nax/features/f/prd.json",
      reportPath: "/out/feature-report.md",
      findings: [finding],
    });
    expect(prompt).toContain("only fix pass");
    expect(prompt).toContain("[B1] [important/quality] US-2 never calls the US-1 lock");
    expect(prompt).toContain('append a "Branch fix" section to /out/feature-report.md');
    expect(prompt).toContain("Do not dispatch sub-agents");
    expect(prompt).toContain(WORKFLOW_REPLY_CONTRACT);
  });
});
