import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { ParseValidationError } from "@/agents";
import { workflowConfigSelector } from "@/config";
import { type WorkflowBranchReviewInput, workflowBranchReviewOp } from "@/operations";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchReviewInput = {
  prompt: "review the branch",
  timeoutMs: 1000,
  minorIds: ["M1"],
  requiredFiles: [],
  range: "seed0..HEAD",
};

function modelFor(i: WorkflowBranchReviewInput, overrides: Record<string, unknown>) {
  const m = workflowBranchReviewOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchReviewOp", () => {
  test("shape: fresh wf-branch-review, stage review, read tools + Git + sandboxed Bash", () => {
    expect(workflowBranchReviewOp.session).toEqual({ role: "wf-branch-review", lifetime: "fresh" });
    expect(workflowBranchReviewOp.stage).toBe("review");
    expect(workflowBranchReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git", "Bash"]);
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

  test("timeout adds the step margin to the input timeout", () => {
    const t = workflowBranchReviewOp.timeoutMs;
    const ms = typeof t === "function" ? t(input, buildCtx()) : t;
    expect(ms).toBeGreaterThan(input.timeoutMs);
  });

  test("retry: an unparseable reply is retried with a JSON-only prompt, a truncated one with the condensed prompt", () => {
    const resolve = workflowBranchReviewOp.retry;
    if (typeof resolve !== "function") throw new Error("retry must be a resolver");
    const strategy = resolve(input, buildCtx());
    if (strategy === undefined || !("shouldRetry" in strategy)) throw new Error("retry must resolve to a strategy");
    const base = { site: "complete" as const, agentName: "claude", stage: "review" as const, storyId: "_run" };
    const invalid = strategy.shouldRetry(new ParseValidationError("bad"), 0, { ...base, lastOutput: "not json" });
    expect(invalid.retry).toBe(true);
    const truncated = strategy.shouldRetry(new ParseValidationError("bad"), 0, {
      ...base,
      lastOutput: '{"spec": "pass", "findings": [{"issue": "cut',
    });
    expect(truncated.retry).toBe(true);
    if (!invalid.retry || !truncated.retry) throw new Error("both replies must be retried");
    expect(truncated.nextPrompt).not.toBe(invalid.nextPrompt);
  });
});
