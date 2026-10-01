import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { globalConfigPath, loadConfig } from "@/config/loader";
import type { TddStrategy, TestStrategy } from "@/config/schema";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config/schema";

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

  test.each([
    ["maxIterations", { maxIterations: 0 }, "maxIterations must be > 0"],
    ["costLimit", { costLimit: -1 }, "costLimit must be > 0"],
    ["sessionTimeoutSeconds", { sessionTimeoutSeconds: 0 }, "sessionTimeoutSeconds must be > 0"],
  ] as const)("rejects %s <= 0", (_field, patch, errMsg) => {
    const config = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, ...patch } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((e) => e.message).some((msg) => msg.includes(errMsg))).toBe(true);
    }
  });

  test("rejects empty and whitespace-only agent.default", () => {
    for (const val of ["", "   "]) {
      const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: val } };
      const result = NaxConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success && val === "") {
        expect(
          result.error.issues.map((e) => e.message).some((msg) => msg.includes("agent.default must be non-empty")),
        ).toBe(true);
      }
    }
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
      agent: {
        ...DEFAULT_CONFIG.agent,
        default: "",
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("complexityRouting accepts non-empty string and rejects empty string", () => {
    const base = { ...DEFAULT_CONFIG, autoMode: { ...DEFAULT_CONFIG.autoMode } };
    const accepts = NaxConfigSchema.safeParse({
      ...base,
      autoMode: {
        ...base.autoMode,
        complexityRouting: { ...DEFAULT_CONFIG.autoMode.complexityRouting, simple: "custom-tier" },
      },
    });
    expect(accepts.success).toBe(true);
    const rejects = NaxConfigSchema.safeParse({
      ...base,
      autoMode: { ...base.autoMode, complexityRouting: { ...DEFAULT_CONFIG.autoMode.complexityRouting, simple: "" } },
    });
    expect(rejects.success).toBe(false);
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
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("LLM Routing Mode Config", () => {
  test.each(["one-shot", "per-story", "hybrid"] as const)("accepts mode: %s", (mode) => {
    const config = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: { mode } } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.routing.llm?.mode).toBe(mode);
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
    if (!result.success) return;
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

  test("default config has strategy: auto and parses successfully", () => {
    expect(DEFAULT_CONFIG.tdd.strategy).toBe("auto");
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tdd.strategy).toBe("auto");
  });

  test.each(["strict", "lite", "off"] as const)("accepts strategy: %s", (strategy) => {
    const config = { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tdd.strategy).toBe(strategy);
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

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader — backward compatibility and plugin configuration (US-007)
//
// Tests backward compatibility mapping of batchMode to mode enum.
//
// NOTE: The backward compat feature (loader.ts line 94-107) has a known
// limitation: The check `!("mode" in llm)` always fails because DEFAULT_CONFIG
// has mode:"hybrid", which gets merged before the backward compat check runs.
// This means batchMode->mode mapping never actually happens unless the user
// provides an invalid mode value that fails Zod validation, or unless they
// avoid the defaults entirely (global config).
//
// These tests document the ACTUAL behavior, not the intended behavior.
// ─────────────────────────────────────────────────────────────────────────────

describe("Config Loader - Backward Compatibility", () => {
  let tempDir: string;
  let globalConfigDirBackup: string | undefined;

  beforeEach(() => {
    // Create a temporary test directory
    tempDir = makeTempDir("nax-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    // Isolate global config to test fixture (never touch real ~/.nax)
    globalConfigDirBackup = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".nax-global");
  });

  afterEach(() => {
    // Clean up temp directory (includes isolated global config dir)
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    if (globalConfigDirBackup === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = globalConfigDirBackup;
    }
  });

  test("batchMode:true maps to mode:one-shot (backward compat)", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      routing: {
        strategy: "llm",
        llm: {
          batchMode: true,
          // mode not specified - should map from batchMode before default merge
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // applyBatchModeCompat runs on raw projConf before deepMerge with defaults,
    // so batchMode:true correctly maps to mode:"one-shot" overriding DEFAULT_CONFIG's "hybrid"
    expect(config.routing.llm?.mode).toBe("one-shot");
    expect(config.routing.llm?.batchMode).toBe(true);
  });

  test("explicit mode takes precedence over batchMode", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      routing: {
        strategy: "llm",
        llm: {
          batchMode: true,
          mode: "per-story", // Explicit mode overrides batchMode
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // Explicit mode is used, batchMode is ignored
    expect(config.routing.llm?.mode).toBe("per-story");
    expect(config.routing.llm?.batchMode).toBe(true);
  });

  test("rejects invalid batchMode value", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      routing: {
        strategy: "llm",
        llm: {
          batchMode: "yes", // Invalid - must be boolean
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    // Should throw validation error because Zod expects boolean
    await expect(loadConfig(join(tempDir, ".nax"))).rejects.toThrow("Invalid configuration");
  });

  test("uses DEFAULT_CONFIG mode when user config has no routing.llm", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      routing: {
        strategy: "keyword", // Different strategy, no llm config
      },
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // Should get "hybrid" from DEFAULT_CONFIG.routing.llm.mode
    expect(config.routing.llm?.mode).toBe("hybrid");
  });
});

describe("Config Loader - Plugin Configuration (US-007)", () => {
  let tempDir: string;
  let globalConfigDirBackup: string | undefined;

  beforeEach(() => {
    // Create a temporary test directory
    tempDir = makeTempDir("nax-test-plugins-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    // Isolate global config to test fixture (never touch real ~/.nax)
    globalConfigDirBackup = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".nax-global");
  });

  afterEach(() => {
    // Clean up temp directory (includes isolated global config dir)
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    if (globalConfigDirBackup === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = globalConfigDirBackup;
    }
  });

  test("loads plugins[] from config.json", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      plugins: [
        {
          module: "./custom-plugins/my-plugin.ts",
          config: {
            apiKey: "test-123",
            enabled: true,
          },
        },
        {
          module: "npm-plugin-package",
          config: {
            timeout: 5000,
          },
        },
      ],
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // Verify plugins array is loaded
    expect(config.plugins).toBeDefined();
    expect(config.plugins).toHaveLength(2);
    expect(config.plugins?.[0].module).toBe("./custom-plugins/my-plugin.ts");
    expect(config.plugins?.[0].config).toEqual({
      apiKey: "test-123",
      enabled: true,
    });
    expect(config.plugins?.[1].module).toBe("npm-plugin-package");
    expect(config.plugins?.[1].config).toEqual({
      timeout: 5000,
    });
  });

  test("handles missing plugins[] array (defaults to undefined)", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      routing: {
        strategy: "keyword",
      },
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // plugins[] is optional, should be undefined if not provided
    expect(config.plugins).toBeUndefined();
  });

  test("merges plugins[] from global and project config", async () => {
    // Create global config with plugins
    const globalPath = globalConfigPath();
    mkdirSync(join(tempDir, ".nax-global"), { recursive: true });
    const globalConfig = {
      plugins: [
        {
          module: "global-plugin",
          config: { global: true },
        },
      ],
    };
    writeFileSync(globalPath, JSON.stringify(globalConfig, null, 2));

    // Create project config with plugins
    const projectPath = join(tempDir, ".nax", "config.json");
    const projectConfig = {
      plugins: [
        {
          module: "project-plugin",
          config: { project: true },
        },
      ],
    };
    writeFileSync(projectPath, JSON.stringify(projectConfig, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));

    // Verify plugins are merged (project overrides global)
    expect(config.plugins).toBeDefined();
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins?.[0].module).toBe("project-plugin");
  });

  test("validates plugin config entries have required fields", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    const testConfig = {
      plugins: [
        {
          // Missing module field
          config: { foo: "bar" },
        },
      ],
    };
    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    // Should throw validation error
    await expect(loadConfig(join(tempDir, ".nax"))).rejects.toThrow("Invalid configuration");
  });
});
