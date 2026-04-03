// RE-ARCH: keep
/**
 * Config Loader Tests
 *
 * Tests backward compatibility mapping of batchMode to mode enum.
 *
 * NOTE: The backward compat feature (loader.ts line 94-107) has a known limitation:
 * The check `!("mode" in llm)` always fails because DEFAULT_CONFIG has mode:"hybrid",
 * which gets merged before the backward compat check runs. This means batchMode->mode
 * mapping never actually happens unless the user provides an invalid mode value that
 * fails Zod validation, or unless they avoid the defaults entirely (global config).
 *
 * These tests document the ACTUAL behavior, not the intended behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigPath, loadConfig } from "../../../src/config/loader";
import { makeTempDir } from "../../helpers/temp";

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
