import { afterEach, describe, expect, test } from "bun:test";
import { adversarialReviewOp, decomposeOp, planInteractiveOp, semanticReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeNaxConfig, makeTestRuntime, opModelResolver, opSelector } from "@test/helpers";

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
});

describe("operation timeout resolvers", () => {
  test("planInteractiveOp timeoutMs resolves from plan.timeoutSeconds", () => {
    runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };
    const timeoutMs = planInteractiveOp.timeoutMs?.(
      {
        specContent: "spec",
        codebaseContext: "",
        featureName: "feature",
        branchName: "feature-branch",
        outputPath: "/tmp/prd.json",
      },
      ctx,
    );
    expect(timeoutMs).toBe((ctx.config.plan.timeoutSeconds ?? 600) * 1000);
  });

  test("planInteractiveOp model resolves from plan.model config", () => {
    const config = makeNaxConfig({
      plan: {
        model: { agent: "opencode", model: "opencode-go/kimi-k2.6" },
      },
    });
    runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };

    const model = opModelResolver(planInteractiveOp)(
      {
        specContent: "spec",
        codebaseContext: "",
        featureName: "feature",
        branchName: "feature-branch",
        outputPath: "/tmp/prd.json",
      },
      ctx,
    );

    expect(model).toEqual({ agent: "opencode", model: "opencode-go/kimi-k2.6" });
  });

  test("decomposeOp timeoutMs prefers plan.decomposeTimeoutSeconds", () => {
    runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(decomposeOp.config)) };
    const timeoutMs = decomposeOp.timeoutMs?.(
      {
        specContent: "spec",
        codebaseContext: "",
      },
      ctx,
    );
    expect(timeoutMs).toBe((ctx.config.plan.decomposeTimeoutSeconds ?? ctx.config.plan.timeoutSeconds ?? 600) * 1000);
  });

  test("decomposeOp model resolves from plan.model config", () => {
    const config = makeNaxConfig({
      plan: {
        model: { agent: "opencode", model: "opencode-go/deepseek-v4-pro" },
      },
    });
    runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(decomposeOp.config)) };

    const model = opModelResolver(decomposeOp)(
      {
        specContent: "spec",
        codebaseContext: "",
      },
      ctx,
    );

    expect(model).toEqual({ agent: "opencode", model: "opencode-go/deepseek-v4-pro" });
  });

  test("semanticReviewOp timeoutMs resolves from semanticConfig.timeoutMs input", () => {
    runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(semanticReviewOp.config)) };
    const timeoutMs = semanticReviewOp.timeoutMs?.(
      {
        workdir: "/tmp/test",
        story: {
          id: "US-001",
          title: "title",
          description: "desc",
          acceptanceCriteria: ["AC-1"],
        },
        semanticConfig: {
          model: "balanced",
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
    runtime = makeTestRuntime();
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(adversarialReviewOp.config)) };
    const timeoutMs = adversarialReviewOp.timeoutMs?.(
      {
        workdir: "/tmp/test",
        story: {
          id: "US-002",
          title: "title",
          description: "desc",
          acceptanceCriteria: ["AC-1"],
        },
        adversarialConfig: {
          model: "balanced",
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
