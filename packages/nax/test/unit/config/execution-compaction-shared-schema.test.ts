import { describe, expect, test } from "bun:test";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

const base = {
  maxIterations: 3,
  iterationDelayMs: 0,
  costLimit: 10,
  maxStoriesPerFeature: 10,
  rectification: {},
  regressionGate: {},
  smartTestRunner: {},
};

describe("execution.compaction on the shared settings schema", () => {
  test("fills each missing field with its default", () => {
    const parsed = ExecutionConfigSchema.parse({ ...base, compaction: { compactAtPercent: 80 } });
    expect(parsed.compaction).toEqual({ enabled: true, compactAtPercent: 80, keepRecentPercent: 30 });
  });

  test("keeps the refine message verbatim and reports it on the config path", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { compactAtPercent: 50, keepRecentPercent: 60 },
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.message).toBe("keepRecentPercent must be at least 20 points below compactAtPercent");
    expect(issue?.path).toEqual(["compaction"]);
  });

  test("rejects out-of-range and non-integer percentages", () => {
    for (const compaction of [{ compactAtPercent: 49 }, { keepRecentPercent: 4 }, { compactAtPercent: 90.5 }]) {
      expect(ExecutionConfigSchema.safeParse({ ...base, compaction }).success).toBe(false);
    }
  });
});
