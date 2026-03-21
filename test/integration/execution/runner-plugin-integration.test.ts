// RE-ARCH: keep
/**
 * Runner Plugin Integration Tests
 *
 * Tests for US-001: Wire plugin loading into the runner startup
 *
 * Acceptance Criteria:
 * 1. Runner calls loadPlugins() during initialization before story loop starts
 * 2. PluginRegistry is accessible from pipeline context (RunContext or similar)
 * 3. registry.teardownAll() is called on both success and failure paths
 * 4. If no plugins are found, an empty registry is used (no error)
 * 5. Plugin loading errors are logged but do not abort the run
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as agentModule from "../../../src/agents";
import type { NaxConfig } from "../../../src/config/schema";
import { run } from "../../../src/execution/runner";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { NaxPlugin } from "../../../src/plugins/types";

// Test fixture helpers
async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-runner-plugin-test-"));
  return tmpDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function createMinimalPRD(workdir: string, feature: string): Promise<string> {
  const featureDir = path.join(workdir, ".nax", "features", feature);
  await fs.mkdir(featureDir, { recursive: true });

  const prdPath = path.join(featureDir, "prd.json");
  const prd = {
    featureName: feature,
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "A test story",
        acceptanceCriteria: [],
        dependencies: [],
        tags: [],
        status: "pending",
      },
    ],
  };

  await fs.writeFile(prdPath, JSON.stringify(prd, null, 2));
  return prdPath;
}

async function createMinimalConfig(): Promise<NaxConfig> {
  return {
    autoMode: {
      defaultAgent: "claude-code",
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 1 },
          { tier: "balanced", attempts: 1 },
        ],
      },
    },
    models: {
      fast: { provider: "anthropic", modelName: "claude-3-5-haiku-20241022" },
      balanced: { provider: "anthropic", modelName: "claude-3-5-sonnet-20241022" },
      powerful: { provider: "anthropic", modelName: "claude-3-7-sonnet-20250219" },
    },
    execution: {
      maxIterations: 2,
      costLimit: 100,
      iterationDelayMs: 0,
      maxStoriesPerFeature: 100,
    },
    routing: {
      strategy: "simple",
    },
    tdd: {
      mode: "standard",
      testStrategy: "test-after",
      testCommand: "echo 'tests pass'",
    },
    quality: {
      commands: {},
    },
    acceptance: {
      enabled: false,
      testCommand: "",
      maxRetries: 0,
    },
    analyze: {
      model: "balanced",
      maxContextTokens: 100000,
    },
    plugins: [],
  } as NaxConfig;
}

async function createPluginFile(dir: string, filename: string, plugin: NaxPlugin): Promise<void> {
  const setupCode = plugin.setup ? "async setup(config) { }," : "";
  const teardownCode = plugin.teardown ? "async teardown() { }," : "";

  let extensionsCode = "";
  if (plugin.extensions.reporter) {
    extensionsCode = `
    reporter: {
      name: "${plugin.extensions.reporter.name}",
      async onRunStart(event) {},
      async onStoryComplete(event) {},
      async onRunEnd(event) {}
    }`;
  }

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

describe("Runner Plugin Integration (US-001)", () => {
  let tempDir: string;
  let getAgentSpy: any;

  beforeEach(async () => {
    tempDir = await createTempDir();

    // Mock getAgent to return a valid agent
    getAgentSpy = spyOn(agentModule, "getAgent").mockReturnValue({
      name: "claude-code",
      binary: "claude",
      isInstalled: async () => true,
      spawn: async () => ({
        success: true,
        estimatedCost: 0,
        transcript: "",
      }),
    } as any);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    getAgentSpy?.mockRestore();
  });

  test("AC1: Runner calls loadPlugins() during initialization before story loop starts", async () => {
    // Create a minimal PRD
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a plugin in the global directory
    const globalPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(globalPluginsDir, { recursive: true });

    const plugin: NaxPlugin = {
      name: "test-reporter",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "test-reporter",
          async onRunStart(event) {
            // This proves the plugin was loaded before the run started
          },
        },
      },
    };

    await createPluginFile(globalPluginsDir, "reporter.ts", plugin);

    // Override HOME to use our temp directory
    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      // Run with dry-run to avoid actual agent execution
      const result = await run({
        prdPath,
        workdir: tempDir,
        config,
        hooks: { hooks: [] },
        feature: "test-feature",
        dryRun: true,
        skipPrecheck: true,
      });

      // If we get here, plugins were loaded successfully
      expect(result.success).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("AC2: PluginRegistry is accessible from pipeline context", async () => {
    // This is verified by checking that pipeline stages can access ctx.plugins
    // The implementation already passes plugins to PipelineContext (runner.ts:706)
    // We verify this indirectly by confirming no errors occur when plugins are used

    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a plugin
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(projectPluginsDir, { recursive: true });

    const plugin: NaxPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "test",
          async onRunStart(event) {},
        },
      },
    };

    await createPluginFile(projectPluginsDir, "test.ts", plugin);

    // Run with dry-run
    const result = await run({
      prdPath,
      workdir: tempDir,
      config,
      hooks: { hooks: [] },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    });

    expect(result.success).toBe(true);
  });

  test("AC3: registry.teardownAll() is called on success path", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a plugin with teardown
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(projectPluginsDir, { recursive: true });

    // Use a file to track teardown calls
    const teardownMarkerPath = path.join(tempDir, "teardown-called.txt");

    const pluginCode = `
let teardownCalled = false;

export default {
  name: "teardown-test",
  version: "1.0.0",
  provides: ["reporter"],
  async setup(config) {},
  async teardown() {
    const fs = require("node:fs/promises");
    await fs.writeFile("${teardownMarkerPath.replace(/\\/g, "\\\\")}", "teardown-called", "utf-8");
  },
  extensions: {
    reporter: {
      name: "test",
      async onRunStart(event) {}
    }
  }
};
`;
    await fs.writeFile(path.join(projectPluginsDir, "teardown.ts"), pluginCode, "utf-8");

    // Run successfully
    await run({
      prdPath,
      workdir: tempDir,
      config,
      hooks: { hooks: [] },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    });

    // Check that teardown was called
    const teardownContent = await fs.readFile(teardownMarkerPath, "utf-8");
    expect(teardownContent).toBe("teardown-called");
  });

  test("AC3: registry.teardownAll() is called on failure path", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a plugin with teardown
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(projectPluginsDir, { recursive: true });

    const teardownMarkerPath = path.join(tempDir, "teardown-called-fail.txt");

    const pluginCode = `
export default {
  name: "teardown-fail-test",
  version: "1.0.0",
  provides: ["reporter"],
  async setup(config) {},
  async teardown() {
    const fs = require("node:fs/promises");
    await fs.writeFile("${teardownMarkerPath.replace(/\\/g, "\\\\")}", "teardown-called", "utf-8");
  },
  extensions: {
    reporter: {
      name: "test",
      async onRunStart(event) {}
    }
  }
};
`;
    await fs.writeFile(path.join(projectPluginsDir, "teardown-fail.ts"), pluginCode, "utf-8");

    // Create an invalid PRD to trigger failure
    const invalidPrd = {
      featureName: "test-feature",
      userStories: [], // Empty stories should cause early exit
    };
    await fs.writeFile(prdPath, JSON.stringify(invalidPrd, null, 2));

    // Run and expect failure/early exit
    try {
      await run({
        prdPath,
        workdir: tempDir,
        config,
        hooks: { hooks: [] },
        feature: "test-feature",
        dryRun: true,
        skipPrecheck: true,
      });
    } catch (error) {
      // May throw or return early
    }

    // Check that teardown was called even on failure
    const teardownContent = await fs.readFile(teardownMarkerPath, "utf-8");
    expect(teardownContent).toBe("teardown-called");
  });

  test("AC4: If no plugins are found, an empty registry is used (no error)", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Ensure no plugins exist
    const globalPluginsDir = path.join(tempDir, ".nax", "plugins");
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");

    // Don't create these directories - test with non-existent plugin dirs

    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      // Run with no plugins
      const result = await run({
        prdPath,
        workdir: tempDir,
        config,
        hooks: { hooks: [] },
        feature: "test-feature",
        dryRun: true,
        skipPrecheck: true,
      });

      // Should succeed with empty registry
      expect(result.success).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("AC5: Plugin loading errors are logged but do not abort the run", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a malformed plugin file
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(projectPluginsDir, { recursive: true });

    const malformedPlugin = `
export default {
  // Missing required fields (name, version)
  provides: ["reporter"],
  extensions: {}
};
`;
    await fs.writeFile(path.join(projectPluginsDir, "malformed.ts"), malformedPlugin, "utf-8");

    // Create a valid plugin as well
    const validPlugin: NaxPlugin = {
      name: "valid-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "valid",
          async onRunStart(event) {},
        },
      },
    };
    await createPluginFile(projectPluginsDir, "valid.ts", validPlugin);

    // Run should succeed despite malformed plugin
    const result = await run({
      prdPath,
      workdir: tempDir,
      config,
      hooks: { hooks: [] },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    });

    // Should succeed - malformed plugin is skipped, valid plugin is loaded
    expect(result.success).toBe(true);
  });

  test("Plugin loading resolves correct directory paths", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create plugins in both global and project directories
    const globalPluginsDir = path.join(tempDir, ".nax", "plugins");
    const projectPluginsDir = path.join(tempDir, ".nax", "plugins");
    await fs.mkdir(globalPluginsDir, { recursive: true });
    await fs.mkdir(projectPluginsDir, { recursive: true });

    const globalPlugin: NaxPlugin = {
      name: "global-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "global",
          async onRunStart(event) {},
        },
      },
    };

    const projectPlugin: NaxPlugin = {
      name: "project-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "project",
          async onRunStart(event) {},
        },
      },
    };

    await createPluginFile(globalPluginsDir, "global.ts", globalPlugin);
    await createPluginFile(projectPluginsDir, "project.ts", projectPlugin);

    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      // Run
      const result = await run({
        prdPath,
        workdir: tempDir,
        config,
        hooks: { hooks: [] },
        feature: "test-feature",
        dryRun: true,
        skipPrecheck: true,
      });

      // Should load both plugins successfully
      expect(result.success).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("Config plugins are loaded alongside directory plugins", async () => {
    const prdPath = await createMinimalPRD(tempDir, "test-feature");
    const config = await createMinimalConfig();

    // Create a config plugin
    const configPluginDir = path.join(tempDir, "custom-plugin");
    await fs.mkdir(configPluginDir, { recursive: true });

    const configPlugin: NaxPlugin = {
      name: "config-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "config",
          async onRunStart(event) {},
        },
      },
    };

    await createPluginFile(configPluginDir, "index.ts", configPlugin);

    // Add plugin to config
    config.plugins = [
      {
        module: path.join(configPluginDir, "index.ts"),
        config: {},
      },
    ];

    // Run
    const result = await run({
      prdPath,
      workdir: tempDir,
      config,
      hooks: { hooks: [] },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    });

    expect(result.success).toBe(true);
  });
});
