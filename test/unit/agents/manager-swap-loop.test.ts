import { afterEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, _agentManagerDeps } from "../../../src/agents/manager";
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

describe("AgentManager.runWithFallback — rate-limit backoff (no swap candidate)", () => {
  const origSleep = _agentManagerDeps.sleep;

  afterEach(() => {
    _agentManagerDeps.sleep = origSleep;
    mock.restore();
  });

  test("backs off with exponential delay on rate-limit when no swap candidate", async () => {
    const sleepCalls: number[] = [];
    _agentManagerDeps.sleep = mock(async (ms: number) => { sleepCalls.push(ms); });

    let attempts = 0;
    const rateLimitFailure = {
      category: "availability" as const,
      outcome: "fail-rate-limit" as const,
      retriable: true,
      message: "",
    };
    const registry = {
      getAgent: () => ({
        run: mock(async () => {
          attempts++;
          if (attempts < 3) {
            return { success: false, exitCode: 1, output: "", rateLimited: true, durationMs: 0, estimatedCost: 0, adapterFailure: rateLimitFailure };
          }
          return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        }),
      }),
    } as unknown as AgentRegistry;

    // No fallback map — swap is never attempted, backoff kicks in
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false } } } as never;
    const m = new AgentManager(config, registry);
    const outcome = await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });

    expect(outcome.result.success).toBe(true);
    expect(attempts).toBe(3);
    expect(sleepCalls).toHaveLength(2);
    // Exponential: 2^1 * 1000 = 2000, 2^2 * 1000 = 4000
    expect(sleepCalls[0]).toBe(2000);
    expect(sleepCalls[1]).toBe(4000);
  });
});
