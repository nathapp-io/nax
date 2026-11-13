import { describe, expect, test } from "bun:test";
import { buildBranchPackageReadingNote, buildWorkflowBranchReviewPrompt } from "@/prompts";

const base = {
  packagePath: "package.diff",
  range: "s..HEAD",
  stories: [],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

describe("branch review required-file coverage", () => {
  const prompt = buildWorkflowBranchReviewPrompt({ ...base, requiredFiles: ["src/a.ts", "src/b.ts"] });

  test("AC-1/2: names the number and every required file", () => {
    expect(prompt).toContain("## Files you must review (2)");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
  });

  test("AC-3/4: explains coverage checking and draft consequence", () => {
    expect(prompt).toContain("nax compares your inspectedFiles with this list.");
    expect(prompt).toContain("Repo gates passing is not a review of a file");
    expect(prompt).toContain("an unread file keeps the PR a draft");
  });

  test("AC-5: required-file section follows diff-reading instructions", () => {
    expect(prompt.indexOf("## Files you must review")).toBeGreaterThan(prompt.indexOf("## How to read the diff"));
  });

  test("AC-6/7: omits the section when files are absent or empty", () => {
    expect(buildWorkflowBranchReviewPrompt(base)).not.toContain("## Files you must review");
    expect(buildWorkflowBranchReviewPrompt({ ...base, requiredFiles: [] })).not.toContain("## Files you must review");
  });
});

describe("branch package reading note", () => {
  test("AC-10/11: clarifies package contents and preserves the per-file diff command", () => {
    const note = buildBranchPackageReadingNote("s..HEAD");
    expect(note).toContain(
      "## How to read the diff\nThis package holds no diff, only the commit list, the --stat summary and the changed-file names.",
    );
    expect(note).toContain("git diff s..HEAD -- <path>");
  });
});
