import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
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
      ciRepairRounds: 1,
      preflight: true,
      publish: "pr",
      interruptRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
      timeouts: {
        implementMs: 3_600_000,
        fixMs: 3_600_000,
        reviewMs: 1_800_000,
        ciWaitMs: 1_200_000,
        ciPollMs: 30_000,
        reportMs: 600_000,
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

  // US-006: the CI repair allowance of a published PR whose CI failed.
  test("AC-1: workflow.ciRepairRounds defaults to 1", () => {
    expect(NaxConfigSchema.parse({}).workflow.ciRepairRounds).toBe(1);
  });

  test("AC-2: workflow.ciRepairRounds rejects a negative round count", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { ciRepairRounds: -1 } }).success).toBe(false);
  });

  test("AC-3: workflow.ciRepairRounds has a non-empty description", () => {
    const description = FIELD_DESCRIPTIONS["workflow.ciRepairRounds"];
    expect(description).toBeString();
    expect(description.trim().length).toBeGreaterThan(0);
  });

  test("resolveWorkflowConfig / isWorkflowMode tolerate absent blocks", () => {
    expect(resolveWorkflowConfig(undefined)).toEqual(WORKFLOW_DEFAULTS);
    expect(isWorkflowMode(undefined)).toBe(false);
    expect(isWorkflowMode({ execution: { mode: "workflow" } })).toBe(true);
    expect(isWorkflowMode({ execution: {} })).toBe(true);
    expect(isWorkflowMode({ execution: { mode: "pipeline" } })).toBe(false);
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

// US-003: the interrupt-continue budgets and the report turn's timeout.
describe("workflow.interruptRetry and workflow.timeouts.reportMs", () => {
  test("AC-1: interruptRetry defaults to one attempt at half the limit that was hit", () => {
    expect(NaxConfigSchema.parse({}).workflow.interruptRetry).toEqual({ maxAttempts: 1, budgetMultiplier: 0.5 });
  });

  test("AC-2: timeouts.reportMs defaults to ten minutes", () => {
    expect(NaxConfigSchema.parse({}).workflow.timeouts.reportMs).toBe(600_000);
  });

  test("AC-3: interruptRetry.maxAttempts: 0 is accepted (it turns the continue off)", () => {
    const parsed = NaxConfigSchema.safeParse({ workflow: { interruptRetry: { maxAttempts: 0 } } });
    if (!parsed.success) throw new Error(`maxAttempts: 0 should parse: ${parsed.error.message}`);
    expect(parsed.data.workflow.interruptRetry.maxAttempts).toBe(0);
  });

  test("AC-4: interruptRetry.maxAttempts rejects a negative count", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { interruptRetry: { maxAttempts: -1 } } }).success).toBe(false);
  });

  test("AC-5: interruptRetry.maxAttempts rejects a fraction", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { interruptRetry: { maxAttempts: 1.5 } } }).success).toBe(false);
  });

  test("AC-6: interruptRetry.budgetMultiplier rejects 0", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { interruptRetry: { budgetMultiplier: 0 } } }).success).toBe(false);
  });

  test("AC-7: interruptRetry.budgetMultiplier rejects more than 1", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { interruptRetry: { budgetMultiplier: 1.5 } } }).success).toBe(false);
  });

  test("AC-8: timeouts.reportMs rejects 0", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { timeouts: { reportMs: 0 } } }).success).toBe(false);
  });

  test("a partial interruptRetry keeps the other default", () => {
    const parsed = NaxConfigSchema.parse({ workflow: { interruptRetry: { maxAttempts: 3 } } });
    expect(parsed.workflow.interruptRetry).toEqual({ maxAttempts: 3, budgetMultiplier: 0.5 });
  });

  test("every new key has a non-empty CLI description", () => {
    for (const key of [
      "workflow.interruptRetry",
      "workflow.interruptRetry.maxAttempts",
      "workflow.interruptRetry.budgetMultiplier",
      "workflow.timeouts.reportMs",
    ]) {
      expect(FIELD_DESCRIPTIONS[key]).toBeString();
      expect(FIELD_DESCRIPTIONS[key].trim().length).toBeGreaterThan(0);
    }
  });
});
