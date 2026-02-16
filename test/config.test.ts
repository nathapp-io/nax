import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config/schema";
import { validateConfig } from "../src/config/validate";
import type { NgentConfig } from "../src/config";

describe("Config Validation", () => {
  test("accepts valid default config", () => {
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects invalid version", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      version: 2 as 1, // Invalid version
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Invalid version: expected 1, got 2");
  });

  test("rejects maxIterations <= 0", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxIterations: 0,
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maxIterations must be > 0"))).toBe(true);
  });

  test("rejects costLimit <= 0", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        costLimit: -1,
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("costLimit must be > 0"))).toBe(true);
  });

  test("rejects sessionTimeoutSeconds <= 0", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        sessionTimeoutSeconds: 0,
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sessionTimeoutSeconds must be > 0"))).toBe(true);
  });

  test("rejects empty defaultAgent", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("defaultAgent must be non-empty");
  });

  test("rejects whitespace-only defaultAgent", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "   ",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("defaultAgent must be non-empty");
  });

  test("rejects escalation.maxAttempts <= 0", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          maxAttempts: 0,
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("escalation.maxAttempts must be > 0"))).toBe(true);
  });

  test("collects multiple validation errors", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      version: 99 as 1,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxIterations: 0,
        costLimit: -5,
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  test("rejects invalid complexityRouting tier", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          ...DEFAULT_CONFIG.autoMode.complexityRouting,
          simple: "invalid-tier" as any,
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("complexityRouting.simple"))).toBe(true);
    expect(result.errors.some((e) => e.includes("fast, balanced, powerful"))).toBe(true);
  });

  test("accepts all valid tiers in complexityRouting", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          simple: "fast",
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("validates all complexity levels have valid tiers", () => {
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          simple: "invalid" as any,
          medium: "bad-tier" as any,
          complex: "powerful",
          expert: "fast",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("complexityRouting.simple"))).toBe(true);
    expect(result.errors.some((e) => e.includes("complexityRouting.medium"))).toBe(true);
  });
});
