// RE-ARCH: keep
/**
 * Plugin Validator Tests
 *
 * Tests for runtime plugin validation logic.
 */

import { describe, expect, test } from "bun:test";
import type { NaxPlugin } from "@/plugins/types";
import { validatePlugin } from "@/plugins/validator";

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
                estimatedCostUsd: 0.01,
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
    test.each([
      ["null", null],
      ["undefined", undefined],
      ["non-object", "not an object"],
      ["missing name", { version: "1.0.0", provides: ["optimizer"], extensions: {} }],
      ["non-string name", { name: 123, version: "1.0.0", provides: ["optimizer"], extensions: {} }],
      ["missing version", { name: "test", provides: ["optimizer"], extensions: {} }],
      ["non-string version", { name: "test", version: 1.0, provides: ["optimizer"], extensions: {} }],
      ["missing provides", { name: "test", version: "1.0.0", extensions: {} }],
      ["non-array provides", { name: "test", version: "1.0.0", provides: "optimizer", extensions: {} }],
      ["empty provides", { name: "test", version: "1.0.0", provides: [], extensions: {} }],
      ["invalid provides type", { name: "test", version: "1.0.0", provides: ["invalid-type"], extensions: {} }],
      ["missing extensions", { name: "test", version: "1.0.0", provides: ["optimizer"] }],
      ["non-object extensions", { name: "test", version: "1.0.0", provides: ["optimizer"], extensions: "not an object" }],
      ["missing required extension", { name: "test", version: "1.0.0", provides: ["optimizer"], extensions: {} }],
    ])("rejects %s", (_label, plugin) => {
      expect(validatePlugin(plugin)).toBeNull();
    });

    test("rejects invalid optimizer (missing name or missing optimize)", () => {
      expect(validatePlugin({
        name: "test", version: "1.0.0", provides: ["optimizer"],
        extensions: { optimizer: { async optimize(input: any) { return { optimizedPrompt: input.prompt, estimatedTokens: input.estimatedTokens, tokensSaved: 0, appliedStrategies: [] }; } } },
      })).toBeNull();
      expect(validatePlugin({
        name: "test", version: "1.0.0", provides: ["optimizer"],
        extensions: { optimizer: { name: "test" } },
      })).toBeNull();
    });

    test("rejects invalid router (missing name or missing route)", () => {
      expect(validatePlugin({
        name: "test", version: "1.0.0", provides: ["router"],
        extensions: { router: { route(_story: any, _context: any) { return null; } } },
      })).toBeNull();
      expect(validatePlugin({
        name: "test", version: "1.0.0", provides: ["router"],
        extensions: { router: { name: "test" } },
      })).toBeNull();
    });

    test("rejects invalid reviewer (missing name, description, or check)", () => {
      const check = async (_w: string, _f: string[]) => ({ passed: true, output: "OK" });
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["reviewer"], extensions: { reviewer: { description: "test", check } } })).toBeNull();
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["reviewer"], extensions: { reviewer: { name: "test", check } } })).toBeNull();
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["reviewer"], extensions: { reviewer: { name: "test", description: "test" } } })).toBeNull();
    });

    test("rejects invalid context-provider (missing name or getContext) and invalid reporter (missing name)", () => {
      const getContext = async (_s: any) => ({ content: "test", estimatedTokens: 100, label: "Test" });
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["context-provider"], extensions: { contextProvider: { getContext } } })).toBeNull();
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["context-provider"], extensions: { contextProvider: { name: "test" } } })).toBeNull();
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["reporter"], extensions: { reporter: {} } })).toBeNull();
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

    test("rejects plugin with non-function setup or teardown", () => {
      const ext = { optimizer: { name: "test", async optimize(input: any) { return { prompt: input.prompt, originalTokens: 100, optimizedTokens: 100, savings: 0, appliedRules: [] }; } } };
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["optimizer"], setup: "not a function", extensions: ext })).toBeNull();
      expect(validatePlugin({ name: "test", version: "1.0.0", provides: ["optimizer"], teardown: "not a function", extensions: ext })).toBeNull();
    });
  });
});
