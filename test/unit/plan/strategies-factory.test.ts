import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NaxError } from "@/errors";
import { DebatePlanStrategy, PipelinePlanStrategy, RefinePlanStrategy, SinglePlanStrategy } from "@/plan";

const PLAN_TS_PATH = join(import.meta.dir, "../../../src/cli/plan.ts");

describe("createPlanStrategy", () => {
  test.each([
    ["single", SinglePlanStrategy],
    ["pipeline", PipelinePlanStrategy],
    ["debate", DebatePlanStrategy],
    ["refine", RefinePlanStrategy],
  ])("returns a %s strategy instance", async (mode, StrategyClass) => {
    const strategyModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/strategies/index.ts")).href;
    const { createPlanStrategy } = await import(strategyModulePath);

    expect(createPlanStrategy(mode as "single" | "pipeline" | "debate" | "refine")).toBeInstanceOf(StrategyClass);
  });

  test("throws PLAN_MODE_UNKNOWN for an unrecognised mode", async () => {
    const strategyModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/strategies/index.ts")).href;
    const { createPlanStrategy } = await import(strategyModulePath);

    expect(() => createPlanStrategy("unknown" as never)).toThrow(NaxError);
    try {
      createPlanStrategy("unknown" as never);
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("PLAN_MODE_UNKNOWN");
    }
  });
});

describe("plan barrel", () => {
  test("re-exports createPlanStrategy from src/plan/index.ts", async () => {
    const planModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/index.ts")).href;
    const planModule = await import(planModulePath);

    expect(planModule.createPlanStrategy).toBeDefined();
    expect(planModule.SinglePlanStrategy).toBe(SinglePlanStrategy);
    expect(planModule.PipelinePlanStrategy).toBe(PipelinePlanStrategy);
    expect(planModule.DebatePlanStrategy).toBe(DebatePlanStrategy);
    expect(planModule.RefinePlanStrategy).toBe(RefinePlanStrategy);
  });
});

describe("plan command cut-over", () => {
  test("src/cli/plan.ts stays under 150 lines", async () => {
    const content = await Bun.file(PLAN_TS_PATH).text();
    const lineCount = content.split("\n").length;

    expect(lineCount).toBeLessThan(150);
  });

  test("src/cli/plan.ts no longer defines runPlanPipeline", async () => {
    const content = await Bun.file(PLAN_TS_PATH).text();

    expect(content).not.toContain("function runPlanPipeline");
    expect(content).not.toContain("const runPlanPipeline");
    expect(content).not.toContain("runPlanPipeline(");
  });

  test("src/cli/plan.ts keeps buildPlanComposition importable", async () => {
    const planModule = await import("@/cli");

    expect(planModule.buildPlanComposition).toBeDefined();
  });
});
