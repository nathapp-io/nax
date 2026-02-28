/**
 * Runner config plugins integration test (US-007)
 *
 * Verifies that plugins[] from nax/config.json are passed to loadPlugins()
 * when the runner starts. This is the missing integration test that ensures
 * the config loader and plugin loader work together correctly.
 *
 * Focus: Integration between loadConfig() and loadPlugins() in runner.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config/loader";
import { loadPlugins } from "../../src/plugins/loader";

async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-runner-config-plugins-"));
  return tmpDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("Runner config plugins integration (US-007)", () => {
  let projectRoot: string;
  let naxDir: string;

  beforeEach(async () => {
    projectRoot = await createTempDir();
    naxDir = path.join(projectRoot, "nax");
    await fs.mkdir(naxDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(projectRoot);
  });

  test("config.plugins[] entries are passed to loadPlugins() when runner initializes", async () => {
    // Create a custom plugin directory
    const customPluginsDir = path.join(projectRoot, "custom-plugins");
    await fs.mkdir(customPluginsDir, { recursive: true });

    // Track plugin initialization
    const initTracker = path.join(projectRoot, "init-tracker.json");

    // Create a test plugin
    const testPluginCode = `
export default {
  name: "config-test-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    await fs.writeFile("${initTracker}", JSON.stringify({
      initialized: true,
      config: config
    }), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "test",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    }
  }
};
`;
    await fs.writeFile(path.join(customPluginsDir, "test-plugin.ts"), testPluginCode, "utf-8");

    // Create nax/config.json with plugins[] array
    const configContent = {
      plugins: [
        {
          module: "./custom-plugins/test-plugin.ts",
          config: {
            testKey: "test-value-123",
            enabled: true,
          },
        },
      ],
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Step 1: Load config (as runner does)
    const config = await loadConfig(naxDir);

    // Step 2: Verify plugins[] is loaded into config
    expect(config.plugins).toBeDefined();
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins?.[0].module).toBe("./custom-plugins/test-plugin.ts");

    // Step 3: Simulate what runner does - pass config.plugins to loadPlugins()
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(naxDir, "plugins");
    const configPlugins = config.plugins || [];

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Step 4: Verify plugin was loaded and initialized
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe("config-test-plugin");

    // Step 5: Verify plugin's setup() was called with the correct config
    const tracker = JSON.parse(await fs.readFile(initTracker, "utf-8"));
    expect(tracker.initialized).toBe(true);
    expect(tracker.config).toEqual({
      testKey: "test-value-123",
      enabled: true,
    });
  });

  test("relative plugin paths in config.plugins[] are resolved relative to project root", async () => {
    // Create plugin in a subdirectory
    const pluginSubdir = path.join(projectRoot, "lib", "plugins");
    await fs.mkdir(pluginSubdir, { recursive: true });

    const initTracker = path.join(projectRoot, "relative-path-tracker.json");

    const pluginCode = `
export default {
  name: "relative-path-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    await fs.writeFile("${initTracker}", JSON.stringify({ loaded: true }), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "test",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    }
  }
};
`;
    await fs.writeFile(path.join(pluginSubdir, "plugin.ts"), pluginCode, "utf-8");

    // Create config with relative path
    const configContent = {
      plugins: [
        {
          module: "./lib/plugins/plugin.ts",
          config: {},
        },
      ],
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Load config
    const config = await loadConfig(naxDir);
    expect(config.plugins?.[0].module).toBe("./lib/plugins/plugin.ts");

    // Pass to loadPlugins with projectRoot (as runner does)
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(naxDir, "plugins");
    const configPlugins = config.plugins || [];

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Verify plugin was loaded
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe("relative-path-plugin");

    // Verify it was actually initialized (proves path resolution worked)
    const tracker = JSON.parse(await fs.readFile(initTracker, "utf-8"));
    expect(tracker.loaded).toBe(true);
  });

  test("absolute plugin paths in config.plugins[] work without project root resolution", async () => {
    // Create plugin at an absolute path
    const absolutePluginDir = path.join(projectRoot, "absolute-location");
    await fs.mkdir(absolutePluginDir, { recursive: true });

    const initTracker = path.join(projectRoot, "absolute-tracker.json");

    const pluginCode = `
export default {
  name: "absolute-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    await fs.writeFile("${initTracker}", JSON.stringify({ absolutePath: true }), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "test",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    }
  }
};
`;
    const absolutePluginPath = path.join(absolutePluginDir, "plugin.ts");
    await fs.writeFile(absolutePluginPath, pluginCode, "utf-8");

    // Create config with absolute path
    const configContent = {
      plugins: [
        {
          module: absolutePluginPath,
          config: {},
        },
      ],
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Load config
    const config = await loadConfig(naxDir);
    expect(config.plugins?.[0].module).toBe(absolutePluginPath);

    // Pass to loadPlugins
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(naxDir, "plugins");
    const configPlugins = config.plugins || [];

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Verify plugin was loaded
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe("absolute-plugin");

    // Verify it was initialized
    const tracker = JSON.parse(await fs.readFile(initTracker, "utf-8"));
    expect(tracker.absolutePath).toBe(true);
  });

  test("missing plugin module from config.plugins[] logs clear error (does not crash runner)", async () => {
    // Capture console.error output
    const errorLogs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      // Create config with non-existent plugin
      const configContent = {
        plugins: [
          {
            module: "./nonexistent/missing-plugin.ts",
            config: {},
          },
        ],
      };
      await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

      // Load config
      const config = await loadConfig(naxDir);
      expect(config.plugins).toBeDefined();
      expect(config.plugins).toHaveLength(1);

      // Pass to loadPlugins (should not throw)
      const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
      const projectPluginsDir = path.join(naxDir, "plugins");
      const configPlugins = config.plugins || [];

      const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

      // Should return empty registry (plugin failed to load)
      expect(registry.plugins).toHaveLength(0);

      // Verify helpful error was logged
      const errorOutput = errorLogs.join("\n");
      expect(errorOutput).toContain("Failed to load plugin module");
      expect(errorOutput).toContain("./nonexistent/missing-plugin.ts");
      expect(errorOutput).toContain("Attempted path:");
      expect(errorOutput).toContain(path.join(projectRoot, "nonexistent/missing-plugin.ts"));
    } finally {
      console.error = originalError;
    }
  });

  test("empty config.plugins[] array results in no config-based plugins loaded", async () => {
    // Create config with empty plugins array
    const configContent = {
      plugins: [],
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Load config
    const config = await loadConfig(naxDir);
    expect(config.plugins).toBeDefined();
    expect(config.plugins).toHaveLength(0);

    // Pass to loadPlugins
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(naxDir, "plugins");
    const configPlugins = config.plugins || [];

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Should have no plugins (no global, no project, no config)
    expect(registry.plugins).toHaveLength(0);
  });

  test("undefined config.plugins in project config uses global config plugins if present", async () => {
    // Create config without plugins field
    const configContent = {
      routing: {
        strategy: "keyword",
      },
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Load config
    const config = await loadConfig(naxDir);
    // config.plugins may be defined from global config or undefined
    // The key is that runner should handle both cases with: config.plugins || []

    // Simulate runner's fallback: config.plugins || []
    const configPlugins = config.plugins || [];
    expect(Array.isArray(configPlugins)).toBe(true);

    // Pass to loadPlugins
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(naxDir, "plugins");

    // Should not throw
    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Registry should be valid (may have plugins from global config)
    expect(registry).toBeDefined();
    expect(Array.isArray(registry.plugins)).toBe(true);
  });

  test("config.plugins[] takes precedence over auto-discovered plugins (name collision)", async () => {
    // Create auto-discovery plugin in project plugins directory
    const projectPluginsDir = path.join(naxDir, "plugins");
    await fs.mkdir(projectPluginsDir, { recursive: true });

    const initTracker = path.join(projectRoot, "precedence-tracker.json");
    const initOrder: string[] = [];

    const autoDiscoveredPluginCode = `
export default {
  name: "collision-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    let tracker = [];
    try {
      tracker = JSON.parse(await fs.readFile("${initTracker}", "utf-8"));
    } catch {}
    tracker.push("auto-discovered");
    await fs.writeFile("${initTracker}", JSON.stringify(tracker), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "auto",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    }
  }
};
`;
    await fs.writeFile(path.join(projectPluginsDir, "plugin.ts"), autoDiscoveredPluginCode, "utf-8");

    // Create config-specified plugin with same name
    const customPluginsDir = path.join(projectRoot, "custom");
    await fs.mkdir(customPluginsDir, { recursive: true });

    const configPluginCode = `
export default {
  name: "collision-plugin",
  version: "2.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    let tracker = [];
    try {
      tracker = JSON.parse(await fs.readFile("${initTracker}", "utf-8"));
    } catch {}
    tracker.push("config-specified");
    await fs.writeFile("${initTracker}", JSON.stringify(tracker), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "config",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    }
  }
};
`;
    await fs.writeFile(path.join(customPluginsDir, "plugin.ts"), configPluginCode, "utf-8");

    // Create config with explicit plugin
    const configContent = {
      plugins: [
        {
          module: "./custom/plugin.ts",
          config: {},
        },
      ],
    };
    await fs.writeFile(path.join(naxDir, "config.json"), JSON.stringify(configContent, null, 2), "utf-8");

    // Load config
    const config = await loadConfig(naxDir);

    // Pass to loadPlugins
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const configPlugins = config.plugins || [];

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Should have both plugins loaded (name collision allowed, last one wins)
    expect(registry.plugins.length).toBeGreaterThanOrEqual(1);

    // Verify init order shows auto-discovered loads first, then config
    const tracker = JSON.parse(await fs.readFile(initTracker, "utf-8"));
    expect(tracker).toContain("auto-discovered");
    expect(tracker).toContain("config-specified");

    // Config plugin should be loaded last (overrides auto-discovered)
    const lastIndex = tracker.lastIndexOf("config-specified");
    expect(lastIndex).toBeGreaterThan(tracker.indexOf("auto-discovered"));
  });
});
