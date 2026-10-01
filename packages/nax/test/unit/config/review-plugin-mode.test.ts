import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import { ReviewConfigSchema } from "@/config/schemas-review";

describe("ReviewConfigSchema.pluginMode", () => {
  const base = {
    enabled: true,
    checks: [],
    commands: {},
  };

  test("defaults to observational when omitted", () => {
    const parsed = ReviewConfigSchema.parse(base);
    expect(parsed.pluginMode).toBe("observational");
  });

  test("accepts gating", () => {
    const parsed = ReviewConfigSchema.parse({ ...base, pluginMode: "gating" });
    expect(parsed.pluginMode).toBe("gating");
  });

  test("rejects unknown values", () => {
    const result = ReviewConfigSchema.safeParse({ ...base, pluginMode: "block" });
    expect(result.success).toBe(false);
  });

  // Defect 1: the NaxConfigSchema literal default must also carry pluginMode,
  // because Zod returns the literal default object without re-parsing it.
  test("NaxConfigSchema base default carries observational pluginMode", () => {
    const cfg = NaxConfigSchema.parse({});
    expect(cfg.review.pluginMode).toBe("observational");
  });
});
