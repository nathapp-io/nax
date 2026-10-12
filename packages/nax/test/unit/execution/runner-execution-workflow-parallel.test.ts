import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { assertPipelineMode, effectiveParallelCount } from "@/execution/workflow-parallel";

describe("effectiveParallelCount", () => {
  test("pipeline mode passes the CLI value through", () => {
    expect(effectiveParallelCount(DEFAULT_CONFIG, 4, () => {})).toBe(4);
  });
  test("workflow mode forces 0 and warns once when parallel was requested", () => {
    const warnings: string[] = [];
    const cfg = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, mode: "workflow" as const } };
    expect(effectiveParallelCount(cfg, 4, (m) => warnings.push(m))).toBe(0);
    expect(warnings).toEqual(['execution.mode "workflow" runs stories one at a time; --parallel 4 ignored']);
  });
  test("workflow mode without --parallel stays undefined and silent", () => {
    const warnings: string[] = [];
    const cfg = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, mode: "workflow" as const } };
    expect(effectiveParallelCount(cfg, undefined, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("assertPipelineMode", () => {
  test("throws only in workflow mode", () => {
    const cfg = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, mode: "workflow" as const } };
    expect(() => assertPipelineMode(DEFAULT_CONFIG, "parallel-worker")).not.toThrow();
    expect(() => assertPipelineMode(cfg, "parallel-worker")).toThrow(/parallel-worker/);
  });
});
