/**
 * Tests for src/plugins/types.ts
 *
 * Covers: PluginType union includes 'post-run-action', PluginExtensions has postRunAction field
 */

import { describe, expect, it } from "bun:test";
import type {
  PluginExtensions,
  PluginType,
  IPostRunAction,
  PostRunActionResult,
  PostRunContext,
  NaxPlugin,
} from "../../../src/plugins/types";

// ─────────────────────────────────────────────────────────────────────────────
// PluginType union tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginType union", () => {
  it("should include 'post-run-action' as valid type", () => {
    // TypeScript compile-time check: if PluginType doesn't include 'post-run-action',
    // this assignment will fail at compile time
    const pluginType: PluginType = "post-run-action";
    expect(pluginType).toBe("post-run-action");
  });

  it("should allow plugin to declare post-run-action in provides array", () => {
    const plugin: NaxPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    expect(plugin.provides).toContain("post-run-action");
  });

  it("should support multiple plugin types including post-run-action", () => {
    const plugin: NaxPlugin = {
      name: "multi-plugin",
      version: "1.0.0",
      provides: ["reporter", "post-run-action"],
      extensions: {
        reporter: {
          name: "reporter",
          onRunEnd: async () => {},
        },
        postRunAction: {
          name: "action",
          description: "Action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    expect(plugin.provides).toHaveLength(2);
    expect(plugin.provides).toContain("post-run-action");
    expect(plugin.provides).toContain("reporter");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginExtensions.postRunAction field tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginExtensions.postRunAction field", () => {
  it("should allow postRunAction to be optional", () => {
    const extensions: PluginExtensions = {
      // No postRunAction field
    };

    expect(extensions.postRunAction).toBeUndefined();
  });

  it("should allow postRunAction to be provided", () => {
    const action: IPostRunAction = {
      name: "test-action",
      description: "A test action",
      shouldRun: async () => true,
      execute: async () => ({ success: true, message: "Done" }),
    };

    const extensions: PluginExtensions = {
      postRunAction: action,
    };

    expect(extensions.postRunAction).toBe(action);
    expect(extensions.postRunAction?.name).toBe("test-action");
  });

  it("should allow postRunAction with other extensions", () => {
    const extensions: PluginExtensions = {
      postRunAction: {
        name: "action",
        description: "Action",
        shouldRun: async () => true,
        execute: async () => ({ success: true, message: "OK" }),
      },
      reporter: {
        name: "reporter",
        onRunEnd: async () => {},
      },
    };

    expect(extensions.postRunAction).toBeDefined();
    expect(extensions.reporter).toBeDefined();
  });

  it("should type check postRunAction result correctly", () => {
    const extensions: PluginExtensions = {
      postRunAction: {
        name: "test",
        description: "Test",
        shouldRun: async (context: PostRunContext) => {
          // Verify context parameter type checking works
          expect(context.runId).toBeDefined();
          return true;
        },
        execute: async (context: PostRunContext): Promise<PostRunActionResult> => {
          void context;
          return {
            success: true,
            message: "Completed",
            url: "https://example.com",
            skipped: false,
          };
        },
      },
    };

    expect(extensions.postRunAction?.name).toBe("test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type export tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Type exports from types.ts", () => {
  it("should export IPostRunAction type", () => {
    const action: IPostRunAction = {
      name: "test",
      description: "Test",
      shouldRun: async () => true,
      execute: async () => ({ success: true, message: "OK" }),
    };
    expect(action).toBeDefined();
  });

  it("should export PostRunContext type", () => {
    const context: PostRunContext = {
      runId: "test",
      feature: "test",
      workdir: "/test",
      prdPath: "/test/prd.json",
      branch: "main",
      totalDurationMs: 0,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };
    expect(context).toBeDefined();
  });

  it("should export PostRunActionResult type", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "OK",
    };
    expect(result).toBeDefined();
  });
});
