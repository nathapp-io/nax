import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ============================================================================
// Fixtures & Helpers
// ============================================================================

/**
 * Get the project root (4 levels up from .nax/features/plugin-001/)
 */
const ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Read a TypeScript file
 */
function readTsFile(relPath: string): string {
  const fullPath = join(ROOT, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return readFileSync(fullPath, "utf-8");
}

/**
 * Check if file exists
 */
function fileExists(relPath: string): boolean {
  return existsSync(join(ROOT, relPath));
}

/**
 * Check if file contains substring
 */
function fileContains(relPath: string, substring: string): boolean {
  try {
    const content = readTsFile(relPath);
    return content.includes(substring);
  } catch {
    return false;
  }
}

/**
 * Check if file matches regex pattern
 */
function fileMatches(relPath: string, pattern: RegExp): boolean {
  try {
    const content = readTsFile(relPath);
    return pattern.test(content);
  } catch {
    return false;
  }
}

/**
 * Extract exported type/interface names from file
 */
function getExportedNames(relPath: string): string[] {
  try {
    const content = readTsFile(relPath);
    const matches = content.match(/export\s+(?:type|interface)\s+(\w+)/g) || [];
    return matches.map((m) => m.replace(/export\s+(?:type|interface)\s+/, ""));
  } catch {
    return [];
  }
}

/**
 * Extract re-exported type names from file
 */
function getReExportedNames(relPath: string): string[] {
  try {
    const content = readTsFile(relPath);
    const matches = content.match(/export\s+type\s+\{([^}]+)\}/g) || [];
    const names: string[] = [];
    matches.forEach((m) => {
      const inner = m.replace(/export\s+type\s+\{/, "").replace(/\}/, "");
      inner.split(",").forEach((name) => {
        names.push(name.trim().split(/\s+/)[0]);
      });
    });
    return names;
  } catch {
    return [];
  }
}

/**
 * Run bun typecheck and return success status
 */
async function runTypecheck(): Promise<boolean> {
  try {
    const result = await Bun.spawn(["bun", "run", "typecheck"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    return result === 0;
  } catch {
    return false;
  }
}

/**
 * Run bun lint and return success status
 */
async function runLint(): Promise<boolean> {
  try {
    const result = await Bun.spawn(["bun", "run", "lint"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    return result === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// AC-1: IPostRunAction interface definition in extensions.ts
// ============================================================================

describe("AC-1: IPostRunAction interface defined in src/plugins/extensions.ts", () => {
  it("should define IPostRunAction interface with required methods", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("export interface IPostRunAction");
    expect(content).toContain("name: string");
    expect(content).toContain("description: string");
    expect(content).toContain("shouldRun(context: PostRunContext): Promise<boolean>");
    expect(content).toContain("execute(context: PostRunContext): Promise<PostRunActionResult>");
  });
});

// ============================================================================
// AC-2: PostRunContext interface definition
// ============================================================================

describe("AC-2: PostRunContext interface defined with all required fields", () => {
  it("should define PostRunContext with all required fields", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("export interface PostRunContext");
    expect(content).toContain("runId: string");
    expect(content).toContain("feature: string");
    expect(content).toContain("workdir: string");
    expect(content).toContain("prdPath: string");
    expect(content).toContain("branch: string");
    expect(content).toContain("totalDurationMs: number");
    expect(content).toContain("totalCost: number");
    expect(content).toContain("storySummary:");
    expect(content).toContain("stories: UserStory[]");
    expect(content).toContain("version: string");
    expect(content).toContain("pluginConfig: Record<string, unknown>");
    expect(content).toContain("logger: PluginLogger");
  });
});

// ============================================================================
// AC-3: PostRunActionResult interface definition
// ============================================================================

describe("AC-3: PostRunActionResult interface defined with required fields", () => {
  it("should define PostRunActionResult with success, message, url, skipped, reason", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("export interface PostRunActionResult");
    expect(content).toContain("success: boolean");
    expect(content).toContain("message: string");
    expect(content).toContain("url?:");
    expect(content).toContain("skipped?:");
    expect(content).toContain("reason?:");
  });
});

// ============================================================================
// AC-4: 'post-run-action' added to PluginType union in types.ts
// ============================================================================

describe("AC-4: 'post-run-action' added to PluginType union in src/plugins/types.ts", () => {
  it("should include 'post-run-action' in PluginType union", () => {
    const content = readTsFile("src/plugins/types.ts");

    expect(content).toContain('export type PluginType');
    expect(content).toMatch(/PluginType\s*=[\s\S]*"post-run-action"/);
  });
});

// ============================================================================
// AC-5: postRunAction field added to PluginExtensions interface
// ============================================================================

describe("AC-5: postRunAction?: IPostRunAction added to PluginExtensions interface", () => {
  it("should have postRunAction field in PluginExtensions", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("export interface PluginExtensions");
    expect(content).toMatch(/postRunAction\s*\?\s*:\s*IPostRunAction/);
  });
});

// ============================================================================
// AC-6: All three new types exported from src/plugins/types.ts
// ============================================================================

describe("AC-6: All three new types exported from src/plugins/types.ts", () => {
  it("should export IPostRunAction, PostRunContext, PostRunActionResult", () => {
    const content = readTsFile("src/plugins/types.ts");

    expect(content).toContain("export type { IPostRunAction");
    expect(content).toContain("PostRunContext");
    expect(content).toContain("PostRunActionResult");
  });
});

// ============================================================================
// AC-7: All three new types exported from src/plugins/index.ts barrel
// ============================================================================

describe("AC-7: All three new types exported from src/plugins/index.ts barrel", () => {
  it("should export IPostRunAction, PostRunContext, PostRunActionResult from barrel", () => {
    const content = readTsFile("src/plugins/index.ts");

    expect(content).toContain("IPostRunAction");
    expect(content).toContain("PostRunContext");
    expect(content).toContain("PostRunActionResult");
    expect(content).toContain("export type");
  });
});

// ============================================================================
// AC-8: TypeScript strict mode compiles with no errors
// ============================================================================

describe("AC-8: TypeScript strict mode compiles with no errors", () => {
  it("bun run typecheck should pass", async () => {
    const passed = await runTypecheck();
    expect(passed).toBe(true);
  });
});

// ============================================================================
// AC-9: getPostRunActions() method added to PluginRegistry
// ============================================================================

describe("AC-9: getPostRunActions() method added to PluginRegistry returning IPostRunAction[]", () => {
  it("should have getPostRunActions() method in registry", () => {
    const content = readTsFile("src/plugins/registry.ts");

    expect(content).toContain("getPostRunActions()");
    expect(content).toContain("IPostRunAction[]");
  });

  it("should import IPostRunAction type in registry", () => {
    const content = readTsFile("src/plugins/registry.ts");

    expect(content).toMatch(/import.*IPostRunAction/);
  });
});

// ============================================================================
// AC-10: getPostRunActions() returns empty array when no post-run-action plugins
// ============================================================================

describe("AC-10: getPostRunActions() returns empty array when no post-run-action plugins", () => {
  it("returns empty array from registry with no post-run-action plugins", async () => {
    const { PluginRegistry } = await import("../../../src/plugins/registry");

    const mockPlugin = {
      name: "test-reporter",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: { reporter: { name: "r" } },
      init: async () => {},
    };

    const registry = new PluginRegistry([mockPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions).toEqual([]);
  });
});

// ============================================================================
// AC-11: getPostRunActions() returns multiple actions in registration order
// ============================================================================

describe("AC-11: getPostRunActions() returns multiple actions in registration order", () => {
  it("returns multiple post-run actions in registration order", async () => {
    const { PluginRegistry } = await import("../../../src/plugins/registry");

    const action1 = { name: "action1", execute: async () => ({}) };
    const action2 = { name: "action2", execute: async () => ({}) };

    const plugins = [
      {
        name: "plugin1",
        version: "1.0.0",
        provides: ["post-run-action"],
        extensions: { postRunAction: action1 },
        init: async () => {},
      },
      {
        name: "plugin2",
        version: "1.0.0",
        provides: ["post-run-action"],
        extensions: { postRunAction: action2 },
        init: async () => {},
      },
    ];

    const registry = new PluginRegistry(plugins as any);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBe(2);
    expect(actions[0]).toBe(action1);
    expect(actions[1]).toBe(action2);
  });
});

// ============================================================================
// AC-12: getPostRunActions() filters out undefined postRunAction
// ============================================================================

describe("AC-12: getPostRunActions() filters out plugins where postRunAction is undefined", () => {
  it("filters out plugins without postRunAction extension", async () => {
    const { PluginRegistry } = await import("../../../src/plugins/registry");

    const action1 = { name: "action1", execute: async () => ({}) };

    const plugins = [
      {
        name: "plugin1",
        version: "1.0.0",
        provides: ["post-run-action"],
        extensions: { postRunAction: action1 },
        init: async () => {},
      },
      {
        name: "plugin2",
        version: "1.0.0",
        provides: ["post-run-action"],
        extensions: {},
        init: async () => {},
      },
    ];

    const registry = new PluginRegistry(plugins as any);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBe(1);
    expect(actions[0]).toBe(action1);
  });
});

// ============================================================================
// AC-13: 'post-run-action' added to VALID_PLUGIN_TYPES const in validator.ts
// ============================================================================

describe("AC-13: 'post-run-action' added to VALID_PLUGIN_TYPES in validator.ts", () => {
  it("should include 'post-run-action' in VALID_PLUGIN_TYPES", () => {
    const content = readTsFile("src/plugins/validator.ts");

    expect(content).toContain('VALID_PLUGIN_TYPES');
    expect(content).toMatch(/VALID_PLUGIN_TYPES[\s\S]*"post-run-action"/);
  });
});

// ============================================================================
// AC-14: validateExtension() switch handles 'post-run-action' case
// ============================================================================

describe("AC-14: validateExtension() switch handles 'post-run-action' case calling validatePostRunAction()", () => {
  it("should have case for post-run-action in validateExtension switch", () => {
    const content = readTsFile("src/plugins/validator.ts");

    expect(content).toContain('case "post-run-action"');
    expect(content).toContain('validatePostRunAction');
  });
});

// ============================================================================
// AC-15: validatePostRunAction() rejects if name, shouldRun, or execute missing
// ============================================================================

describe("AC-15: validatePostRunAction() validates name, shouldRun, execute are functions", () => {
  it("should reject action without name string", async () => {
    const { validatePlugin } = await import("../../../src/plugins/validator");

    const invalidPlugin = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          // missing name
          description: "test",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "" }),
        },
      },
      init: async () => {},
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("should reject action without shouldRun function", async () => {
    const { validatePlugin } = await import("../../../src/plugins/validator");

    const invalidPlugin = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "test",
          // missing shouldRun
          execute: async () => ({ success: true, message: "" }),
        },
      },
      init: async () => {},
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("should reject action without execute function", async () => {
    const { validatePlugin } = await import("../../../src/plugins/validator");

    const invalidPlugin = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "test",
          shouldRun: async () => true,
          // missing execute
        },
      },
      init: async () => {},
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });
});

// ============================================================================
// AC-16: validatePlugin() returns null for plugin declaring post-run-action with missing execute
// ============================================================================

describe("AC-16: validatePlugin() returns null for plugin with provides=['post-run-action'] and missing execute", () => {
  it("should return null when post-run-action extension is incomplete", async () => {
    const { validatePlugin } = await import("../../../src/plugins/validator");

    const plugin = {
      name: "incomplete",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "test",
          shouldRun: async () => true,
          // execute missing
        },
      },
      init: async () => {},
    };

    const result = validatePlugin(plugin);
    expect(result).toBeNull();
  });
});

// ============================================================================
// AC-17: Tests in test/unit/plugins/registry.test.ts cover getPostRunActions()
// ============================================================================

describe("AC-17: Tests in test/unit/plugins/registry.test.ts cover getPostRunActions()", () => {
  it("should have getPostRunActions tests in registry.test.ts", () => {
    const content = readTsFile("test/unit/plugins/registry.test.ts");

    expect(content).toContain("getPostRunActions");
  });
});

// ============================================================================
// AC-18: bun run typecheck and bun run lint pass
// ============================================================================

describe("AC-18: bun run typecheck and bun run lint pass", () => {
  it("lint should pass", async () => {
    const passed = await runLint();
    expect(passed).toBe(true);
  });
});

// ============================================================================
// AC-19: RunCleanupOptions extended with feature, prdPath, branch, version
// ============================================================================

describe("AC-19: RunCleanupOptions extended with feature, prdPath, branch, version fields", () => {
  it("should have feature, prdPath, branch, version fields in RunCleanupOptions", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("export interface RunCleanupOptions");
    expect(content).toContain("feature: string");
    expect(content).toContain("prdPath: string");
    expect(content).toContain("branch: string");
    expect(content).toContain("version: string");
  });
});

// ============================================================================
// AC-20: buildPostRunContext() constructs PostRunContext from RunCleanupOptions
// ============================================================================

describe("AC-20: buildPostRunContext() constructs PostRunContext from RunCleanupOptions + prd counts", () => {
  it("should have buildPostRunContext function", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("export function buildPostRunContext");
    expect(content).toContain("RunCleanupOptions");
    expect(content).toContain("PostRunContext");
  });

  it("should build context with correct fields", async () => {
    const { buildPostRunContext } = await import(
      "../../../src/execution/lifecycle/run-cleanup"
    );

    const opts = {
      runId: "run-123",
      startTime: Date.now(),
      totalCost: 10,
      storiesCompleted: 2,
      prd: { userStories: [], features: [] },
      pluginRegistry: {} as any,
      workdir: "/work",
      interactionChain: null,
      feature: "my-feature",
      prdPath: "/prd.json",
      branch: "main",
      version: "1.0.0",
    };

    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const ctx = buildPostRunContext(opts, 1000, logger);

    expect(ctx.runId).toBe("run-123");
    expect(ctx.feature).toBe("my-feature");
    expect(ctx.workdir).toBe("/work");
    expect(ctx.prdPath).toBe("/prd.json");
    expect(ctx.branch).toBe("main");
    expect(ctx.totalDurationMs).toBe(1000);
    expect(ctx.version).toBe("1.0.0");
    expect(ctx.totalCost).toBe(10);
  });
});

// ============================================================================
// AC-21: Post-run actions execute sequentially after reporters.onRunEnd()
// ============================================================================

describe("AC-21: Post-run actions execute sequentially after reporters.onRunEnd()", () => {
  it("should execute post-run actions in cleanupRun", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("getPostRunActions()");
    expect(content).toContain("for (const action of actions)");
    // Should come after reporters.onRunEnd()
    const reporterEndIdx = content.indexOf("onRunEnd");
    const actionsIdx = content.indexOf("getPostRunActions");
    expect(actionsIdx).toBeGreaterThan(reporterEndIdx);
  });
});

// ============================================================================
// AC-22: shouldRun() called before execute(); if false, skip and log
// ============================================================================

describe("AC-22: shouldRun() called before execute(); if false, debug log emitted and execute() skipped", () => {
  it("should call shouldRun before execute", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("await action.shouldRun(ctx)");
    expect(content).toContain("await action.execute(ctx)");

    const shouldRunIdx = content.indexOf("shouldRun");
    const executeIdx = content.indexOf("execute");
    expect(shouldRunIdx).toBeLessThan(executeIdx);
  });

  it("should skip execute if shouldRun returns false", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("if (!shouldRun)");
    expect(content).toContain("continue");
  });

  it("should emit debug log when shouldRun returns false", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("debug");
    expect(content).toContain("shouldRun=false");
  });
});

// ============================================================================
// AC-23: Successful execute() with url logs at info level
// ============================================================================

describe("AC-23: Successful execute() with url logs at info level: '[post-run] {name}: {message}'", () => {
  it("should log successful action with url at info level", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("[post-run]");
    expect(content).toContain("logger?.info");
    expect(content).toContain("result.url");
  });
});

// ============================================================================
// AC-24: Skipped result logs at info level: '[post-run] {name}: skipped — {reason}'
// ============================================================================

describe("AC-24: Skipped result logs at info level: '[post-run] {name}: skipped — {reason}'", () => {
  it("should log skipped action at info level", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("result.skipped");
    expect(content).toContain("skipped —");
    expect(content).toContain("logger?.info");
  });
});

// ============================================================================
// AC-25: Failed result (success=false) logs at warn level
// ============================================================================

describe("AC-25: Failed result (success=false) logs at warn level: '[post-run] {name}: failed — {message}'", () => {
  it("should log failed action at warn level", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("!result.success");
    expect(content).toContain("failed —");
    expect(content).toContain("logger?.warn");
  });
});

// ============================================================================
// AC-26: Error thrown in shouldRun() or execute() is caught and logged
// ============================================================================

describe("AC-26: Error thrown in shouldRun() or execute() is caught, logs warn, does NOT block run", () => {
  it("should catch errors in action execution", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("try {");
    expect(content).toContain("} catch (error) {");
    expect(content).toContain("logger?.warn");
  });

  it("should not re-throw error", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // The catch block should not rethrow (verifiable by checking it doesn't have 'throw' after 'catch')
    const catchBlock = content.substring(
      content.indexOf("} catch (error)"),
      content.indexOf("} catch (error)") + 500
    );
    expect(catchBlock).toContain("logger?.warn");
    expect(catchBlock).not.toMatch(/throw\s+error/);
  });
});

// ============================================================================
// AC-27: Multiple post-run actions run in registration order
// ============================================================================

describe("AC-27: Multiple post-run actions run in registration order", () => {
  it("cleanupRun should process actions in registration order", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("for (const action of actions)");
    expect(content).toContain("getPostRunActions()");
  });
});

// ============================================================================
// AC-28: runner.ts finally block passes feature, prdPath, branch, version to cleanupRun()
// ============================================================================

describe("AC-28: runner.ts finally block passes feature, prdPath, branch, version to cleanupRun()", () => {
  it("should pass feature to cleanupRun", () => {
    const content = readTsFile("src/execution/runner.ts");

    expect(content).toContain("cleanupRun");
    expect(content).toContain("feature:");
  });

  it("should pass prdPath to cleanupRun", () => {
    const content = readTsFile("src/execution/runner.ts");

    expect(content).toContain("prdPath:");
  });

  it("should pass branch to cleanupRun", () => {
    const content = readTsFile("src/execution/runner.ts");

    expect(content).toContain("branch:");
  });

  it("should pass version to cleanupRun", () => {
    const content = readTsFile("src/execution/runner.ts");

    expect(content).toContain("version:");
  });
});

// ============================================================================
// AC-29: runner-completion.ts does NOT call post-run actions
// ============================================================================

describe("AC-29: runner-completion.ts does not call post-run actions (responsibility of cleanupRun)", () => {
  it("should not call getPostRunActions in runner-completion", () => {
    const content = readTsFile("src/execution/lifecycle/runner-completion.ts");

    expect(content).not.toContain("getPostRunActions");
  });
});

// ============================================================================
// AC-30: bun run typecheck and bun run lint pass (final verification)
// ============================================================================

describe("AC-30: bun run typecheck and bun run lint pass (final verification)", () => {
  it("typecheck should pass", async () => {
    const passed = await runTypecheck();
    expect(passed).toBe(true);
  });

  it("lint should pass", async () => {
    const passed = await runLint();
    expect(passed).toBe(true);
  });
});