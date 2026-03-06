import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "../../../src/config/schema";
import type { TddStrategy, TestStrategy } from "../../../src/config/schema";

describe("Config Validation", () => {
  test("accepts valid default config", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("rejects invalid version", () => {
    const config = {
      ...DEFAULT_CONFIG,
      version: 2, // Invalid version
    };
    const result = NaxConfigSchema.safeParse(config);
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
    const result = NaxConfigSchema.safeParse(config);
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
    const result = NaxConfigSchema.safeParse(config);
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
    const result = NaxConfigSchema.safeParse(config);
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
    const result = NaxConfigSchema.safeParse(config);
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
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    // Zod's min(1) validation will trim and reject whitespace
  });

  test("rejects empty tierOrder", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          tierOrder: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => e.message);
      expect(errorMessages.some((e) => e.includes("tierOrder must have at least one tier"))).toBe(true);
    }
  });

  test("rejects tierOrder with attempts out of range", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          tierOrder: [{ tier: "fast", attempts: 0 }],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("accepts custom tier names in tierOrder", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          tierOrder: [
            { tier: "free", attempts: 10 },
            { tier: "ultra", attempts: 1 },
          ],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
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
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("accepts any non-empty string as complexityRouting tier", () => {
    // Tiers are now extensible (z.string), validated against models at runtime
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          ...DEFAULT_CONFIG.autoMode.complexityRouting,
          simple: "custom-tier",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects empty string as complexityRouting tier", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        complexityRouting: {
          ...DEFAULT_CONFIG.autoMode.complexityRouting,
          simple: "",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
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
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("validates verificationTimeoutSeconds bounds", () => {
    const tooLow = {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, verificationTimeoutSeconds: 0 },
    };
    expect(NaxConfigSchema.safeParse(tooLow).success).toBe(false);

    const tooHigh = {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, verificationTimeoutSeconds: 7200 },
    };
    expect(NaxConfigSchema.safeParse(tooHigh).success).toBe(false);

    const valid = {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, verificationTimeoutSeconds: 120 },
    };
    expect(NaxConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("validates quality config extensions", () => {
    const config = {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        forceExit: true,
        detectOpenHandles: false,
        detectOpenHandlesRetries: 3,
        gracePeriodMs: 10000,
        drainTimeoutMs: 5000,
        shell: "/bin/bash",
        stripEnvVars: ["CLAUDECODE", "CUSTOM_VAR"],
        environmentalEscalationDivisor: 3,
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("LLM Routing Mode Config", () => {
  test("accepts one-shot mode", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "one-shot" as const,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.llm?.mode).toBe("one-shot");
    }
  });

  test("accepts per-story mode", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "per-story" as const,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.llm?.mode).toBe("per-story");
    }
  });

  test("accepts hybrid mode", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "hybrid" as const,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.llm?.mode).toBe("hybrid");
    }
  });

  test("rejects invalid mode value", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "ultra-batch",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("defaults to hybrid when mode not specified", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        strategy: "llm" as const,
        llm: {
          cacheDecisions: true,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    // Default is applied by loader, schema allows undefined
    expect(result.data.routing.llm?.mode).toBeUndefined();
  });

  test("accepts deprecated batchMode alongside mode", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "one-shot" as const,
          batchMode: true,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.llm?.mode).toBe("one-shot");
      expect(result.data.routing.llm?.batchMode).toBe(true);
    }
  });
});

describe("TDD Strategy Config", () => {
  test("TestStrategy type includes three-session-tdd-lite", () => {
    // Type-level check: ensure 'three-session-tdd-lite' is assignable to TestStrategy
    const strategy: TestStrategy = "three-session-tdd-lite";
    expect(strategy).toBe("three-session-tdd-lite");
  });

  test("TddStrategy type alias covers all four values", () => {
    const strategies: TddStrategy[] = ["auto", "strict", "lite", "off"];
    expect(strategies).toHaveLength(4);
  });

  test("default config has strategy: auto", () => {
    expect(DEFAULT_CONFIG.tdd.strategy).toBe("auto");
  });

  test("default config parses successfully", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tdd.strategy).toBe("auto");
    }
  });

  test("accepts strategy: strict", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tdd.strategy).toBe("strict");
    }
  });

  test("accepts strategy: lite", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "lite" as const },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tdd.strategy).toBe("lite");
    }
  });

  test("accepts strategy: off", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "off" as const },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tdd.strategy).toBe("off");
    }
  });

  test("rejects invalid strategy value", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "invalid-strategy" },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("backward compat: config without strategy field defaults to auto", () => {
    // Simulate a config file that was written before strategy was added (no strategy key)
    const { strategy: _omitted, ...tddWithoutStrategy } = DEFAULT_CONFIG.tdd;
    const config = { ...DEFAULT_CONFIG, tdd: tddWithoutStrategy };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tdd.strategy).toBe("auto");
    }
  });
});
