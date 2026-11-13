import { describe, expect, test } from "bun:test";
import type { BranchReviewPromptInput } from "@/prompts";
import { buildBranchDiffPartsNote, buildWorkflowBranchCoverageRetry, buildWorkflowBranchReviewPrompt } from "@/prompts";

const parts = [
  { path: "/run/package-branch-part-01.diff", files: ["a.ts"] },
  { path: "/run/package-branch-part-02.diff", files: ["a.ts", "b.ts"] },
];
const input: BranchReviewPromptInput = {
  packagePath: "/run/package-branch.diff",
  range: "s..HEAD",
  stories: [],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

describe("branch review diff parts", () => {
  test("AC-1: reading section names both absolute paths", () => {
    const prompt = buildWorkflowBranchReviewPrompt({ ...input, diffParts: parts });
    const section = prompt.split("## How to read the diff")[1].split("## Stories")[0];
    for (const part of parts) expect(section).toContain(part.path);
    expect(prompt).toContain(buildBranchDiffPartsNote(parts));
  });
  test("AC-2: reading instructions require whole ordered reads without bounds and list inspected files", () => {
    const prompt = buildWorkflowBranchReviewPrompt({ ...input, diffParts: parts });
    expect(prompt).toContain("Read every part whole and in order, with no `offset` or `limit`");
    expect(prompt).toContain("10 lines of context");
    expect(prompt).toContain("only for context the diff does not show");
    expect(prompt).toContain("every file whose diff you read");
  });
  test("AC-3: no claim the package holds no diff", () => {
    expect(buildWorkflowBranchReviewPrompt({ ...input, diffParts: parts })).not.toContain("This package holds no diff");
  });
  test("AC-4: package description names the part list", () => {
    expect(buildWorkflowBranchReviewPrompt({ ...input, diffParts: parts })).toContain(
      "commits, --stat, changed files and the list of diff parts",
    );
  });
  test("AC-5: empty parts preserve the absent-parts prompt", () => {
    expect(buildWorkflowBranchReviewPrompt({ ...input, diffParts: [] })).toBe(buildWorkflowBranchReviewPrompt(input));
  });
});

describe("branch coverage retry diff parts", () => {
  const progress = { attempt: 1, max: 3 };
  const mapped = new Map([["a.ts", ["package-branch-part-03.diff"]]]);
  test("AC-6: names the part beside the file", () => {
    expect(buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, progress, mapped)).toContain(
      "- a.ts (package-branch-part-03.diff)",
    );
  });
  test("AC-7: instructs whole part reads", () => {
    expect(buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, progress, mapped)).toContain(
      "Read whole the part named beside each file",
    );
  });
  test("AC-8: names all parts in order", () => {
    const map = new Map([["a.ts", ["package-branch-part-01.diff", "package-branch-part-02.diff"]]]);
    expect(buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, progress, map)).toContain(
      "- a.ts (package-branch-part-01.diff, package-branch-part-02.diff)",
    );
  });
  test("AC-9: unmapped files remain plain", () => {
    expect(buildWorkflowBranchCoverageRetry("s..HEAD", ["b.ts"], false, progress, mapped)).toContain("\n- b.ts\n");
  });
  test("AC-10: absent mapping preserves the original retry", () => {
    expect(
      buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, progress),
    ).toBe(`Your reply parsed, but its inspectedFiles does not cover every changed file. Read each of these with \`git diff s..HEAD -- <path>\` (or Read it, if the branch added it), and review it:
- a.ts

This is coverage retry 1 of 3. Read all of them before you reply; a file you leave out stays unread and keeps the PR a draft.

List in inspectedFiles every file you have read or diffed in this session, not only the new ones.
Re-send the whole JSON object: the same findings, plus anything the files above turned up.`);
  });
});
