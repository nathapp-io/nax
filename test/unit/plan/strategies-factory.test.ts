import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import { RefinePlanStrategy, SinglePlanStrategy } from "@/plan";

const PLAN_TS_PATH = join(import.meta.dir, "../../../src/cli/plan.ts");
const PLAN_COMMAND_TS_PATH = join(import.meta.dir, "../../../src/cli/plan-command.ts");

describe("createPlanStrategy", () => {
  test.each([
    ["single", SinglePlanStrategy],
    ["refine", RefinePlanStrategy],
  ])("returns a %s strategy instance", async (mode, StrategyClass) => {
    const strategyModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/strategies/index.ts")).href;
    const { createPlanStrategy } = await import(strategyModulePath);

    expect(createPlanStrategy(mode as "single" | "refine")).toBeInstanceOf(StrategyClass);
  });

  test('throws PLAN_MODE_UNKNOWN for the retired "pipeline" mode', async () => {
    const strategyModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/strategies/index.ts")).href;
    const { createPlanStrategy } = await import(strategyModulePath);

    expect(() => (createPlanStrategy as (m: string) => unknown)("pipeline")).toThrow(NaxError);
    try {
      (createPlanStrategy as (m: string) => unknown)("pipeline");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("PLAN_MODE_UNKNOWN");
    }
  });

  test("throws PLAN_MODE_UNKNOWN for an unrecognised mode", async () => {
    const strategyModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/strategies/index.ts")).href;
    const { createPlanStrategy } = await import(strategyModulePath);

    expect(() => (createPlanStrategy as (m: string) => unknown)("unknown")).toThrow(NaxError);
    try {
      (createPlanStrategy as (m: string) => unknown)("unknown");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("PLAN_MODE_UNKNOWN");
    }
  });
});

describe("plan barrel", () => {
  test("re-exports createPlanStrategy from src/plan/index.ts", async () => {
    const planModulePath = pathToFileURL(join(import.meta.dir, "../../../src/plan/index.ts")).href;
    const planModule = await import(planModulePath);

    expect(planModule.createPlanStrategy).toBeDefined();
    expect(planModule.SinglePlanStrategy).toBe(SinglePlanStrategy);
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

  test("src/cli/plan-command.ts no longer defines runPlanPipeline", async () => {
    const content = await Bun.file(PLAN_COMMAND_TS_PATH).text();

    expect(content).not.toContain("function runPlanPipeline");
    expect(content).not.toContain("const runPlanPipeline");
    expect(content).not.toContain("runPlanPipeline(");
  });

  test("src/cli/plan-command.ts no longer exports buildPlanComposition", async () => {
    const content = await Bun.file(PLAN_COMMAND_TS_PATH).text();

    expect(content).not.toContain("buildPlanComposition");
  });
});
