import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config";
import { NaxConfigSchema } from "../../../src/config/schemas";

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
const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

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

  test("shouldSwap() returns false when no bundle (Phase 4: bundle required)", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(
      manager.shouldSwap(
        { category: "availability", outcome: "fail-auth", message: "x", retriable: false },
        0,
        undefined,
      ),
    ).toBe(false);
  });

  test("nextCandidate() returns null when no fallback map configured", () => {
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

describe("AgentManager.shouldSwap (Phase 4)", () => {
  test("returns true for availability failure when enabled", () => {
    expect(makeManager().shouldSwap(availFailure, 0, mockBundle)).toBe(true);
  });

  test("returns false when fallback disabled", () => {
    expect(makeManager({ enabled: false }).shouldSwap(availFailure, 0, mockBundle)).toBe(false);
  });

  test("returns false when hop cap reached", () => {
    expect(makeManager({ maxHopsPerStory: 1 }).shouldSwap(availFailure, 1, mockBundle)).toBe(false);
  });

  test("returns false when no bundle", () => {
    expect(makeManager().shouldSwap(availFailure, 0, undefined)).toBe(false);
  });

  test("returns false for quality failure when onQualityFailure=false", () => {
    expect(makeManager({ onQualityFailure: false }).shouldSwap(qualityFailure, 0, mockBundle)).toBe(false);
  });

  test("returns true for quality failure when onQualityFailure=true", () => {
    expect(makeManager({ onQualityFailure: true }).shouldSwap(qualityFailure, 0, mockBundle)).toBe(true);
  });

  test("returns false when failure is undefined", () => {
    expect(makeManager().shouldSwap(undefined, 0, mockBundle)).toBe(false);
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
