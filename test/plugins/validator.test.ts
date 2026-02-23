/**
 * Plugin Validator Tests
 *
 * Tests for runtime plugin validation logic.
 */

import { describe, test, expect } from "bun:test";
import { validatePlugin } from "../../src/plugins/validator";
import type { NaxPlugin } from "../../src/plugins/types";

describe("validatePlugin", () => {
	describe("valid plugins", () => {
		test("accepts minimal valid plugin with optimizer", () => {
			const plugin = {
				name: "test-optimizer",
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {
					optimizer: {
						name: "test",
						async optimize(input: any) {
							return {
								prompt: input.prompt,
								originalTokens: 100,
								optimizedTokens: 100,
								savings: 0,
								appliedRules: [],
							};
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("test-optimizer");
		});

		test("accepts plugin with multiple extension types", () => {
			const plugin = {
				name: "multi-extension",
				version: "2.0.0",
				provides: ["optimizer", "router"],
				extensions: {
					optimizer: {
						name: "test",
						async optimize(input: any) {
							return {
								prompt: input.prompt,
								originalTokens: 100,
								optimizedTokens: 100,
								savings: 0,
								appliedRules: [],
							};
						},
					},
					router: {
						name: "test-router",
						route(story: any, context: any) {
							return null;
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
			expect(result?.provides).toEqual(["optimizer", "router"]);
		});

		test("accepts plugin with setup and teardown", () => {
			const plugin = {
				name: "full-plugin",
				version: "1.0.0",
				provides: ["reviewer"],
				async setup(config: Record<string, unknown>) {
					// Setup logic
				},
				async teardown() {
					// Teardown logic
				},
				extensions: {
					reviewer: {
						name: "test-reviewer",
						description: "Test reviewer",
						async check(workdir: string, changedFiles: string[]) {
							return { passed: true, output: "OK" };
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
			expect(result?.setup).toBeDefined();
			expect(result?.teardown).toBeDefined();
		});

		test("accepts plugin with context-provider", () => {
			const plugin = {
				name: "jira-context",
				version: "1.0.0",
				provides: ["context-provider"],
				extensions: {
					contextProvider: {
						name: "jira",
						async getContext(story: any) {
							return {
								content: "# Jira ticket",
								estimatedTokens: 100,
								label: "Jira Context",
							};
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
		});

		test("accepts plugin with reporter", () => {
			const plugin = {
				name: "slack-reporter",
				version: "1.0.0",
				provides: ["reporter"],
				extensions: {
					reporter: {
						name: "slack",
						async onRunStart(event: any) {
							// Send to Slack
						},
						async onStoryComplete(event: any) {
							// Send to Slack
						},
						async onRunEnd(event: any) {
							// Send to Slack
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
		});

		test("accepts plugin with agent adapter", () => {
			const plugin = {
				name: "custom-agent",
				version: "1.0.0",
				provides: ["agent"],
				extensions: {
					agent: {
						name: "myagent",
						displayName: "My Agent",
						binary: "myagent",
						capabilities: {
							supportedTiers: ["fast", "balanced"],
							maxContextTokens: 100_000,
							features: new Set(["tdd", "review"]),
						},
						async isInstalled() {
							return true;
						},
						async run(options: any) {
							return {
								success: true,
								exitCode: 0,
								output: "done",
								rateLimited: false,
								durationMs: 1000,
								estimatedCost: 0.01,
							};
						},
						buildCommand(options: any) {
							return ["myagent"];
						},
						async plan(options: any) {
							return { specContent: "# Spec" };
						},
						async decompose(options: any) {
							return { stories: [] };
						},
					},
				},
			} satisfies NaxPlugin;

			const result = validatePlugin(plugin);
			expect(result).not.toBeNull();
		});
	});

	describe("invalid plugins", () => {
		test("rejects null", () => {
			const result = validatePlugin(null);
			expect(result).toBeNull();
		});

		test("rejects undefined", () => {
			const result = validatePlugin(undefined);
			expect(result).toBeNull();
		});

		test("rejects non-object", () => {
			const result = validatePlugin("not an object");
			expect(result).toBeNull();
		});

		test("rejects plugin without name", () => {
			const plugin = {
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-string name", () => {
			const plugin = {
				name: 123,
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin without version", () => {
			const plugin = {
				name: "test",
				provides: ["optimizer"],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-string version", () => {
			const plugin = {
				name: "test",
				version: 1.0,
				provides: ["optimizer"],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin without provides", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-array provides", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: "optimizer",
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with empty provides", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: [],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid provides type", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["invalid-type"],
				extensions: {},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin without extensions", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-object extensions", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: "not an object",
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with missing required extension", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {
					// optimizer is missing
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid optimizer (missing name)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {
					optimizer: {
						async optimize(input: any) {
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
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid optimizer (missing optimize)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				extensions: {
					optimizer: {
						name: "test",
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid router (missing name)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["router"],
				extensions: {
					router: {
						route(story: any, context: any) {
							return null;
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid router (missing route)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["router"],
				extensions: {
					router: {
						name: "test",
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid reviewer (missing name)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["reviewer"],
				extensions: {
					reviewer: {
						description: "test",
						async check(workdir: string, changedFiles: string[]) {
							return { passed: true, output: "OK" };
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid reviewer (missing description)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["reviewer"],
				extensions: {
					reviewer: {
						name: "test",
						async check(workdir: string, changedFiles: string[]) {
							return { passed: true, output: "OK" };
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid reviewer (missing check)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["reviewer"],
				extensions: {
					reviewer: {
						name: "test",
						description: "test",
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid context-provider (missing name)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["context-provider"],
				extensions: {
					contextProvider: {
						async getContext(story: any) {
							return {
								content: "test",
								estimatedTokens: 100,
								label: "Test",
							};
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid context-provider (missing getContext)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["context-provider"],
				extensions: {
					contextProvider: {
						name: "test",
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid reporter (missing name)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["reporter"],
				extensions: {
					reporter: {},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with invalid agent (missing required fields)", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["agent"],
				extensions: {
					agent: {
						name: "test",
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-function setup", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				setup: "not a function",
				extensions: {
					optimizer: {
						name: "test",
						async optimize(input: any) {
							return {
								prompt: input.prompt,
								originalTokens: 100,
								optimizedTokens: 100,
								savings: 0,
								appliedRules: [],
							};
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});

		test("rejects plugin with non-function teardown", () => {
			const plugin = {
				name: "test",
				version: "1.0.0",
				provides: ["optimizer"],
				teardown: "not a function",
				extensions: {
					optimizer: {
						name: "test",
						async optimize(input: any) {
							return {
								prompt: input.prompt,
								originalTokens: 100,
								optimizedTokens: 100,
								savings: 0,
								appliedRules: [],
							};
						},
					},
				},
			};
			const result = validatePlugin(plugin);
			expect(result).toBeNull();
		});
	});
});
