// RE-ARCH: keep
/**
 * Plugin config path resolution tests
 *
 * Validates US-007 acceptance criteria:
 * 1. plugins[] from config.json are passed to loadPlugins() as configPlugins parameter
 * 2. Relative module paths in plugins[].module are resolved relative to project root
 * 3. Absolute module paths and npm package names work as-is
 * 4. If a plugin module cannot be found, a clear error message is logged with the path tried
 * 5. Plugin-specific config (plugins[].config) is passed to the plugin's setup() function
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeTempDir } from "@test/helpers";
import { _resetPluginErrorSink, _setPluginErrorSink, loadPlugins as loadPluginsWithBuiltins } from "@/plugins/loader";
import type { NaxPlugin, PluginConfigEntry } from "@/plugins/types";

const DISABLE_BUILTIN_PLUGINS = ["nax-curator", "nax-auto-pr"];

function loadPlugins(...args: Parameters<typeof loadPluginsWithBuiltins>): ReturnType<typeof loadPluginsWithBuiltins> {
  const [globalDir, projectDir, configPlugins, projectRoot, disabledPlugins, isTestFile] = args;
  return loadPluginsWithBuiltins(
    globalDir,
    projectDir,
    configPlugins,
    projectRoot,
    [...DISABLE_BUILTIN_PLUGINS, ...(disabledPlugins ?? [])],
    isTestFile,
  );
}

// Test fixture helpers
async function createTempDir(): Promise<string> {
  const tmpDir = makeTempDir("nax-plugin-config-test-");
  return tmpDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function writePluginFile(filePath: string, plugin: NaxPlugin, setupFn?: string): Promise<void> {
  let extensionsCode = "";

  if (plugin.extensions.optimizer) {
    extensionsCode += `
    optimizer: {
      name: "${plugin.extensions.optimizer.name}",
      async optimize(input) {
        return {
          prompt: input.prompt,
          originalTokens: 0,
          optimizedTokens: 0,
          savings: 0,
          appliedRules: []
        };
      }
    },`;
  }

  const setupCode = setupFn || (plugin.setup ? "async setup(config) { }," : "");
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
  await fs.writeFile(filePath, pluginCode, "utf-8");
}

describe("Plugin config path resolution (US-007)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("AC1: plugins[] from config.json passed to loadPlugins", () => {
    test("loads plugins from config array", async () => {
      const pluginDir = path.join(tempDir, "plugins");
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
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      await writePluginFile(path.join(pluginDir, "plugin.ts"), plugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(pluginDir, "plugin.ts"),
          config: {},
        },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("config-plugin");
    });

    test("loads multiple plugins from config array", async () => {
      const plugin1Dir = path.join(tempDir, "plugin1");
      const plugin2Dir = path.join(tempDir, "plugin2");
      await fs.mkdir(plugin1Dir, { recursive: true });
      await fs.mkdir(plugin2Dir, { recursive: true });

      const plugin1: NaxPlugin = {
        name: "plugin-one",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      const plugin2: NaxPlugin = {
        name: "plugin-two",
        version: "2.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      await writePluginFile(path.join(plugin1Dir, "index.ts"), plugin1);
      await writePluginFile(path.join(plugin2Dir, "index.ts"), plugin2);

      const configPlugins: PluginConfigEntry[] = [
        { module: path.join(plugin1Dir, "index.ts"), config: {} },
        { module: path.join(plugin2Dir, "index.ts"), config: {} },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      expect(registry.plugins).toHaveLength(2);
      expect(registry.plugins[0].name).toBe("plugin-one");
      expect(registry.plugins[1].name).toBe("plugin-two");
    });
  });

  describe("AC2: Relative module paths resolved relative to project root", () => {
    test("resolves ./relative/path from project root", async () => {
      const pluginDir = path.join(tempDir, "custom-plugins");
      await fs.mkdir(pluginDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "relative-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      await writePluginFile(path.join(pluginDir, "my-plugin.ts"), plugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: "./custom-plugins/my-plugin.ts",
          config: {},
        },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("relative-plugin");
    });

    test("blocks ../ traversal outside project root (SEC-1/SEC-2)", async () => {
      const projectRoot = path.join(tempDir, "project");
      const pluginDir = path.join(tempDir, "shared-plugins");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "parent-relative-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      await writePluginFile(path.join(pluginDir, "plugin.ts"), plugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: "../shared-plugins/plugin.ts",
          config: {},
        },
      ];

      await expect(
        loadPlugins(
          path.join(tempDir, "nonexistent-global"),
          path.join(tempDir, "nonexistent-project"),
          configPlugins,
          projectRoot,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });
    });
  });

  describe("AC3: Absolute paths and npm packages work as-is", () => {
    test("loads plugin with absolute path", async () => {
      const pluginDir = path.join(tempDir, "absolute-test");
      await fs.mkdir(pluginDir, { recursive: true });

      const plugin: NaxPlugin = {
        name: "absolute-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      const absolutePath = path.join(pluginDir, "plugin.ts");
      await writePluginFile(absolutePath, plugin);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: absolutePath,
          config: {},
        },
      ];

      const registry = await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("absolute-plugin");
    });

    test("treats non-relative paths as required npm packages", async () => {
      // This test verifies that npm package names (no ./ or ../) are passed through as-is
      // They fail to load since we don't have real npm packages; explicit entries fail fast.
      const configPlugins: PluginConfigEntry[] = [
        {
          module: "nonexistent-npm-package",
          config: {},
        },
      ];

      await expect(
        loadPlugins(
          path.join(tempDir, "nonexistent-global"),
          path.join(tempDir, "nonexistent-project"),
          configPlugins,
          tempDir,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });
    });
  });

  describe("AC4: Clear error message when plugin module not found", () => {
    test("logs helpful error for missing relative path", async () => {
      const errorLogs: string[] = [];
      _setPluginErrorSink((...args: unknown[]) => {
        errorLogs.push(args.map((arg) => String(arg)).join(" "));
      });

      try {
        const configPlugins: PluginConfigEntry[] = [
          {
            module: "./nonexistent/plugin.ts",
            config: {},
          },
        ];

        await expect(
          loadPlugins(
            path.join(tempDir, "nonexistent-global"),
            path.join(tempDir, "nonexistent-project"),
            configPlugins,
            tempDir,
          ),
        ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });

        // Should log error with original path
        const errorOutput = errorLogs.join("\n");
        expect(errorOutput).toContain("Failed to load plugin module");
        expect(errorOutput).toContain("./nonexistent/plugin.ts");
        expect(errorOutput).toContain("Attempted path:");
        expect(errorOutput).toContain(path.join(tempDir, "nonexistent/plugin.ts"));
      } finally {
        _resetPluginErrorSink();
      }
    });

    test("logs helpful error for missing absolute path", async () => {
      const errorLogs: string[] = [];
      _setPluginErrorSink((...args: unknown[]) => {
        errorLogs.push(args.map((arg) => String(arg)).join(" "));
      });

      try {
        const absolutePath = path.join(tempDir, "missing-plugin.ts");
        const configPlugins: PluginConfigEntry[] = [
          {
            module: absolutePath,
            config: {},
          },
        ];

        await expect(
          loadPlugins(
            path.join(tempDir, "nonexistent-global"),
            path.join(tempDir, "nonexistent-project"),
            configPlugins,
            tempDir,
          ),
        ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });

        const errorOutput = errorLogs.join("\n");
        expect(errorOutput).toContain("Failed to load plugin module");
        expect(errorOutput).toContain(absolutePath);
      } finally {
        _resetPluginErrorSink();
      }
    });
  });

  describe("AC5: Plugin-specific config passed to setup()", () => {
    test("passes config object to plugin setup function", async () => {
      const pluginDir = path.join(tempDir, "config-test");
      await fs.mkdir(pluginDir, { recursive: true });

      // Create a plugin that writes received config to a file we can check
      const configFile = path.join(tempDir, "received-config.json");
      const plugin: NaxPlugin = {
        name: "config-receiver",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      const setupFn = `
  async setup(config) {
    const fs = await import("node:fs/promises");
    await fs.writeFile("${configFile}", JSON.stringify(config), "utf-8");
  },`;

      await writePluginFile(path.join(pluginDir, "plugin.ts"), plugin, setupFn);

      const pluginConfig = {
        apiKey: "test-key-123",
        enabled: true,
        options: {
          timeout: 5000,
        },
      };

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(pluginDir, "plugin.ts"),
          config: pluginConfig,
        },
      ];

      await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      // Verify config was written
      const receivedConfig = JSON.parse(await fs.readFile(configFile, "utf-8"));
      expect(receivedConfig).toEqual(pluginConfig);
    });

    test("passes empty config object when config is undefined", async () => {
      const pluginDir = path.join(tempDir, "empty-config-test");
      await fs.mkdir(pluginDir, { recursive: true });

      const configFile = path.join(tempDir, "empty-config.json");
      const plugin: NaxPlugin = {
        name: "empty-config-receiver",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                prompt: input.prompt,
                originalTokens: 0,
                optimizedTokens: 0,
                savings: 0,
                appliedRules: [],
              };
            },
          },
        },
      };

      const setupFn = `
  async setup(config) {
    const fs = await import("node:fs/promises");
    await fs.writeFile("${configFile}", JSON.stringify(config), "utf-8");
  },`;

      await writePluginFile(path.join(pluginDir, "plugin.ts"), plugin, setupFn);

      const configPlugins: PluginConfigEntry[] = [
        {
          module: path.join(pluginDir, "plugin.ts"),
          // config is undefined
        },
      ];

      await loadPlugins(
        path.join(tempDir, "nonexistent-global"),
        path.join(tempDir, "nonexistent-project"),
        configPlugins,
        tempDir,
      );

      // Verify empty config was passed
      const receivedConfig = JSON.parse(await fs.readFile(configFile, "utf-8"));
      expect(receivedConfig).toEqual({});
    });
  });

  describe("explicit plugin failures", () => {
    test("fails fast when an explicitly configured plugin is invalid", async () => {
      const pluginPath = path.join(tempDir, "invalid-plugin.ts");
      await fs.writeFile(pluginPath, "export default { name: 'invalid' };", "utf-8");

      await expect(
        loadPlugins(
          path.join(tempDir, "nonexistent-global"),
          path.join(tempDir, "nonexistent-project"),
          [{ module: pluginPath }],
          tempDir,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });
    });

    test("fails fast when an explicitly configured plugin setup throws", async () => {
      const pluginPath = path.join(tempDir, "broken-setup-plugin.ts");
      await fs.writeFile(
        pluginPath,
        `export default {
          name: "broken-setup",
          version: "1.0.0",
          provides: [],
          extensions: {},
          async setup() { throw new Error("setup exploded"); }
        };`,
        "utf-8",
      );

      await expect(
        loadPlugins(
          path.join(tempDir, "nonexistent-global"),
          path.join(tempDir, "nonexistent-project"),
          [{ module: pluginPath }],
          tempDir,
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });
    });
  });

  test("auto-discovered invalid plugins warn and skip", async () => {
    const projectPlugins = path.join(tempDir, "project-plugins");
    await fs.mkdir(projectPlugins, { recursive: true });
    await fs.writeFile(path.join(projectPlugins, "invalid.ts"), "export default { name: 'invalid' };", "utf-8");
    const errors: string[] = [];
    _setPluginErrorSink((message) => errors.push(String(message)));

    try {
      const registry = await loadPlugins(path.join(tempDir, "nonexistent-global"), projectPlugins, [], tempDir);

      expect(registry.plugins).toHaveLength(0);
      expect(errors).toContainEqual(expect.stringContaining("Plugin validation failed"));
    } finally {
      _resetPluginErrorSink();
    }
  });
});
