import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opModelResolver, opSelector } from "@test/helpers";
import { decomposeOp, planInteractiveOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

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
});
