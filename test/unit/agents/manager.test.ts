import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("AgentManager — Phase 1 pass-through", () => {
  test("getDefault() reads config.autoMode.defaultAgent when agent.default is unset", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
    };
    const manager = new AgentManager(config);
    expect(manager.getDefault()).toBe("claude");
  });

  test("isUnavailable() is false by default", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test("markUnavailable() then isUnavailable() returns true", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      message: "401 unauthorized",
      retriable: false,
    });
    expect(manager.isUnavailable("claude")).toBe(true);
  });

  test("reset() clears unavailable state", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      message: "401",
      retriable: false,
    });
    manager.reset();
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test("shouldSwap() returns false in Phase 1 (logic deferred to Phase 5)", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(
      manager.shouldSwap(
        { category: "availability", outcome: "fail-auth", message: "x", retriable: false },
        0,
        undefined,
      ),
    ).toBe(false);
  });

  test("nextCandidate() returns null in Phase 1", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.nextCandidate("claude", 0)).toBeNull();
  });

  test("runWithFallback() with no registry returns failure result and empty fallbacks", async () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toEqual([]);
  });

  test("runWithFallback() with registry delegates to adapter.run() once", async () => {
    const mockResult = { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 100, estimatedCost: 0.001 };
    const mockAdapter = { run: async () => mockResult };
    const mockRegistry = { getAgent: (_: string) => mockAdapter as never };
    const manager = new AgentManager(DEFAULT_CONFIG, mockRegistry as never);
    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toEqual([]);
  });

  test("getDefault() prefers agent.default when both are set", () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "codex" },
    }) as NaxConfig;
    const manager = new AgentManager(config);
    expect(manager.getDefault()).toBe("codex");
  });
});
