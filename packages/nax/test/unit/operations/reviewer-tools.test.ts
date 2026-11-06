import { describe, expect, test } from "bun:test";
import {
  adversarialReviewOp,
  fixReviewOp,
  semanticReviewOp,
  workflowBranchReviewOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";

const REVIEWERS = [
  ["semantic", semanticReviewOp],
  ["adversarial", adversarialReviewOp],
  ["wf-story", workflowStoryReviewOp],
  ["wf-re", workflowReReviewOp],
  ["wf-branch", workflowBranchReviewOp],
] as const;

const story = { id: "US-1", title: "t", description: "d", acceptanceCriteria: ["a"] };
const BUILD_INPUTS: Record<string, unknown> = {
  semantic: { workdir: "/w", story, semanticConfig: { rules: [] }, mode: "embedded", diff: "d" },
  adversarial: { workdir: "/w", story, adversarialConfig: { rules: [] }, mode: "embedded", diff: "d" },
  "wf-story": { prompt: "p", timeoutMs: 1 },
  "wf-re": { prompt: "p", timeoutMs: 1, openIds: [] },
  "wf-branch": { prompt: "p", timeoutMs: 1, minorIds: [] },
};

describe("reviewer ops declare Bash (nax#2500)", () => {
  test.each(REVIEWERS)("%s declares Bash", (_name, op) => {
    expect(op.tools).toEqual(["Read", "Glob", "Grep", "Git", "Bash"]);
  });

  test.each(REVIEWERS)("%s build includes the reviewer-commands section", (name, op) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal per-op inputs, only build() is exercised
    const built = (op as any).build(BUILD_INPUTS[name], { config: {} });
    expect(built.instructions?.id).toBe("reviewer-commands");
  });

  test("fix-review is unchanged", () => {
    expect(fixReviewOp.tools).toEqual(["Read", "Glob", "Grep"]);
  });
});
