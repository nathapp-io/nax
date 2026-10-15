import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { isWorkflowMode, NaxConfigSchema, resolveWorkflowConfig, WORKFLOW_DEFAULTS } from "@/config";
import { pinRootOnlyKeysRaw } from "@/config/root-only-keys";

describe("workflow config", () => {
  test("defaults: workflow mode, every workflow default filled (Zod 4 prefault)", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.execution.mode).toBe("workflow");
    expect(parsed.workflow).toEqual({
      models: {},
      maxFixRounds: 5,
      maxBranchFixRounds: 2,
      finalGateRepairRounds: 1,
      preflight: true,
      publish: "pr",
      timeouts: {
        implementMs: 3_600_000,
        fixMs: 3_600_000,
        reviewMs: 1_800_000,
        ciWaitMs: 1_200_000,
        ciPollMs: 30_000,
      },
    });
  });

  test("AC-1: workflow.publish defaults to pr", () => {
    expect(NaxConfigSchema.parse({}).workflow.publish).toBe("pr");
  });

  test("AC-2: workflow.publish accepts push and none", () => {
    const push = NaxConfigSchema.safeParse({ workflow: { publish: "push" } });
    if (!push.success) throw new Error(`push should parse: ${push.error.message}`);
    expect(push.data.workflow.publish).toBe("push");
    const none = NaxConfigSchema.safeParse({ workflow: { publish: "none" } });
    if (!none.success) throw new Error(`none should parse: ${none.error.message}`);
    expect(none.data.workflow.publish).toBe("none");
  });

  test("AC-3: workflow.publish rejects an unknown mode", () => {
    const parsed = NaxConfigSchema.safeParse({ workflow: { publish: "draft" } });
    expect(parsed.success).toBe(false);
  });

  test("a partial block keeps the other defaults", () => {
    const parsed = NaxConfigSchema.parse({ workflow: { timeouts: { reviewMs: 60_000 } } });
    expect(parsed.workflow?.timeouts.reviewMs).toBe(60_000);
    expect(parsed.workflow?.timeouts.fixMs).toBe(3_600_000);
    expect(parsed.workflow?.maxFixRounds).toBe(5);
  });

  test("role models accept a ConfiguredModel", () => {
    const parsed = NaxConfigSchema.parse({
      workflow: {
        models: { storyReview: { agent: "native", model: "opencode-go/x[high]" }, branchReview: "powerful" },
      },
    });
    expect(parsed.workflow?.models.storyReview).toEqual({ agent: "native", model: "opencode-go/x[high]" });
    expect(parsed.workflow?.models.branchReview).toBe("powerful");
  });

  test("maxFixRounds must be an integer >= 1", () => {
    expect(() => NaxConfigSchema.parse({ workflow: { maxFixRounds: 0 } })).toThrow();
    expect(() => NaxConfigSchema.parse({ workflow: { maxFixRounds: 2.5 } })).toThrow();
  });

  // nax#2547 / nax#2548: the feature-level round caps are config, not module constants.
  test("maxBranchFixRounds and finalGateRepairRounds accept 0 and reject negatives or fractions", () => {
    const off = NaxConfigSchema.parse({ workflow: { maxBranchFixRounds: 0, finalGateRepairRounds: 0 } });
    expect(off.workflow.maxBranchFixRounds).toBe(0);
    expect(off.workflow.finalGateRepairRounds).toBe(0);
    expect(NaxConfigSchema.parse({ workflow: { maxBranchFixRounds: 4 } }).workflow.maxBranchFixRounds).toBe(4);
    expect(() => NaxConfigSchema.parse({ workflow: { maxBranchFixRounds: -1 } })).toThrow();
    expect(() => NaxConfigSchema.parse({ workflow: { maxBranchFixRounds: 1.5 } })).toThrow();
    expect(() => NaxConfigSchema.parse({ workflow: { finalGateRepairRounds: -1 } })).toThrow();
  });

  test("execution.mode rejects unknown values", () => {
    expect(() => NaxConfigSchema.parse({ execution: { mode: "turbo" } })).toThrow();
  });

  test("resolveWorkflowConfig / isWorkflowMode tolerate absent blocks", () => {
    expect(resolveWorkflowConfig(undefined)).toEqual(WORKFLOW_DEFAULTS);
    expect(isWorkflowMode(undefined)).toBe(false);
    expect(isWorkflowMode({ execution: { mode: "workflow" } })).toBe(true);
  });

  test("workflow and execution.mode are root-only: a package value is ignored with a warning", () => {
    const root = makeNaxConfig({ execution: { mode: "workflow" }, workflow: { maxFixRounds: 3 } });
    const warnings: string[] = [];
    const out = pinRootOnlyKeysRaw(
      { execution: { mode: "pipeline" }, workflow: { maxFixRounds: 9 } },
      root,
      "apps/api",
      (m) => warnings.push(m),
    );
    expect(out).toMatchObject({ execution: { mode: "workflow" }, workflow: { maxFixRounds: 3 } });
    expect(warnings.some((w) => w.includes("execution.mode is root-only"))).toBe(true);
    expect(warnings.some((w) => w.includes("workflow is root-only"))).toBe(true);
  });
});
