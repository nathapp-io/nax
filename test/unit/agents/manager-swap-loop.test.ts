import { afterEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, _agentManagerDeps } from "../../../src/agents/manager";
import { makeNaxConfig } from "../../helpers";

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

function makeConfig(map: Record<string, string[]> = { claude: ["codex"] }) {
  return makeNaxConfig({
    agent: {
      fallback: { enabled: true, map, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
    },
  });
}

function makeRunHop(results: Record<string, boolean>) {
  return async (name: string) => ({
    prompt: `prompt-${name}`,
    result: (results[name] ?? false)
      ? {
          success: true,
          exitCode: 0,
          output: "ok",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
        }
      : {
          success: false,
          exitCode: 1,
          output: "auth failure",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          adapterFailure: availFailure,
        },
  });
}

describe("AgentManager.runWithFallback — real loop (Phase 4)", () => {
  test("returns success on first attempt", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: true }) });
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure and succeeds", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: true }) });
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
    expect(outcome.fallbacks[0].newAgent).toBe("codex");
    expect(outcome.fallbacks[0].costUsd).toBe(0);
  });

  test("returns failure when all candidates exhausted", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: false }) });
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("emits onSwapAttempt event", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: true }) });
    const events: unknown[] = [];
    m.events.on("onSwapAttempt", (e) => events.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(events).toHaveLength(1);
  });

  test("emits onSwapExhausted when no more candidates", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: false }) });
    const exhausted: unknown[] = [];
    m.events.on("onSwapExhausted", (e) => exhausted.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(exhausted).toHaveLength(1);
  });

  test("skips swap when no bundle (bundle required for shouldSwap)", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false }) });
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: undefined,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(0);
  });
});

describe("AgentManager.runWithFallback — executeHop callback", () => {
  test("calls executeHop for primary hop (failure=undefined)", async () => {
    const calls: Array<{ agentName: string; failure: unknown }> = [];
    const m = new AgentManager(makeConfig(), undefined /* no registry — executeHop replaces it */);
    const outcome = await m.runWithFallback({
      runOptions: {} as never,
      bundle: mockBundle,
      executeHop: async (agentName, bundle, failure) => {
        calls.push({ agentName, failure });
        return {
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
          bundle,
          prompt: "test",
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agentName).toBe("claude");
    expect(calls[0].failure).toBeUndefined();
    expect(outcome.result.success).toBe(true);
    expect(outcome.finalPrompt).toBe("test");
  });

  test("calls executeHop for swap hop with failure set", async () => {
    const calls: Array<{ agentName: string; failure: unknown }> = [];
    let hop = 0;
    const m = new AgentManager(makeConfig({ claude: ["codex"] }), undefined);
    const outcome = await m.runWithFallback({
      runOptions: {} as never,
      bundle: mockBundle,
      executeHop: async (agentName, bundle, failure) => {
        calls.push({ agentName, failure });
        hop++;
        const success = hop === 2; // first fails, second succeeds
        return {
          result: {
            success,
            exitCode: success ? 0 : 1,
            output: "",
            rateLimited: false,
            durationMs: 0,
            estimatedCostUsd: 0,
            adapterFailure: success ? undefined : availFailure,
          },
          bundle,
          prompt: `prompt-${agentName}`,
        };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].agentName).toBe("claude");
    expect(calls[0].failure).toBeUndefined();
    expect(calls[1].agentName).toBe("codex");
    expect(calls[1].failure).toEqual(availFailure);
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.finalPrompt).toBe("prompt-codex");
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
    // No fallback map — swap is never attempted, backoff kicks in
    const config = makeNaxConfig({ agent: { fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false } } });
    const m = new AgentManager(config, undefined, {
      runHop: async () => {
        attempts++;
        return {
          prompt: "prompt-mock",
          result:
            attempts < 3
              ? {
                  success: false,
                  exitCode: 1,
                  output: "rate limited",
                  rateLimited: true,
                  durationMs: 1,
                  estimatedCostUsd: 0,
                  adapterFailure: rateLimitFailure,
                }
              : {
                  success: true,
                  exitCode: 0,
                  output: "ok",
                  rateLimited: false,
                  durationMs: 1,
                  estimatedCostUsd: 0,
                },
        };
      },
    });
    const outcome = await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });

    expect(outcome.result.success).toBe(true);
    expect(attempts).toBe(3);
    expect(sleepCalls).toHaveLength(2);
    // Exponential: 2^1 * 1000 = 2000, 2^2 * 1000 = 4000
    expect(sleepCalls[0]).toBe(2000);
    expect(sleepCalls[1]).toBe(4000);
  });
});
