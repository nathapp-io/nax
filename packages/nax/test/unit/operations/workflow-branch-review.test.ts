import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import { type WorkflowBranchReviewInput, workflowBranchReviewOp } from "@/operations";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchReviewInput = { prompt: "review the branch", timeoutMs: 1000, minorIds: ["M1"] };

function modelFor(i: WorkflowBranchReviewInput, overrides: Record<string, unknown>) {
  const m = workflowBranchReviewOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchReviewOp", () => {
  test("shape: fresh wf-branch-review, stage review, read tools + Git only", () => {
    expect(workflowBranchReviewOp.session).toEqual({ role: "wf-branch-review", lifetime: "fresh" });
    expect(workflowBranchReviewOp.stage).toBe("review");
    expect(workflowBranchReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
    expect(workflowBranchReviewOp.build(input, buildCtx()).task.content).toBe("review the branch");
  });

  test("model: input, then workflow.models.branchReview, then finish.reviewers.quality (spec §4)", () => {
    expect(modelFor(input, { finish: { reviewers: { quality: "fast" } } })).toBe("fast");
    expect(
      modelFor(input, {
        finish: { reviewers: { quality: "fast" } },
        workflow: { models: { branchReview: "powerful" } },
      }),
    ).toBe("powerful");
    expect(modelFor({ ...input, model: "balanced" }, { workflow: { models: { branchReview: "powerful" } } })).toBe(
      "balanced",
    );
  });

  test("parse triages the given minor ids", () => {
    const out = workflowBranchReviewOp.parse(
      JSON.stringify({ spec: "pass", quality: "approved", findings: [], cannotVerify: [] }),
      input,
      buildCtx(),
    );
    expect(out?.minorTriage).toEqual([{ id: "M1", decision: "leave" }]);
  });
});
