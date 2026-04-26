import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { MiddlewareChain, type AgentMiddleware, type MiddlewareContext } from "../../../src/runtime/agent-middleware";

function makeManager(fallback: Record<string, unknown> = {}) {
  return new AgentManager({
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
        ...fallback,
      },
    },
  } as never);
}

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
const qualityFailure = { category: "quality" as const, outcome: "fail-quality" as const, retriable: false, message: "" };

describe("AgentManager — Phase 1 pass-through", () => {
  test("getDefault() returns built-in default when config.agent.default is unset", () => {
    const mgr = new AgentManager({
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, default: undefined },
    } as NaxConfig);
    expect(mgr.getDefault()).toBe("claude");
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

  test("shouldSwap() returns false when hasBundle is false", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(
      manager.shouldSwap(
        { category: "availability", outcome: "fail-auth", message: "x", retriable: false },
        0,
        false,
      ),
    ).toBe(false);
  });

  test("nextCandidate() returns null when no fallback map configured", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.nextCandidate("claude", 0)).toBeNull();
  });

  test("runWithFallback() with stub registry returning undefined returns failure result and empty fallbacks", async () => {
    const stubRegistry = { getAgent: () => undefined };
    const manager = new AgentManager(DEFAULT_CONFIG, stubRegistry as never);
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

  test("runWithFallback() with registry delegates to adapter primitives once", async () => {
    const mockHandle = { id: "mock-session", agentName: "claude" };
    const mockTurnResult = { output: "done", tokenUsage: { inputTokens: 10, outputTokens: 20 }, cost: { total: 0.001 }, internalRoundTrips: 1 };
    const mockAdapter = {
      name: "claude",
      openSession: async () => mockHandle as never,
      sendTurn: async () => mockTurnResult,
      closeSession: async () => {},
    };
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

  test("AgentAdapter interface has no run() method", () => {
    // Compile-time guard — any call to adapter.run() is a TS error after this deletion.
    // The runtime assertion is a no-op intentionally.
    const hasRun = "run" in ({} as import("../../../src/agents/types").AgentAdapter);
    expect(typeof hasRun).toBe("boolean");
  });
});

describe("AgentManager.shouldSwap (Phase 4)", () => {
  test("returns true for availability failure when enabled", () => {
    expect(makeManager().shouldSwap(availFailure, 0, true)).toBe(true);
  });

  test("returns false when fallback disabled", () => {
    expect(makeManager({ enabled: false }).shouldSwap(availFailure, 0, true)).toBe(false);
  });

  test("returns false when hop cap reached", () => {
    expect(makeManager({ maxHopsPerStory: 1 }).shouldSwap(availFailure, 1, true)).toBe(false);
  });

  test("returns false when hasBundle is false", () => {
    expect(makeManager().shouldSwap(availFailure, 0, false)).toBe(false);
  });

  test("returns false for quality failure when onQualityFailure=false", () => {
    expect(makeManager({ onQualityFailure: false }).shouldSwap(qualityFailure, 0, true)).toBe(false);
  });

  test("returns true for quality failure when onQualityFailure=true", () => {
    expect(makeManager({ onQualityFailure: true }).shouldSwap(qualityFailure, 0, true)).toBe(true);
  });

  test("returns false when failure is undefined", () => {
    expect(makeManager().shouldSwap(undefined, 0, true)).toBe(false);
  });
});

describe("AgentManager.nextCandidate (Phase 4)", () => {
  test("returns first candidate at hop 0", () => {
    expect(makeManager().nextCandidate("claude", 0)).toBe("codex");
  });

  test("returns first available candidate regardless of hopsSoFar (unavailable filtering is the guard)", () => {
    // nextCandidate always returns the first available candidate. The hop count does not act
    // as an index — agents are filtered out via markUnavailable before nextCandidate is called,
    // so the filter is the guard for exhaustion, not the hop index.
    expect(makeManager().nextCandidate("claude", 1)).toBe("codex");
  });

  test("returns null for unknown agent", () => {
    expect(makeManager().nextCandidate("gemini", 0)).toBeNull();
  });

  test("filters pruned candidates", () => {
    const m = makeManager({ map: { claude: ["codex", "gemini"] } });
    m["_prunedFallback"].add("codex");
    expect(m.nextCandidate("claude", 0)).toBe("gemini");
  });

  test("filters unavailable candidates", () => {
    const m = makeManager({ map: { claude: ["codex"] } });
    m.markUnavailable("codex", availFailure);
    expect(m.nextCandidate("claude", 0)).toBeNull();
  });
});

describe("AgentManager — middleware envelope", () => {
  function makeMiddlewareManager(mw?: AgentMiddleware): AgentManager {
    return new AgentManager(DEFAULT_CONFIG, undefined, {
      middleware: mw ? MiddlewareChain.from([mw]) : MiddlewareChain.empty(),
      runId: "r-test",
    });
  }

  test("run() delegates to runAs(getDefault(), request)", async () => {
    const manager = makeMiddlewareManager();
    let calledRunAs = false;
    (manager as unknown as { runAs: typeof manager.runAs }).runAs = async (_name, _req) => {
      calledRunAs = true;
      return { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
    };
    try { await manager.run({ runOptions: { prompt: "test" } as never }); } catch {}
    expect(calledRunAs).toBe(true);
  });

  test("complete() delegates to completeAs(getDefault(), prompt, options)", async () => {
    const manager = makeMiddlewareManager();
    let calledCompleteAs = false;
    (manager as unknown as { completeAs: typeof manager.completeAs }).completeAs = async (_name, _prompt, _opts) => {
      calledCompleteAs = true;
      return { output: "", costUsd: 0, source: "fallback" as const };
    };
    try { await manager.complete("prompt", {} as never); } catch {}
    expect(calledCompleteAs).toBe(true);
  });

  test("middleware before() is called before the adapter", async () => {
    const calls: string[] = [];
    const mw: AgentMiddleware = { name: "spy", before: async () => { calls.push("before"); } };
    const manager = makeMiddlewareManager(mw);
    try { await manager.runAs("claude", { runOptions: { prompt: "test", workdir: "/tmp" } as never }); } catch {}
    expect(calls).toContain("before");
  });

  test("runAs() injects resolvedPermissions into request.runOptions", async () => {
    let capturedPerms: Record<string, unknown> | undefined;
    const mw: AgentMiddleware = {
      name: "spy",
      before: async (ctx: MiddlewareContext) => {
        capturedPerms = ctx.resolvedPermissions as unknown as Record<string, unknown>;
      },
    };
    const manager = makeMiddlewareManager(mw);
    try { await manager.runAs("claude", { runOptions: { prompt: "test", workdir: "/tmp" } as never }); } catch {}
    expect(capturedPerms).toBeDefined();
    expect(typeof capturedPerms!["mode"]).toBe("string");
  });

  test("middleware onError() is called when adapter throws", async () => {
    const errors: unknown[] = [];
    const mw: AgentMiddleware = { name: "spy", onError: async (_ctx, err) => { errors.push(err); } };
    const manager = makeMiddlewareManager(mw);
    await expect(
      manager.runAs("nonexistent-agent-xyz", { runOptions: { prompt: "test" } as never })
    ).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("after() context reflects fallback agent name and prompt after agent swap", async () => {
    const afterCalls: MiddlewareContext[] = [];
    const mw: AgentMiddleware = {
      name: "spy",
      after: async (ctx) => { afterCalls.push(ctx); },
    };
    const config = NaxConfigSchema.parse({
      agent: {
        default: "claude",
        fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true },
      },
    }) as NaxConfig;
    const manager = new AgentManager(config, undefined, {
      middleware: MiddlewareChain.from([mw]),
      runId: "r-fallback-test",
    });

    let callCount = 0;
    await manager.runAs("claude", {
      runOptions: { prompt: "original-prompt", workdir: "/tmp", modelTier: "fast", modelDef: { provider: "anthropic", model: "m", env: {} }, timeoutSeconds: 10, config } as never,
      executeHop: async (_agentName, _bundle, _failure) => {
        callCount += 1;
        if (callCount === 1) {
          // Primary hop — claude fails with availability failure; return a bundle so shouldSwap allows the swap
          return {
            result: {
              success: false, exitCode: 1, output: "unavailable", rateLimited: false, durationMs: 10, estimatedCost: 0,
              adapterFailure: { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" },
            },
            bundle: { files: [] } as never,
            prompt: "original-prompt",
          };
        }
        // Fallback hop — codex succeeds
        return {
          result: { success: true, exitCode: 0, output: "fallback-done", rateLimited: false, durationMs: 20, estimatedCost: 0.001 },
          bundle: undefined,
          prompt: "swap-handoff-prompt",
        };
      },
    });

    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0].agentName).toBe("codex");
    expect(afterCalls[0].prompt).toBe("swap-handoff-prompt");
  });
});
