/**
 * CLI 'nax plugins list' command tests
 *
 * Validates that the plugins list command works correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { pluginsListCommand } from "../../src/cli/plugins";
import type { NaxConfig } from "../../src/config/schema";
import type { NaxPlugin } from "../../src/plugins/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Test fixture helpers
async function createTempDir(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-cli-plugin-test-"));
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

	if (plugin.extensions.reporter) {
		extensionsCode += `
    reporter: {
      name: "${plugin.extensions.reporter.name}",
      async onRunStart() {},
      async onStoryComplete() {},
      async onRunEnd() {}
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

/**
 * Capture console.log output
 */
function captureConsoleLog(): { output: string[]; restore: () => void } {
	const output: string[] = [];
	const originalLog = console.log;

	console.log = (...args: unknown[]) => {
		output.push(args.map((arg) => String(arg)).join(" "));
	};

	return {
		output,
		restore: () => {
			console.log = originalLog;
		},
	};
}

describe("pluginsListCommand", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	describe("no plugins installed", () => {
		test("displays 'No plugins installed' message", async () => {
			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				expect(capture.output.join("\n")).toContain("No plugins installed");
				expect(capture.output.join("\n")).toContain("~/.nax/plugins/");
				expect(capture.output.join("\n")).toContain("./nax/plugins/");
				expect(capture.output.join("\n")).toContain("nax/config.json");
			} finally {
				capture.restore();
			}
		});
	});

	describe("plugins from global directory", () => {
		test("displays global plugins when in user home directory", async () => {
			// Create a mock global plugins directory
			const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");

			// Check if we can write to the actual global directory (skip test if we can't)
			let canWriteGlobal = false;
			try {
				await fs.mkdir(globalPluginsDir, { recursive: true });
				canWriteGlobal = true;
			} catch {
				console.log("Skipping global plugin test - cannot write to ~/.nax/plugins");
				return;
			}

			const plugin: NaxPlugin = {
				name: "test-global-optimizer",
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

			await writePluginFile(globalPluginsDir, "test-global-plugin.ts", plugin);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");
				expect(output).toContain("Installed Plugins:");
				expect(output).toContain("test-global-optimizer");
				expect(output).toContain("1.0.0");
				expect(output).toContain("optimizer");
				expect(output).toContain("global");
			} finally {
				capture.restore();
				// Clean up the test plugin file
				if (canWriteGlobal) {
					try {
						await fs.unlink(path.join(globalPluginsDir, "test-global-plugin.ts"));
					} catch {
						// Ignore cleanup errors
					}
				}
			}
		});
	});

	describe("plugins from project directory", () => {
		test("displays project plugins", async () => {
			const projectPluginsDir = path.join(tempDir, "nax", "plugins");
			await fs.mkdir(projectPluginsDir, { recursive: true });

			const plugin: NaxPlugin = {
				name: "project-reviewer",
				version: "2.0.0",
				provides: ["reviewer"],
				extensions: {
					reviewer: {
						name: "test",
						description: "Test reviewer",
						async check() {
							return { passed: true, output: "OK" };
						},
					},
				},
			};

			await writePluginFile(projectPluginsDir, "project-plugin.ts", plugin);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");
				expect(output).toContain("Installed Plugins:");
				expect(output).toContain("project-reviewer");
				expect(output).toContain("2.0.0");
				expect(output).toContain("reviewer");
				expect(output).toContain("project");
			} finally {
				capture.restore();
			}
		});
	});

	describe("plugins from config", () => {
		test("displays config plugin with module path", async () => {
			const customPluginDir = path.join(tempDir, "custom-plugin");
			await fs.mkdir(customPluginDir, { recursive: true });

			const plugin: NaxPlugin = {
				name: "custom-router",
				version: "3.0.0",
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

			await writePluginFile(customPluginDir, "index.ts", plugin);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
				plugins: [
					{
						module: path.join(customPluginDir, "index.ts"),
						config: {},
					},
				],
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");
				expect(output).toContain("Installed Plugins:");
				expect(output).toContain("custom-router");
				expect(output).toContain("3.0.0");
				expect(output).toContain("router");
				expect(output).toContain("config");
				expect(output).toContain(path.join(customPluginDir, "index.ts"));
			} finally {
				capture.restore();
			}
		});

		test("displays multiple config plugins", async () => {
			const plugin1Dir = path.join(tempDir, "plugin1");
			const plugin2Dir = path.join(tempDir, "plugin2");
			await fs.mkdir(plugin1Dir, { recursive: true });
			await fs.mkdir(plugin2Dir, { recursive: true });

			const plugin1: NaxPlugin = {
				name: "optimizer-plugin",
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

			const plugin2: NaxPlugin = {
				name: "reporter-plugin",
				version: "2.0.0",
				provides: ["reporter"],
				extensions: {
					reporter: {
						name: "test",
						async onRunStart() {},
						async onStoryComplete() {},
						async onRunEnd() {},
					},
				},
			};

			await writePluginFile(plugin1Dir, "index.ts", plugin1);
			await writePluginFile(plugin2Dir, "index.ts", plugin2);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
				plugins: [
					{
						module: path.join(plugin1Dir, "index.ts"),
						config: {},
					},
					{
						module: path.join(plugin2Dir, "index.ts"),
						config: {},
					},
				],
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");

				// Check table headers
				expect(output).toContain("Name");
				expect(output).toContain("Version");
				expect(output).toContain("Provides");
				expect(output).toContain("Source");

				// Check plugin data
				expect(output).toContain("optimizer-plugin");
				expect(output).toContain("1.0.0");
				expect(output).toContain("optimizer");

				expect(output).toContain("reporter-plugin");
				expect(output).toContain("2.0.0");
				expect(output).toContain("reporter");
			} finally {
				capture.restore();
			}
		});

		test("displays plugin with multiple extension types", async () => {
			const pluginDir = path.join(tempDir, "multi-plugin");
			await fs.mkdir(pluginDir, { recursive: true });

			const plugin: NaxPlugin = {
				name: "multi-extension",
				version: "1.0.0",
				provides: ["optimizer", "reviewer"],
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
					reviewer: {
						name: "test",
						description: "Test",
						async check() {
							return { passed: true, output: "OK" };
						},
					},
				},
			};

			await writePluginFile(pluginDir, "index.ts", plugin);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
				plugins: [
					{
						module: path.join(pluginDir, "index.ts"),
						config: {},
					},
				],
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");
				expect(output).toContain("multi-extension");
				expect(output).toContain("optimizer, reviewer");
			} finally {
				capture.restore();
			}
		});
	});

	describe("mixed sources", () => {
		test("displays plugins from project and config sources", async () => {
			// Set up project plugin
			const projectPluginsDir = path.join(tempDir, "nax", "plugins");
			await fs.mkdir(projectPluginsDir, { recursive: true });

			const projectPlugin: NaxPlugin = {
				name: "project-plugin",
				version: "2.0.0",
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
			await writePluginFile(projectPluginsDir, "project.ts", projectPlugin);

			// Set up config plugin
			const configPluginDir = path.join(tempDir, "config-plugin");
			await fs.mkdir(configPluginDir, { recursive: true });

			const configPlugin: NaxPlugin = {
				name: "config-plugin",
				version: "3.0.0",
				provides: ["reporter"],
				extensions: {
					reporter: {
						name: "test",
						async onRunStart() {},
						async onStoryComplete() {},
						async onRunEnd() {},
					},
				},
			};
			await writePluginFile(configPluginDir, "index.ts", configPlugin);

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
				plugins: [
					{
						module: path.join(configPluginDir, "index.ts"),
						config: {},
					},
				],
			};

			const capture = captureConsoleLog();

			try {
				await pluginsListCommand(config, tempDir);

				const output = capture.output.join("\n");

				// Both plugins should be displayed
				expect(output).toContain("project-plugin");
				expect(output).toContain("2.0.0");
				expect(output).toContain("project");

				expect(output).toContain("config-plugin");
				expect(output).toContain("3.0.0");
				expect(output).toContain("config");
			} finally {
				capture.restore();
			}
		});
	});

	describe("exit code", () => {
		test("returns without error when plugins found", async () => {
			const pluginDir = path.join(tempDir, "plugin");
			await fs.mkdir(pluginDir, { recursive: true });

			const plugin: NaxPlugin = {
				name: "test-plugin",
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

			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
				plugins: [
					{
						module: path.join(pluginDir, "index.ts"),
						config: {},
					},
				],
			};

			const capture = captureConsoleLog();

			try {
				// Should complete without throwing
				await expect(pluginsListCommand(config, tempDir)).resolves.toBeUndefined();
			} finally {
				capture.restore();
			}
		});

		test("returns without error when no plugins found", async () => {
			const config: NaxConfig = {
				agents: {
					"claude-code": { enabled: true },
				},
				routing: {
					defaultTier: "fast",
					defaultTestStrategy: "unit",
				},
				autoMode: {
					defaultAgent: "claude-code",
				},
				execution: {
					maxIterations: 20,
					timeout: 1800000,
				},
			};

			const capture = captureConsoleLog();

			try {
				// Should complete without throwing
				await expect(pluginsListCommand(config, tempDir)).resolves.toBeUndefined();
			} finally {
				capture.restore();
			}
		});
	});
});
