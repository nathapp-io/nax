import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseSync } from "recast";
import ts from "typescript";

// ============================================================================
// Test Fixtures & Helpers
// ============================================================================

/**
 * Get the project root (4 levels up from .nax/features/plugin-001/)
 */
const ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Read a TypeScript file and parse it into AST
 */
function readTsFile(relPath: string): string {
  const fullPath = join(ROOT, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return readFileSync(fullPath, "utf-8");
}

/**
 * Check if a file contains a substring
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
 * Check if a file contains a regex pattern
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
 * Extract type or interface definitions from TypeScript file
 */
function getInterfaceNames(relPath: string): string[] {
  try {
    const content = readTsFile(relPath);
    const matches = content.match(/(?:interface|type)\s+(\w+)/g) || [];
    return matches.map((m) => m.replace(/(?:interface|type)\s+/, ""));
  } catch {
    return [];
  }
}

/**
 * Check if a union type includes a specific literal
 */
function typeUnionIncludes(relPath: string, typeName: string, literal: string): boolean {
  try {
    const content = readTsFile(relPath);
    const pattern = new RegExp(
      `(?:type|export type)\\s+${typeName}\\s*=\\s*(?:"[^"]*"|'[^']*'|\\w+)(?:\\s*\\|\\s*(?:"[^"]*"|'[^']*'|\\w+))*`,
      "s"
    );
    const match = content.match(pattern);
    if (!match) return false;
    // Check if the literal appears in the union (as quoted string or identifier)
    return match[0].includes(`"${literal}"`) || match[0].includes(`'${literal}'`) || match[0].includes(literal);
  } catch {
    return false;
  }
}

/**
 * Compile TypeScript and check for errors
 */
async function typecheckPasses(): Promise<boolean> {
  try {
    // Run bun typecheck
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
 * Run lint check
 */
async function lintPasses(): Promise<boolean> {
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
// AC-1 to AC-8: User Story 001 - Types & Registration
// ============================================================================

describe("US-001: IPostRunAction types + PluginType registration", () => {
  test("AC-1: IPostRunAction interface defined in src/plugins/extensions.ts with name, description, shouldRun, and execute methods", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    // Check interface declaration
    expect(content).toContain("interface IPostRunAction");

    // Check required properties
    expect(content).toMatch(/name\s*:\s*string/);
    expect(content).toMatch(/description\s*:\s*string/);

    // Check shouldRun method
    expect(content).toMatch(/shouldRun\s*\(\s*context\s*:\s*PostRunContext\s*\)\s*:\s*(?:Promise<)?boolean/);

    // Check execute method
    expect(content).toMatch(
      /execute\s*\(\s*context\s*:\s*PostRunContext\s*\)\s*:\s*Promise<PostRunActionResult>/
    );
  });

  test("AC-2: PostRunContext interface defined with all required fields", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("interface PostRunContext");

    // Verify all required fields
    const requiredFields = [
      "runId",
      "feature",
      "workdir",
      "prdPath",
      "branch",
      "totalDurationMs",
      "totalCost",
      "storySummary",
      "stories",
      "version",
      "pluginConfig",
      "logger",
    ];

    for (const field of requiredFields) {
      expect(content).toMatch(new RegExp(`\\b${field}\\s*:`, "m"), `PostRunContext should have ${field} field`);
    }
  });

  test("AC-3: PostRunActionResult interface defined with success, message, url, skipped, reason fields", () => {
    const content = readTsFile("src/plugins/extensions.ts");

    expect(content).toContain("interface PostRunActionResult");

    // Verify required fields
    expect(content).toMatch(/success\s*:\s*boolean/);
    expect(content).toMatch(/message\s*:\s*string/);

    // Verify optional fields
    expect(content).toMatch(/url\s*\?\s*:/);
    expect(content).toMatch(/skipped\s*\?\s*:/);
    expect(content).toMatch(/reason\s*\?\s*:/);
  });

  test("AC-4: 'post-run-action' added to PluginType union in src/plugins/types.ts", () => {
    expect(typeUnionIncludes("src/plugins/types.ts", "PluginType", "post-run-action")).toBe(true);
  });

  test("AC-5: postRunAction?: IPostRunAction added to PluginExtensions interface", () => {
    const content = readTsFile("src/plugins/types.ts");
    expect(content).toContain("interface PluginExtensions");
    expect(content).toMatch(/postRunAction\s*\?\s*:\s*IPostRunAction/);
  });

  test("AC-6: All three new types exported from src/plugins/types.ts", () => {
    const content = readTsFile("src/plugins/types.ts");

    // Should have export statements or re-exports
    expect(content).toContain("IPostRunAction");
    expect(content).toContain("PostRunContext");
    expect(content).toContain("PostRunActionResult");

    // Should be exported (either direct export or re-export from extensions)
    expect(content).toMatch(/export\s+(?:type|interface|{\s*.*?)(?:IPostRunAction|PostRunContext|PostRunActionResult)/s);
  });

  test("AC-7: All three new types exported from src/plugins/index.ts barrel", () => {
    const content = readTsFile("src/plugins/index.ts");

    expect(content).toContain("IPostRunAction");
    expect(content).toContain("PostRunContext");
    expect(content).toContain("PostRunActionResult");
  });

  test("AC-8: TypeScript strict mode compiles with no errors", async () => {
    const passes = await typecheckPasses();
    expect(passes).toBe(true);
  });
});

// ============================================================================
// AC-9 to AC-18: User Story 002 - Registry + Validator
// ============================================================================

describe("US-002: Registry getPostRunActions() + validator support", () => {
  // AC-9 to AC-12: Runtime checks on PluginRegistry
  test("AC-9: getPostRunActions() method added to PluginRegistry returning IPostRunAction[]", async () => {
    const { PluginRegistry } = await import(join(ROOT, "src/plugins/registry.ts"));

    const mockRegistry = new PluginRegistry([]);
    expect(typeof mockRegistry.getPostRunActions).toBe("function");

    // Call and verify return type
    const result = mockRegistry.getPostRunActions();
    expect(Array.isArray(result)).toBe(true);
  });

  test("AC-10: getPostRunActions() returns empty array when no post-run-action plugins registered", async () => {
    const { PluginRegistry } = await import(join(ROOT, "src/plugins/registry.ts"));

    const mockRegistry = new PluginRegistry([]);
    const actions = mockRegistry.getPostRunActions();

    expect(actions).toEqual([]);
  });

  test("AC-11: getPostRunActions() returns multiple actions in registration order", async () => {
    const { PluginRegistry } = await import(join(ROOT, "src/plugins/registry.ts"));

    const plugin1: any = {
      name: "post-run-1",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action1",
          description: "First action",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    const plugin2: any = {
      name: "post-run-2",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action2",
          description: "Second action",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    const registry = new PluginRegistry([plugin1, plugin2]);
    const actions = registry.getPostRunActions();

    expect(actions).toHaveLength(2);
    expect(actions[0].name).toBe("action1");
    expect(actions[1].name).toBe("action2");
  });

  test("AC-12: getPostRunActions() filters out plugins where extensions.postRunAction is undefined", async () => {
    const { PluginRegistry } = await import(join(ROOT, "src/plugins/registry.ts"));

    const plugin1: any = {
      name: "post-run-1",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action1",
          description: "Action",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    const plugin2: any = {
      name: "other-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "test-reporter",
        },
      },
    };

    const registry = new PluginRegistry([plugin1, plugin2]);
    const actions = registry.getPostRunActions();

    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe("action1");
  });

  // AC-13 to AC-16: Validator support
  test("AC-13: 'post-run-action' added to VALID_PLUGIN_TYPES const in validator.ts", () => {
    const content = readTsFile("src/plugins/validator.ts");

    expect(content).toContain("VALID_PLUGIN_TYPES");
    expect(content).toMatch(/"post-run-action"/);
  });

  test("AC-14: validateExtension() switch handles 'post-run-action' case calling validatePostRunAction()", () => {
    const content = readTsFile("src/plugins/validator.ts");

    expect(content).toContain("validateExtension");
    expect(content).toMatch(/case\s+["']post-run-action["']/);
    expect(content).toMatch(/validatePostRunAction/);
  });

  test("AC-15: validatePostRunAction() rejects if postRunAction missing name, shouldRun, or execute", async () => {
    const { validatePlugin } = await import(join(ROOT, "src/plugins/validator.ts"));

    // Missing name
    const noName = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          description: "No name",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "" }),
        },
      },
    };

    expect(validatePlugin(noName)).toBeNull();

    // Missing shouldRun
    const noShouldRun = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "No shouldRun",
          execute: async () => ({ success: true, message: "" }),
        },
      },
    };

    expect(validatePlugin(noShouldRun)).toBeNull();

    // Missing execute
    const noExecute = {
      name: "test",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "No execute",
          shouldRun: () => true,
        },
      },
    };

    expect(validatePlugin(noExecute)).toBeNull();
  });

  test("AC-16: validatePlugin() returns null for a plugin declaring provides: ['post-run-action'] with missing execute", async () => {
    const { validatePlugin } = await import(join(ROOT, "src/plugins/validator.ts"));

    const incompletePlugin = {
      name: "incomplete-post-run",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "action",
          description: "Incomplete",
          shouldRun: () => true,
          // Missing execute
        },
      },
    };

    const result = validatePlugin(incompletePlugin);
    expect(result).toBeNull();
  });

  test("AC-17: Tests in test/unit/plugins/registry.test.ts cover getPostRunActions() happy path and empty array case", () => {
    const testContent = readTsFile("test/unit/plugins/registry.test.ts");

    expect(testContent).toContain("getPostRunActions");
    // Should test empty array case
    expect(testContent).toMatch(/returns\s+empty\s+array|empty\s+registry/i);
    // Should test happy path with actual plugins
    expect(testContent).toMatch(/getPostRunActions|post.*run.*action/i);
  });

  test("AC-18: bun run typecheck and bun run lint pass", async () => {
    const typecheckOk = await typecheckPasses();
    const lintOk = await lintPasses();

    expect(typecheckOk).toBe(true);
    expect(lintOk).toBe(true);
  });
});

// ============================================================================
// AC-19 to AC-30: User Story 003 - Runner Integration
// ============================================================================

describe("US-003: Runner integration + buildPostRunContext() + execution loop", () => {
  test("AC-19: RunCleanupOptions extended with feature, prdPath, branch, version fields", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("interface RunCleanupOptions");

    // Verify new fields
    expect(content).toMatch(/feature\s*:\s*string/);
    expect(content).toMatch(/prdPath\s*:\s*string/);
    expect(content).toMatch(/branch\s*:\s*string/);
    expect(content).toMatch(/version\s*:\s*string/);
  });

  test("AC-20: buildPostRunContext() constructs PostRunContext from RunCleanupOptions + prd counts", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    expect(content).toContain("buildPostRunContext");

    // Should reference feature, prdPath, branch, version from options
    expect(content).toMatch(/feature|prdPath|branch|version/);

    // Should handle PRD counts (stories)
    expect(content).toMatch(/countStories|prd\.|stories/i);
  });

  test("AC-21: Post-run actions execute sequentially after reporters.onRunEnd() and before teardownAll()", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should have reporters.onRunEnd
    expect(content).toContain("reporters");
    expect(content).toContain("onRunEnd");

    // Should have post-run action execution loop
    expect(content).toMatch(/getPostRunActions|postRunAction|post.*run/i);

    // Should have teardownAll
    expect(content).toContain("teardownAll");

    // Verify ordering in the file (onRunEnd before post-run before teardownAll)
    const onRunEndIdx = content.indexOf("onRunEnd");
    const postRunIdx = content.search(/getPostRunActions|postRunAction/i);
    const teardownIdx = content.indexOf("teardownAll");

    expect(onRunEndIdx).toBeLessThan(postRunIdx);
    expect(postRunIdx).toBeLessThan(teardownIdx);
  });

  test("AC-22: shouldRun() called before execute(); if false, debug log emitted and execute() skipped", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should check shouldRun before execute
    expect(content).toMatch(/shouldRun|if.*shouldRun|await.*shouldRun/i);
    expect(content).toMatch(/await.*execute|execute\(\)/);

    // Should have debug/info logging
    expect(content).toMatch(/logger|\.debug|\.info/i);

    // Verify conditional logic
    expect(content).toMatch(/if\s*\(\s*.*shouldRun.*\)|if.*\(.*shouldRun/);
  });

  test("AC-23: Successful execute() with url logs at info level: '[post-run] {name}: {message}' with url", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should log at info level
    expect(content).toMatch(/\.info\s*\(|logger\.info/);

    // Should include post-run prefix
    expect(content).toMatch(/\[post-run\]/);

    // Should format with name and message
    expect(content).toMatch(/\$\{.*name|name.*\}|result\.name|action\.name/);
    expect(content).toMatch(/\$\{.*message|message.*\}|result\.message/);

    // Should handle url if present
    expect(content).toMatch(/url|result\.url/i);
  });

  test("AC-24: Skipped result logs at info level: '[post-run] {name}: skipped — {reason}'", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should check for skipped flag
    expect(content).toMatch(/skipped|result\.skipped/);

    // Should log at info level for skipped
    expect(content).toMatch(/\.info|logger\.info/);

    // Should include skipped message
    expect(content).toMatch(/skipped|skip/i);

    // Should reference reason
    expect(content).toMatch(/reason|result\.reason/);
  });

  test("AC-25: Failed result (success=false) logs at warn level: '[post-run] {name}: failed — {message}'", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should check success flag
    expect(content).toMatch(/success|result\.success/);

    // Should log at warn level for failures
    expect(content).toMatch(/\.warn|logger\.warn/);

    // Should include failed message
    expect(content).toMatch(/failed|fail/i);
  });

  test("AC-26: Error thrown in shouldRun() or execute() is caught, logs warn, and does NOT block run completion", () => {
    const content = readTsFile("src/execution/lifecycle/run-cleanup.ts");

    // Should have try/catch around post-run actions
    expect(content).toMatch(/try\s*{|catch\s*\(/);

    // Should log warnings on error
    expect(content).toMatch(/\.warn|logger\.warn|catch/);

    // Should NOT re-throw (continue after catch)
    const catchBlock = content.match(/catch\s*\([^)]*\)\s*{[^}]*}/s)?.[0] || "";
    expect(catchBlock).not.toMatch(/throw/);
  });

  test("AC-27: Multiple post-run actions run in registration order", async () => {
    const { PluginRegistry } = await import(join(ROOT, "src/plugins/registry.ts"));

    const plugin1: any = {
      name: "post-run-1",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "first",
          description: "First",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    const plugin2: any = {
      name: "post-run-2",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "second",
          description: "Second",
          shouldRun: () => true,
          execute: async () => ({ success: true, message: "OK" }),
        },
      },
    };

    const registry = new PluginRegistry([plugin1, plugin2]);
    const actions = registry.getPostRunActions();

    // Verify they are in the same order as registered
    expect(actions[0].name).toBe("first");
    expect(actions[1].name).toBe("second");

    // Execute them in order
    const executionOrder: string[] = [];
    for (const action of actions) {
      if (action.shouldRun && (await action.shouldRun({} as any))) {
        const result = await action.execute({} as any);
        if (result.success) {
          executionOrder.push(action.name);
        }
      }
    }

    expect(executionOrder).toEqual(["first", "second"]);
  });

  test("AC-28: runner.ts finally block passes feature, prdPath, branch, version to cleanupRun()", () => {
    const content = readTsFile("src/execution/runner.ts");

    // Check cleanupRun is called
    expect(content).toContain("cleanupRun");

    // Check these parameters are passed
    expect(content).toMatch(/feature|prdPath|branch|version/);

    // Should be in finally block
    expect(content).toMatch(/finally\s*{|finally\s*\(/);
  });

  test("AC-29: runner-completion.ts does not call post-run actions (they are cleanupRun responsibility)", () => {
    const content = readTsFile("src/execution/runner-completion.ts");

    // Should NOT reference getPostRunActions or execute post-run actions
    // It may reference cleanupRun but shouldn't implement post-run logic
    const hasPostRunLogic = content.match(/getPostRunActions|shouldRun|PostRunAction|postRunAction/i);

    if (hasPostRunLogic) {
      // If it mentions post-run, it should only be calling cleanupRun, not executing
      expect(content).not.toMatch(/for\s*\([^)]*actions|for\s*\([^)]*postRun|\.shouldRun\(\)|\.execute\(/);
    }

    // The actual execution should be in run-cleanup.ts
    const cleanupContent = readTsFile("src/execution/lifecycle/run-cleanup.ts");
    expect(cleanupContent).toMatch(/getPostRunActions|shouldRun.*execute/i);
  });

  test("AC-30: bun run typecheck and bun run lint pass", async () => {
    const typecheckOk = await typecheckPasses();
    const lintOk = await lintPasses();

    expect(typecheckOk).toBe(true);
    expect(lintOk).toBe(true);
  });
});