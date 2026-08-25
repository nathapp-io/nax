import { describe, expect, test } from "bun:test";
import { resolvePlanMode } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";
import { createPlanStrategy, RefinePlanStrategy } from "@/plan";

describe("NaxConfigSchema plan.mode refine", () => {
  test("accepts refine and rejects unknown modes", () => {
    const refineResult = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan, mode: "refine" },
    });
    const unknownResult = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan, mode: "unknown-mode" },
    });

    expect(refineResult.success).toBe(true);
    expect(unknownResult.success).toBe(false);
  });
});

describe("resolvePlanMode refine", () => {
  test("returns refine for explicit refine mode", () => {
    expect(resolvePlanMode({ plan: { mode: "refine" } } as NaxConfig)).toBe("refine");
  });

  test("returns debate when debate auto-selection is enabled", () => {
    expect(
      resolvePlanMode({
        debate: { enabled: true, stages: { plan: { enabled: true } } },
      } as NaxConfig),
    ).toBe("debate");
  });

  test("prefers explicit refine over debate auto-selection", () => {
    expect(
      resolvePlanMode({
        plan: { mode: "refine" },
        debate: { enabled: true, stages: { plan: { enabled: true } } },
      } as NaxConfig),
    ).toBe("refine");
  });
});

describe("createPlanStrategy refine", () => {
  test("returns a refine strategy instance", () => {
    const strategy = createPlanStrategy("refine" as Parameters<typeof createPlanStrategy>[0]);

    expect(strategy).toBeInstanceOf(RefinePlanStrategy);
  });
});
