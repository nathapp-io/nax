/**
 * End-to-end plugin config integration test
 *
 * Demonstrates US-007 working in a realistic scenario with:
 * - A project with nax/config.json
 * - Relative plugin paths
 * - Plugin-specific config passed to setup()
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugins } from "../../../src/plugins/loader";

async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-integration-test-"));
  return tmpDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

describe("Plugin config integration (US-007)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(projectRoot);
  });

  test("realistic scenario: project with relative plugin paths in config", async () => {
    // Setup project structure:
    // project/
    //   nax/
    //     (no plugins/ directory to avoid auto-discovery)
    //   custom-plugins/
    //     external-plugin.ts
    //     local-plugin.ts

    const naxDir = path.join(projectRoot, "nax");
    const customPluginsDir = path.join(projectRoot, "custom-plugins");

    await fs.mkdir(naxDir, { recursive: true });
    await fs.mkdir(customPluginsDir, { recursive: true });

    // Create a config file to track which plugins were initialized
    const configTracker = path.join(projectRoot, "plugin-init-tracker.json");

    // Create local plugin (in custom-plugins/)
    const localPluginCode = `
export default {
  name: "local-plugin",
  version: "1.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const trackerPath = "${configTracker}";

    let tracker = {};
    try {
      tracker = JSON.parse(await fs.readFile(trackerPath, "utf-8"));
    } catch {}

    tracker["local-plugin"] = config;
    await fs.writeFile(trackerPath, JSON.stringify(tracker, null, 2), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "local",
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
    await fs.writeFile(path.join(customPluginsDir, "local-plugin.ts"), localPluginCode, "utf-8");

    // Create external plugin (in custom-plugins/)
    const externalPluginCode = `
export default {
  name: "external-plugin",
  version: "2.0.0",
  provides: ["optimizer"],
  async setup(config) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const trackerPath = "${configTracker}";

    let tracker = {};
    try {
      tracker = JSON.parse(await fs.readFile(trackerPath, "utf-8"));
    } catch {}

    tracker["external-plugin"] = config;
    await fs.writeFile(trackerPath, JSON.stringify(tracker, null, 2), "utf-8");
  },
  extensions: {
    optimizer: {
      name: "external",
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
    await fs.writeFile(path.join(customPluginsDir, "external-plugin.ts"), externalPluginCode, "utf-8");

    // Simulate config.json plugins array
    const configPlugins = [
      {
        // Relative path to custom plugins directory
        module: "./custom-plugins/external-plugin.ts",
        config: {
          apiKey: "test-key-123",
          timeout: 5000,
        },
      },
      {
        // Another relative path to custom plugins directory
        module: "./custom-plugins/local-plugin.ts",
        config: {
          enabled: true,
          level: "debug",
        },
      },
    ];

    // Load plugins as the runner would
    const globalPluginsDir = path.join(projectRoot, ".nax", "plugins");
    const projectPluginsDir = path.join(projectRoot, "nax", "plugins");

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot);

    // Verify both plugins loaded
    expect(registry.plugins).toHaveLength(2);
    const pluginNames = registry.plugins.map((p) => p.name).sort();
    expect(pluginNames).toEqual(["external-plugin", "local-plugin"]);

    // Verify configs were passed to setup()
    const tracker = JSON.parse(await fs.readFile(configTracker, "utf-8"));
    expect(tracker["external-plugin"]).toEqual({
      apiKey: "test-key-123",
      timeout: 5000,
    });
    expect(tracker["local-plugin"]).toEqual({
      enabled: true,
      level: "debug",
    });
  });
});
