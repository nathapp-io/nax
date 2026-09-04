import { describe, expect, test } from "bun:test";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

/** The rest of ExecutionConfig's required fields, so only compaction is under test. */
const base = {
  maxIterations: 3,
  iterationDelayMs: 0,
  costLimit: 10,
  maxStoriesPerFeature: 10,
  rectification: {},
  regressionGate: {},
  smartTestRunner: {},
};

describe("execution.compaction", () => {
  test("defaults to enabled at 90% with 30% kept", () => {
    const parsed = ExecutionConfigSchema.parse(base);
    expect(parsed.compaction).toEqual({ enabled: true, compactAtPercent: 90, keepRecentPercent: 30 });
  });

  test("rejects a keep percentage that is not well below the trigger", () => {
    // 60 and 50 are both inside their own field ranges, but a transcript
    // compacted to 60% of the window still sits above a 50% trigger and would
    // re-fire every round trip. The cross-field check is what catches it.
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 50, keepRecentPercent: 60 },
    });
    expect(result.success).toBe(false);
  });

  test("accepts a keep percentage exactly 20 points below the trigger", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 70 },
    });
    expect(result.success).toBe(true);
  });

  test("accepts keepRecentPercent at 79, the field bound derived from compactAtPercent's max of 99 minus the refine's 20-point floor", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 99, keepRecentPercent: 79 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a trigger above 99, which would leave no headroom", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 100, keepRecentPercent: 30 },
    });
    expect(result.success).toBe(false);
  });
});
