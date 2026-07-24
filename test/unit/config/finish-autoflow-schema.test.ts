import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("finish.autoFlow schema", () => {
  test("defaults: disabled, canonical flow path, telegram on", () => {
    const c = NaxConfigSchema.parse({ version: 1 });
    expect(c.finish.autoFlow.enabled).toBe(false);
    expect(c.finish.autoFlow.flowPath).toBe("flows/nax-finish/nax-finish.flow.ts");
    expect(c.finish.autoFlow.defaultAgent).toBeNull();
    expect(c.finish.autoFlow.reviewers).toEqual({ spec: null, quality: null });
    expect(c.finish.autoFlow.escalate.telegram).toBe(true);
  });

  test("accepts overrides", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { autoFlow: { enabled: true, reviewers: { spec: "adversarial", quality: "balanced" }, escalate: { telegram: false } } },
    });
    expect(c.finish.autoFlow.enabled).toBe(true);
    expect(c.finish.autoFlow.reviewers.spec).toBe("adversarial");
    expect(c.finish.autoFlow.escalate.telegram).toBe(false);
  });
});
