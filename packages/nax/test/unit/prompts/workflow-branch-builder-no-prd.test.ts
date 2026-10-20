import { describe, expect, test } from "bun:test";
import { buildWorkflowBranchFixPrompt, buildWorkflowBranchReviewPrompt } from "@/prompts";

const reviewInput = {
  packagePath: "package.diff",
  range: "base..HEAD",
  stories: [],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

describe("buildWorkflowBranchReviewPrompt without a required PRD", () => {
  test.each([
    ["AC-1", {}, "(no PRD for this change)"],
    ["AC-2", { prdPath: "/r/.nax/features/f/prd.json" }, "/r/.nax/features/f/prd.json"],
  ])("%s renders the PRD line", (_ac, paths, expected) => {
    expect(buildWorkflowBranchReviewPrompt({ ...reviewInput, ...paths })).toContain(
      `- the PRD (stories and acceptance criteria): ${expected}`,
    );
  });
});

describe("buildWorkflowBranchFixPrompt optional source documents", () => {
  test.each([
    ["AC-3", { specPath: "docs/s.md" }, "Read the spec (docs/s.md) for what the feature must do."],
    ["AC-4", {}, "only re-checks what is still open."],
    [
      "AC-5",
      { specPath: "docs/s.md", prdPath: "p.json" },
      "Read the spec (docs/s.md) and the PRD (p.json) for what the feature must do.",
    ],
    ["AC-6", { prdPath: "p.json" }, "Read the PRD (p.json) for what the feature must do."],
  ])("%s ends the first paragraph with the available documents", (_ac, paths, expected) => {
    const prompt = buildWorkflowBranchFixPrompt({ ...paths, reportPath: "report.md", findings: [] });
    expect(prompt.split("\n\n")[0]?.endsWith(expected)).toBe(true);
    expect(prompt.split("\n\n")[1]).toBe("## Findings to fix");
  });
});
