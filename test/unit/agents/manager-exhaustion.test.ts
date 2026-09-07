import { afterEach, describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeContextBundle, makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { _agentManagerDeps, AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";

const mockBundle = makeContextBundle();

const rateLimit: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
  retryAfterSeconds: 45,
};

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    storyId: "s1",
    ...overrides,
  };
}

/** `map: {}` is the cliff: decideSwap accepts, nextCandidate finds nobody. */
function makeFallbackConfig(opts: { enabled: boolean; map?: Record<string, string[]> }) {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: opts.enabled,
        map: opts.map ?? {},
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

/** Every hop fails with the same rate limit. */
const alwaysRateLimited = async (name: string) => ({
  prompt: `prompt-${name}`,
  result: {
    success: false,
    exitCode: 1,
    output: "rate limited",
    rateLimited: true,
    durationMs: 1,
    estimatedCostUsd: 0,
    adapterFailure: rateLimit,
  },
});

const originalSleep = _agentManagerDeps.sleep;
afterEach(() => {
  _agentManagerDeps.sleep = originalSleep;
});

/** Captures the delays handed to the injected sleep; nothing waits in real time. */
function captureSleeps(): number[] {
  const slept: number[] = [];
  _agentManagerDeps.sleep = async (ms: number) => {
    slept.push(ms);
  };
  return slept;
}

describe("exhaustion on the run path", () => {
  test("a rate limit with no candidate backs off on the provider's delay and emits at hops 0", async () => {
    const slept = captureSleeps();
    const manager = new AgentManager(makeFallbackConfig({ enabled: true }), undefined, {
      runHop: alwaysRateLimited,
    });
    const exhausted: Array<{ hops: number }> = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e));

    await manager.runWithFallback({ runOptions: makeRunOptions(), bundle: mockBundle });

    expect(slept).toContain(45_000);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.hops).toBe(0);
  });

  test("a policy decline backs off but does not emit — it is not exhaustion", async () => {
    const slept = captureSleeps();
    const manager = new AgentManager(makeFallbackConfig({ enabled: false }), undefined, {
      runHop: alwaysRateLimited,
    });
    const exhausted: unknown[] = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e));

    await manager.runWithFallback({ runOptions: makeRunOptions(), bundle: mockBundle });

    expect(slept).toContain(45_000);
    expect(exhausted).toEqual([]);
  });
});

describe("exhaustion on the complete path", () => {
  test("a rate limit with no candidate now backs off and emits, where it previously did neither", async () => {
    const slept = captureSleeps();
    // makeAgentRegistry takes a Partial<AgentRegistry>, not a name->adapter map.
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          complete: async () => ({
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            adapterFailure: rateLimit,
          }),
        }),
    });
    const manager = new AgentManager(makeFallbackConfig({ enabled: true }), registry);
    const exhausted: unknown[] = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e));

    // ResolvedCompleteOptions = CompleteOptions & { resolvedPermissions }.
    // Shape copied from test/unit/agents/manager-complete.test.ts:73-77.
    await manager.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
      storyId: "s1",
    });

    expect(slept).toContain(45_000);
    expect(exhausted).toHaveLength(1);
  });
});
