import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

function makeConfig(map: Record<string, string[]> = { claude: ["codex"] }) {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: { enabled: true, map, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
    },
  } as never;
}

function makeRegistry(results: Record<string, boolean>) {
  return {
    getAgent: (name: string) => ({
      run: mock(async () => ({
        success: results[name] ?? false,
        exitCode: results[name] ? 0 : 1,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 5.0,
        adapterFailure: results[name] ? undefined : availFailure,
      })),
    }),
  } as unknown as AgentRegistry;
}

describe("AgentManager.runWithFallback — real loop (Phase 4)", () => {
  test("returns success on first attempt", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: true }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure and succeeds", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: true }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
    expect(outcome.fallbacks[0].newAgent).toBe("codex");
    expect(outcome.fallbacks[0].costUsd).toBe(5.0);
  });

  test("returns failure when all candidates exhausted", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: false }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("emits onSwapAttempt event", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: true }));
    const events: unknown[] = [];
    m.events.on("onSwapAttempt", (e) => events.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(events).toHaveLength(1);
  });

  test("emits onSwapExhausted when no more candidates", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: false }));
    const exhausted: unknown[] = [];
    m.events.on("onSwapExhausted", (e) => exhausted.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(exhausted).toHaveLength(1);
  });

  test("skips swap when no bundle (bundle required for shouldSwap)", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: undefined,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(0);
  });
});
