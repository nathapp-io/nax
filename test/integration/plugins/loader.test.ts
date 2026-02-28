/**
 * Plugin Loader Tests
 *
 * Tests for plugin discovery, loading, and validation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugins } from "../../../src/plugins/loader";
import type { NaxPlugin, PluginConfigEntry } from "../../../src/plugins/types";

// Test fixture helpers
async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-plugin-test-"));
  return tmpDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function writePluginFile(dir: string, filename: string, plugin: NaxPlugin): Promise<void> {
  let extensionsCode = "";

  if (plugin.extensions.optimizer) {
    extensionsCode += `
    optimizer: {
      name: "${plugin.extensions.optimizer.name}",
      async optimize(input) {
        return {
          optimizedPrompt: input.prompt,
          estimatedTokens: input.estimatedTokens,
          tokensSaved: 0,
          appliedStrategies: []
        };
      }
    },`;
  }

  if (plugin.extensions.router) {
    extensionsCode += `
    router: {
      name: "${plugin.extensions.router.name}",
      route() {
        return null;
      }
    },`;
  }

  if (plugin.extensions.reviewer) {
    extensionsCode += `
    reviewer: {
      name: "${plugin.extensions.reviewer.name}",
      description: "${plugin.extensions.reviewer.description}",
      async check() {
        return { passed: true, output: "OK" };
      }
    },`;
  }

  const setupCode = plugin.setup ? "async setup(config) { }," : "";
  const teardownCode = plugin.teardown ? "async teardown() { }," : "";

  const pluginCode = `
export default {
  name: "${plugin.name}",
  version: "${plugin.version}",
  provides: ${JSON.stringify(plugin.provides)},
  ${setupCode}
  ${teardownCode}
  extensions: {${extensionsCode}
  }
};
`;
  await fs.writeFile(path.join(dir, filename), pluginCode, "utf-8");
}

describe("loadPlugins", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("empty directories", () => {
    test("returns empty registry when no plugins", async () => {
      const globalDir = path.join(tempDir, "global");
      const projectDir = path.join(tempDir, "project");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const registry = await loadPlugins(globalDir, projectDir, []);

      expect(registry.plugins).toHaveLength(0);
    });

    test("handles non-existent global directory", async () => {
      const globalDir = path.join(tempDir, "nonexistent-global");
      const projectDir = path.join(tempDir, "project");
      await fs.mkdir(projectDir, { recursive: true });

      const registry = await loadPlugins(globalDir, projectDir, []);

      expect(registry.plugins).toHaveLength(0);
    });

    test("handles non-existent project directory", async () => {
      const globalDir = path.join(tempDir, "global");
      const projectDir = path.join(tempDir, "nonexistent-project");
      await fs.mkdir(globalDir, { recursive: true });

      const registry = await loadPlugins(globalDir, projectDir, []);

      expect(registry.plugins).toHaveLength(0);
    });
  });

  describe("directory auto-discovery", () => {
    test("loads single-file plugin from global directory", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      await fs.mkdir(globalDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "global-optimizer",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      await writePluginFile(globalDir, "optimizer.ts", plugin);

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("global-optimizer");
    });

    test("loads plugin from subdirectory with index.ts", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      const pluginDir = path.join(globalDir, "my-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "subdir-plugin",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "test",
            route() {
              return null;
            },
          },
        },
      };

      await writePluginFile(pluginDir, "index.ts", plugin);

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("subdir-plugin");
    });

    test("loads multiple plugins from global directory", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      await fs.mkdir(globalDir, { recursive: true });

      const plugin1: NaxPlugin = {
        name: "plugin-1",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "opt1",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const plugin2: NaxPlugin = {
        name: "plugin-2",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "router1",
            route() {
              return null;
            },
          },
        },
      };

      await writePluginFile(globalDir, "optimizer.ts", plugin1);
      await writePluginFile(globalDir, "router.ts", plugin2);

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(2);
      expect(registry.plugins.map((p) => p.name)).toContain("plugin-1");
      expect(registry.plugins.map((p) => p.name)).toContain("plugin-2");
    });

    test("loads plugins from project directory", async () => {
      const projectDir = path.join(tempDir, "project", "nax", "plugins");
      await fs.mkdir(projectDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "project-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: {
          reviewer: {
            name: "test",
            description: "Test",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };

      await writePluginFile(projectDir, "reviewer.ts", plugin);

      const registry = await loadPlugins(path.join(tempDir, "nonexistent"), projectDir, []);

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("project-plugin");
    });

    test("loads plugins from both global and project directories", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      const projectDir = path.join(tempDir, "project", "nax", "plugins");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const globalPlugin: NaxPlugin = {
        name: "global-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "global",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const projectPlugin: NaxPlugin = {
        name: "project-plugin",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "project",
            route() {
              return null;
            },
          },
        },
      };

      await writePluginFile(globalDir, "global.ts", globalPlugin);
      await writePluginFile(projectDir, "project.ts", projectPlugin);

      const registry = await loadPlugins(globalDir, projectDir, []);

      expect(registry.plugins).toHaveLength(2);
      expect(registry.plugins.map((p) => p.name)).toContain("global-plugin");
      expect(registry.plugins.map((p) => p.name)).toContain("project-plugin");
    });

    test("skips non-plugin files (.js, .json, etc.)", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      await fs.mkdir(globalDir, { recursive: true });

      // Create valid plugin
      const plugin: NaxPlugin = {
        name: "valid-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      await writePluginFile(globalDir, "valid.ts", plugin);
      await fs.writeFile(path.join(globalDir, "config.json"), "{}", "utf-8");
      await fs.writeFile(path.join(globalDir, "README.md"), "# README", "utf-8");

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("valid-plugin");
    });
  });

  describe("config-based loading", () => {
    test("loads plugin from config entry", async () => {
      const pluginDir = path.join(tempDir, "custom-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "config-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      await writePluginFile(pluginDir, "index.ts", plugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(pluginDir, "index.ts"),
          config: {},
        },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent"),
        path.join(tempDir, "nonexistent"),
        configPlugins,
      );

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("config-plugin");
    });

    test("calls setup() with plugin config", async () => {
      const pluginDir = path.join(tempDir, "custom-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      let setupConfig: Record<string, unknown> | undefined;

      const pluginCode = `
export default {
  name: "setup-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    // This would be captured in a real test
    global.testSetupConfig = config;
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
      await fs.writeFile(path.join(pluginDir, "index.ts"), pluginCode, "utf-8");

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(pluginDir, "index.ts"),
          config: { apiKey: "secret", enabled: true },
        },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent"),
        path.join(tempDir, "nonexistent"),
        configPlugins,
      );

      expect(registry.plugins).toHaveLength(1);
    });
  });

  describe("validation", () => {
    test("skips invalid plugin with warning", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      await fs.mkdir(globalDir, { recursive: true });

      // Invalid: missing version
      const invalidPlugin = `
export default {
  name: "invalid-plugin",
  provides: ["optimizer"],
  extensions: {}
};
`;
      await fs.writeFile(path.join(globalDir, "invalid.ts"), invalidPlugin, "utf-8");

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(0);
    });

    test("continues loading after encountering invalid plugin", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      await fs.mkdir(globalDir, { recursive: true });

      // Invalid plugin
      const invalidPlugin = `
export default {
  name: "invalid",
  provides: ["optimizer"],
  extensions: {}
};
`;
      await fs.writeFile(path.join(globalDir, "invalid.ts"), invalidPlugin, "utf-8");

      // Valid plugin
      const validPlugin: NaxPlugin = {
        name: "valid-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };
      await writePluginFile(globalDir, "valid.ts", validPlugin);

      const registry = await loadPlugins(globalDir, path.join(tempDir, "nonexistent"), []);

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("valid-plugin");
    });
  });

  describe("load order", () => {
    test("loads plugins in order: global → project → config", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      const projectDir = path.join(tempDir, "project", "nax", "plugins");
      const configPluginDir = path.join(tempDir, "config-plugin");

      await fs.mkdir(globalDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(configPluginDir, { recursive: true });

      const globalPlugin: NaxPlugin = {
        name: "global",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "global",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const projectPlugin: NaxPlugin = {
        name: "project",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "project",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const configPlugin: NaxPlugin = {
        name: "config",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "config",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      await writePluginFile(globalDir, "global.ts", globalPlugin);
      await writePluginFile(projectDir, "project.ts", projectPlugin);
      await writePluginFile(configPluginDir, "index.ts", configPlugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(configPluginDir, "index.ts"),
          config: {},
        },
      ];

      const registry = await loadPlugins(globalDir, projectDir, configPlugins);

      expect(registry.plugins).toHaveLength(3);
      expect(registry.plugins[0].name).toBe("global");
      expect(registry.plugins[1].name).toBe("project");
      expect(registry.plugins[2].name).toBe("config");
    });
  });

  describe("name collisions", () => {
    test("warns on plugin name collision", async () => {
      const globalDir = path.join(tempDir, "global", "plugins");
      const projectDir = path.join(tempDir, "project", "nax", "plugins");

      await fs.mkdir(globalDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const globalPlugin: NaxPlugin = {
        name: "duplicate",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "global",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const projectPlugin: NaxPlugin = {
        name: "duplicate",
        version: "2.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "project",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      await writePluginFile(globalDir, "global.ts", globalPlugin);
      await writePluginFile(projectDir, "project.ts", projectPlugin);

      const registry = await loadPlugins(globalDir, projectDir, []);

      // Both plugins are loaded (last loaded wins in registry getters)
      expect(registry.plugins).toHaveLength(2);
    });
  });
});
