import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import { adversarialReviewOp } from "../../../src/operations/adversarial-review";
import { decomposeOp } from "../../../src/operations/decompose";
import { planOp } from "../../../src/operations/plan";
import { semanticReviewOp } from "../../../src/operations/semantic-review";

describe("operation timeout resolvers", () => {
  test("planOp timeoutMs resolves from plan.timeoutSeconds", () => {
    const runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planOp.config) };
    const timeoutMs = planOp.timeoutMs?.(
      {
        specContent: "spec",
        codebaseContext: "",
        featureName: "feature",
        branchName: "feature-branch",
      },
      ctx,
    );
    expect(timeoutMs).toBe((ctx.config.plan.timeoutSeconds ?? 600) * 1000);
  });

  test("decomposeOp timeoutMs prefers plan.decomposeTimeoutSeconds", () => {
    const runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(decomposeOp.config) };
    const timeoutMs = decomposeOp.timeoutMs?.(
      {
        specContent: "spec",
        codebaseContext: "",
      },
      ctx,
    );
    expect(timeoutMs).toBe((ctx.config.plan.decomposeTimeoutSeconds ?? ctx.config.plan.timeoutSeconds ?? 600) * 1000);
  });

  test("semanticReviewOp timeoutMs resolves from semanticConfig.timeoutMs input", () => {
    const runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(semanticReviewOp.config) };
    const timeoutMs = semanticReviewOp.timeoutMs?.(
      {
        story: {
          id: "US-001",
          title: "title",
          description: "desc",
          acceptanceCriteria: ["AC-1"],
        },
        semanticConfig: {
          modelTier: "balanced",
          diffMode: "ref",
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 321_000,
        },
        mode: "ref",
      },
      ctx,
    );
    expect(timeoutMs).toBe(321_000);
  });

  test("adversarialReviewOp timeoutMs resolves from adversarialConfig.timeoutMs input", () => {
    const runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(adversarialReviewOp.config) };
    const timeoutMs = adversarialReviewOp.timeoutMs?.(
      {
        story: {
          id: "US-002",
          title: "title",
          description: "desc",
          acceptanceCriteria: ["AC-1"],
        },
        adversarialConfig: {
          modelTier: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 654_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
        mode: "ref",
      },
      ctx,
    );
    expect(timeoutMs).toBe(654_000);
  });
});
