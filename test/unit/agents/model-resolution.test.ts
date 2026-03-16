/**
 * Tests for AA-006: Remove hardcoded claude-sonnet-4-5 model fallbacks
 *
 * Covers:
 * - resolveBalancedModelDef utility: fallback chain (config -> adapter default -> throw)
 * - No hardcoded 'claude-sonnet-4-5' strings remain in src/agents/ or src/acceptance/
 * - decompose() uses config.models.balanced when modelDef is absent
 * - runPlan() uses config.models.balanced when modelDef is absent
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeCodeAdapter, _decomposeDeps } from "../../../src/agents/claude/adapter";
import { resolveBalancedModelDef } from "../../../src/agents/shared/model-resolution";
import type { ModelDef } from "../../../src/config/schema";

// ─────────────────────────────────────────────────────────────────────────────
// resolveBalancedModelDef — fallback chain utility
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBalancedModelDef()", () => {
  test("returns ModelDef from config.models.balanced when present as object", () => {
    const config = {
      models: {
        balanced: { provider: "anthropic", model: "claude-opus-4-5", env: {} },
      },
    };

    const result = resolveBalancedModelDef(config as Parameters<typeof resolveBalancedModelDef>[0]);

    expect(result.model).toBe("claude-opus-4-5");
    expect(result.provider).toBe("anthropic");
  });

  test("resolves string shorthand in config.models.balanced via resolveModel", () => {
    const config = {
      models: {
        balanced: "claude-opus-4-5",
      },
    };

    const result = resolveBalancedModelDef(config as Parameters<typeof resolveBalancedModelDef>[0]);

    expect(result.model).toBe("claude-opus-4-5");
    expect(result.provider).toBe("anthropic");
  });

  test("falls back to adapterDefault when config has no balanced model", () => {
    const adapterDefault: ModelDef = { provider: "anthropic", model: "fallback-model", env: {} };

    const result = resolveBalancedModelDef({ models: {} } as Parameters<typeof resolveBalancedModelDef>[0], adapterDefault);

    expect(result.model).toBe("fallback-model");
  });

  test("falls back to adapterDefault when config.models is absent", () => {
    const adapterDefault: ModelDef = { provider: "anthropic", model: "fallback-model", env: {} };

    const result = resolveBalancedModelDef({} as Parameters<typeof resolveBalancedModelDef>[0], adapterDefault);

    expect(result.model).toBe("fallback-model");
  });

  test("throws when neither config.models.balanced nor adapterDefault is provided", () => {
    expect(() =>
      resolveBalancedModelDef({} as Parameters<typeof resolveBalancedModelDef>[0]),
    ).toThrow(/no balanced model configured/i);
  });

  test("throws when config has no balanced tier and adapterDefault is undefined", () => {
    const config = {
      models: { fast: { provider: "anthropic", model: "haiku" } },
    };

    expect(() =>
      resolveBalancedModelDef(config as Parameters<typeof resolveBalancedModelDef>[0], undefined),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static analysis: no hardcoded 'claude-sonnet-4-5' in src/agents/ or src/acceptance/
// ─────────────────────────────────────────────────────────────────────────────

describe("source files: no hardcoded claude-sonnet-4-5 fallbacks", () => {
  const projectRoot = join(import.meta.dir, "../../../");
  const targetFiles = [
    "src/agents/claude/adapter.ts",
    "src/agents/claude/plan.ts",
    "src/acceptance/fix-generator.ts",
    "src/acceptance/generator.ts",
  ];

  for (const relPath of targetFiles) {
    test(`${relPath} contains no hardcoded 'claude-sonnet-4-5' runtime fallback`, async () => {
      const content = await Bun.file(join(projectRoot, relPath)).text();

      // Detect patterns like: || "claude-sonnet-4-5" or model: "claude-sonnet-4-5"
      // (not JSDoc/comments which use single-line // or * prefixes)
      const lines = content.split("\n");
      const violatingLines = lines.filter((line) => {
        const isComment = /^\s*(\/\/|\*)/.test(line);
        return !isComment && line.includes('"claude-sonnet-4-5"');
      });

      expect(violatingLines).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// decompose() — model resolved from config.models.balanced when modelDef absent
// ─────────────────────────────────────────────────────────────────────────────

describe("ClaudeCodeAdapter.decompose() model resolution", () => {
  let adapter: ClaudeCodeAdapter;
  let capturedCmd: string[];
  let origSpawn: typeof _decomposeDeps.spawn;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    capturedCmd = [];
    origSpawn = _decomposeDeps.spawn;
  });

  afterEach(() => {
    _decomposeDeps.spawn = origSpawn;
  });

  function mockDecomposeProcess(stories: object) {
    const body = new Response(JSON.stringify(stories)).body as ReadableStream<Uint8Array>;
    return { stdout: body, exited: Promise.resolve(0), pid: 99999, kill: () => {} };
  }

  test("uses config.models.balanced model when modelDef is not provided", async () => {
    _decomposeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockDecomposeProcess({
        stories: [
          {
            id: "US-001",
            title: "test",
            description: "desc",
            acceptanceCriteria: [],
            tags: [],
            dependencies: [],
            complexity: "simple",
            contextFiles: [],
            reasoning: "r",
            estimatedLOC: 10,
            risks: [],
          },
        ],
      });
    };

    const config = {
      models: {
        balanced: { provider: "anthropic", model: "custom-balanced-model", env: {} },
      },
    };

    await adapter.decompose({
      specContent: "## Stories\n- US-001: test",
      workdir: "/tmp",
      codebaseContext: "",
      config: config as Parameters<typeof adapter.decompose>[0]["config"],
      // modelDef intentionally omitted
    });

    const modelIndex = capturedCmd.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(capturedCmd[modelIndex + 1]).toBe("custom-balanced-model");
    expect(capturedCmd[modelIndex + 1]).not.toBe("claude-sonnet-4-5");
  });

  test("throws when modelDef is absent and config has no balanced tier", async () => {
    // Spawn should never be reached — error must be thrown before the spawn call
    _decomposeDeps.spawn = (_cmd, _opts) => mockDecomposeProcess({ stories: [] });

    await expect(
      adapter.decompose({
        specContent: "spec",
        workdir: "/tmp",
        codebaseContext: "",
        config: {} as Parameters<typeof adapter.decompose>[0]["config"],
      }),
    ).rejects.toThrow(/no balanced model|not configured|missing/i);
  });

  test("explicit modelDef takes priority over config.models.balanced", async () => {
    const validStory = {
      id: "US-001",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      complexity: "simple",
      contextFiles: [],
      reasoning: "r",
      estimatedLOC: 5,
      risks: [],
    };
    _decomposeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockDecomposeProcess({ stories: [validStory] });
    };

    const config = {
      models: {
        balanced: { provider: "anthropic", model: "config-balanced", env: {} },
      },
    };

    await adapter.decompose({
      specContent: "spec",
      workdir: "/tmp",
      codebaseContext: "",
      modelDef: { provider: "anthropic", model: "explicit-override", env: {} },
      config: config as Parameters<typeof adapter.decompose>[0]["config"],
    });

    const modelIndex = capturedCmd.indexOf("--model");
    expect(capturedCmd[modelIndex + 1]).toBe("explicit-override");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runPlan() / buildPlanCommand — model resolved from config when modelDef absent
// ─────────────────────────────────────────────────────────────────────────────

import { buildPlanCommand } from "../../../src/agents/claude/plan";

describe("buildPlanCommand() model resolution", () => {
  test("includes --model from config.models.balanced when modelDef is absent", () => {
    const config = {
      models: {
        balanced: { provider: "anthropic", model: "config-plan-model", env: {} },
      },
    };

    const cmd = buildPlanCommand("claude", {
      prompt: "plan this",
      workdir: "/tmp",
      interactive: false,
      config: config as Parameters<typeof buildPlanCommand>[1]["config"],
      // modelDef intentionally omitted
    });

    const modelIndex = cmd.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIndex + 1]).toBe("config-plan-model");
  });

  test("explicit modelDef still takes priority over config in buildPlanCommand", () => {
    const config = {
      models: {
        balanced: { provider: "anthropic", model: "config-plan-model", env: {} },
      },
    };

    const cmd = buildPlanCommand("claude", {
      prompt: "plan this",
      workdir: "/tmp",
      interactive: false,
      modelDef: { provider: "anthropic", model: "explicit-plan-model", env: {} },
      config: config as Parameters<typeof buildPlanCommand>[1]["config"],
    });

    const modelIndex = cmd.indexOf("--model");
    expect(cmd[modelIndex + 1]).toBe("explicit-plan-model");
  });
});
