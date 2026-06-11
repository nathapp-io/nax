import { describe, expect, test } from "bun:test";
import { TierConfigSchema } from "@/config/schemas-model";

describe("TierConfigSchema", () => {
  test("parses valid tier without agent", () => {
    const result = TierConfigSchema.parse({ tier: "balanced", attempts: 3 });
    expect(result).toEqual({ tier: "balanced", attempts: 3 });
    expect(result.agent).toBeUndefined();
  });

  test("parses valid tier with agent", () => {
    const result = TierConfigSchema.parse({ tier: "balanced", attempts: 3, agent: "opencode" });
    expect(result).toEqual({ tier: "balanced", attempts: 3, agent: "opencode" });
  });

  test("rejects empty agent string", () => {
    expect(() => TierConfigSchema.parse({ tier: "balanced", attempts: 3, agent: "" })).toThrow();
  });

  test("strips unknown keys (default Zod behaviour)", () => {
    const result = TierConfigSchema.parse({ tier: "fast", attempts: 5, agent: "claude", extra: "ignored" });
    expect((result as Record<string, unknown>).extra).toBeUndefined();
  });
});
