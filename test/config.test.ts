import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, NgentConfigSchema } from "../src/config/schema";

describe("Config Validation", () => {
  test("accepts valid default config", () => {
    const result = NgentConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("rejects invalid version", () => {
    const config = {
      ...DEFAULT_CONFIG,
      version: 2, // Invalid version
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((msg) => msg.includes("Invalid version"))).toBe(true);
    }
  });

  test("rejects maxIterations <= 0", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxIterations: 0,
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((e) => e.includes("maxIterations must be > 0"))).toBe(true);
    }
  });

  test("rejects costLimit <= 0", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        costLimit: -1,
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((e) => e.includes("costLimit must be > 0"))).toBe(true);
    }
  });

  test("rejects sessionTimeoutSeconds <= 0", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        sessionTimeoutSeconds: 0,
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((e) => e.includes("sessionTimeoutSeconds must be > 0"))).toBe(true);
    }
  });

  test("rejects empty defaultAgent", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "",
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((msg) => msg.includes("defaultAgent must be non-empty"))).toBe(true);
    }
  });

  test("rejects whitespace-only defaultAgent", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "   ",
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    // Zod's min(1) validation will trim and reject whitespace
  });

  test("rejects escalation.maxAttempts <= 0", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          maxAttempts: 0,
        },
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((e) => e.includes("escalation.maxAttempts must be > 0"))).toBe(true);
    }
  });

  test("collects multiple validation errors", () => {
    const config = {
      ...DEFAULT_CONFIG,
      version: 99,
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
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("rejects invalid complexityRouting tier", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          ...DEFAULT_CONFIG.autoMode.complexityRouting,
          simple: "invalid-tier" as any,
        },
      },
    };
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
      expect(errorMessages.some((e) => e.includes("complexityRouting.simple"))).toBe(true);
    }
  });

  test("accepts all valid tiers in complexityRouting", () => {
    const config = {
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
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("validates all complexity levels have valid tiers", () => {
    const config = {
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
    const result = NgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
      expect(errorMessages.some((e) => e.includes("complexityRouting.simple"))).toBe(true);
      expect(errorMessages.some((e) => e.includes("complexityRouting.medium"))).toBe(true);
    }
  });
});
