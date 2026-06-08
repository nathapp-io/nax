import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, TddConfigSchema } from "@/config";

describe("tdd.sessionTiers defaults", () => {
  test("materializes testWriter/verifier defaults when sessionTiers is absent", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
    });
    expect(parsed.sessionTiers?.testWriter).toBe("fast");
    expect(parsed.sessionTiers?.verifier).toBe("fast");
  });

  test("respects an explicit tier string", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
      sessionTiers: { testWriter: "balanced" },
    });
    expect(parsed.sessionTiers?.testWriter).toBe("balanced");
    expect(parsed.sessionTiers?.verifier).toBe("fast"); // default still applied
  });

  test("accepts a ConfiguredModel object ({ agent, model })", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
      sessionTiers: { verifier: { agent: "claude", model: "haiku" } },
    });
    expect(parsed.sessionTiers?.verifier).toEqual({ agent: "claude", model: "haiku" });
  });

  test("DEFAULT_CONFIG.tdd.sessionTiers reflects fast defaults (outer NaxConfigSchema path)", () => {
    expect(DEFAULT_CONFIG.tdd.sessionTiers?.testWriter).toBe("fast");
    expect(DEFAULT_CONFIG.tdd.sessionTiers?.verifier).toBe("fast");
  });
});
