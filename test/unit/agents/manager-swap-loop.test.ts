import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions, HopKind } from "@/agents";
import { _agentManagerDeps, AgentManager } from "@/agents";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG, pickSelector } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { ContextBundle } from "@/context/engine";
import type { RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const availFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};
const mockBundle = {} as ContextBundle;

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    ...overrides,
  };
}

function makeConfig(map: Record<string, string[]> = { claude: ["codex"] }) {
  return makeNaxConfig({
    agent: {
      fallback: { enabled: true, map, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
      idleWatchdog: {
        enabled: true,
        mode: "warn-then-cancel",
        idleTimeoutSeconds: 900,
        activityKinds: ["message_update", "thinking_update", "usage_update"],
        cancelGraceSeconds: 10,
        maxRetryAttempts: 1,
      },
    },
  });
}

function makeRunHop(results: Record<string, boolean>) {
  return async (name: string) => ({
    prompt: `prompt-${name}`,
    result:
      (results[name] ?? false)
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
      runOptions: makeRunOptions({ storyId: "s1" }),
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure and succeeds", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: true }) });
    const outcome = await m.runWithFallback({
      runOptions: makeRunOptions({ storyId: "s1" }),
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
      runOptions: makeRunOptions({ storyId: "s1" }),
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("emits onSwapAttempt event", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: true }) });
    const events: unknown[] = [];
    m.events.on("onSwapAttempt", (e) => events.push(e));
    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });
    expect(events).toHaveLength(1);
  });

  test("emits onSwapExhausted when no more candidates", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: false }) });
    const exhausted: unknown[] = [];
    m.events.on("onSwapExhausted", (e) => exhausted.push(e));
    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });
    expect(exhausted).toHaveLength(1);
  });

  // Was "skips swap when no bundle". nax#1722: the bundle requirement is gone — it
  // declined every production run() dispatch, none of which carries a bundle.
  test("swaps with no bundle (nax#1722)", async () => {
    const m = new AgentManager(makeConfig(), undefined, { runHop: makeRunHop({ claude: false, codex: true }) });
    const outcome = await m.runWithFallback({
      runOptions: makeRunOptions({ storyId: "s1" }),
      bundle: undefined,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);
  });
});

describe("AgentManager.runWithFallback — executeHop callback", () => {
  test("calls executeHop for primary hop (kind='primary')", async () => {
    const calls: Array<{ agentName: string; hopKind: HopKind }> = [];
    const m = new AgentManager(makeConfig(), undefined /* no registry — executeHop replaces it */);
    const outcome = await m.runWithFallback({
      runOptions: makeRunOptions(),
      bundle: mockBundle,
      executeHop: async (agentName, bundle, hopKind) => {
        calls.push({ agentName, hopKind });
        return {
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
          bundle,
          prompt: "test",
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agentName).toBe("claude");
    expect(calls[0].hopKind).toEqual({ kind: "primary" });
    expect(outcome.result.success).toBe(true);
    expect(outcome.finalPrompt).toBe("test");
  });

  test("calls executeHop for swap hop with kind='swap' and failure", async () => {
    const calls: Array<{ agentName: string; hopKind: HopKind }> = [];
    let hop = 0;
    const m = new AgentManager(makeConfig({ claude: ["codex"] }), undefined);
    const outcome = await m.runWithFallback({
      runOptions: makeRunOptions(),
      bundle: mockBundle,
      executeHop: async (agentName, bundle, hopKind) => {
        calls.push({ agentName, hopKind });
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
    expect(calls[0].hopKind).toEqual({ kind: "primary" });
    expect(calls[1].agentName).toBe("codex");
    expect(calls[1].hopKind).toMatchObject({ kind: "swap", failure: availFailure });
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
    _agentManagerDeps.sleep = mock(async (ms: number) => {
      sleepCalls.push(ms);
    });

    let attempts = 0;
    const rateLimitFailure = {
      category: "availability" as const,
      outcome: "fail-rate-limit" as const,
      retriable: true,
      message: "",
    };
    // No fallback map — swap is never attempted, backoff kicks in
    const config = makeNaxConfig({
      agent: {
        fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
      },
    });
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
    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });

    expect(outcome.result.success).toBe(true);
    expect(attempts).toBe(3);
    expect(sleepCalls).toHaveLength(2);
    // Exponential: 2^1 * 1000 = 2000, 2^2 * 1000 = 4000
    expect(sleepCalls[0]).toBe(2000);
    expect(sleepCalls[1]).toBe(4000);
  });
});

describe("AgentManager.runWithFallback — fail-stale retry", () => {
  const staleFailure = {
    category: "availability" as const,
    outcome: "fail-stale" as const,
    retriable: true,
    message: "idle watchdog cancelled the prompt",
  };

  test("retries once immediately on fail-stale with retriable=true, then succeeds", async () => {
    let attempts = 0;
    const m = new AgentManager(makeConfig(), undefined, {
      runHop: async () => {
        attempts++;
        return {
          prompt: `prompt-${attempts}`,
          result:
            attempts === 1
              ? {
                  success: false,
                  exitCode: 1,
                  output: "stale",
                  rateLimited: false,
                  durationMs: 1,
                  estimatedCostUsd: 0,
                  adapterFailure: staleFailure,
                }
              : { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 1, estimatedCostUsd: 0 },
        };
      },
    });

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });

    expect(outcome.result.success).toBe(true);
    expect(attempts).toBe(2);
    // One fallback record logged for the stale retry (same agent → same agent)
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0]?.outcome).toBe("fail-stale");
    expect(outcome.fallbacks[0]?.priorAgent).toBe(outcome.fallbacks[0]?.newAgent);
  });

  test("after one stale retry, a second fail-stale proceeds to fallback swap rather than retrying again", async () => {
    let attempts = 0;
    // Claude always fails-stale; codex succeeds
    const m = new AgentManager(makeConfig(), undefined, {
      runHop: async (agent) => {
        attempts++;
        if (agent === "claude") {
          return {
            prompt: `prompt-${attempts}`,
            result: {
              success: false,
              exitCode: 1,
              output: "stale",
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              adapterFailure: staleFailure,
            },
          };
        }
        return {
          prompt: `prompt-${attempts}`,
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 1, estimatedCostUsd: 0 },
        };
      },
    });

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });

    // Should succeed via codex after claude's stale retry was exhausted
    expect(outcome.result.success).toBe(true);
    // Exactly 2 claude attempts (initial + one retry) then 1 codex attempt
    expect(attempts).toBe(3);
  });

  test("fail-stale with no fallback agent returns terminal failure without backoff sleep", async () => {
    const origSleep = _agentManagerDeps.sleep;
    const sleepCalls: number[] = [];
    _agentManagerDeps.sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    try {
      // No fallback map — only claude
      const noFallbackConfig = makeNaxConfig({
        agent: {
          fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
        },
      });
      const m = new AgentManager(noFallbackConfig, undefined, {
        runHop: async () => ({
          prompt: "prompt",
          result: {
            success: false,
            exitCode: 1,
            output: "stale",
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0,
            adapterFailure: staleFailure,
          },
        }),
      });

      const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "s1" }), bundle: mockBundle });

      expect(outcome.result.success).toBe(false);
      // No backoff sleep for fail-stale (unlike fail-rate-limit)
      expect(sleepCalls).toHaveLength(0);
    } finally {
      _agentManagerDeps.sleep = origSleep;
    }
  });
});

describe("callOp composite — real fallback stack + cross-op stickiness (nax#1964, nax#1966)", () => {
  /**
   * End-to-end across the two fixes on this branch, through the REAL decision stack —
   * not the hand-rolled `managerSwapping` mock `call-sticky-target.test.ts` uses. A real
   * `AgentManager` runs `nextCandidate` / `markUnavailable` / `decideSwap` / cooldown
   * identity for real; only the hop's own dispatch (the adapter call) is replaced, via
   * `_callOpDeps.buildHopCallback` — the same injectable seam
   * `call-run-counter.test.ts` already uses for this purpose.
   *
   * The swap shape is a CROSS-AGENT literal-pin target (`{ agent, model: "<provider/model>" }`,
   * nax#1966's fallback-model-targets.test.ts pattern), not a same-agent model swap: nax#1965
   * is parked, so a same-agent swap is not demonstrable end to end. Cross-agent is.
   */
  const PIN = "openrouter/z-ai/glm-5.3-flash[high]";
  const RATE_LIMIT_FAILURE = {
    category: "availability" as const,
    outcome: "fail-rate-limit" as const,
    retriable: true,
    message: "rate limited",
  };
  const testSel = pickSelector("swap-loop-composite-test", "routing");

  function pinConfig(): NaxConfig {
    return makeNaxConfig({
      agent: {
        protocol: "hybrid",
        default: "claude",
        fallback: { enabled: true, map: { claude: [{ agent: "native", model: PIN }] } },
      },
      models: { claude: { balanced: "claude-sonnet-4-5" }, native: { cheap: "opencode-go/glm-4-5" } },
    });
  }

  function makeOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You process input.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => output,
    };
  }

  const createdRuntimes: NaxRuntime[] = [];
  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  test("a cross-agent literal-pin swap through the real AgentManager sticks for a later op of the same story", async () => {
    const config = pinConfig();
    const agentManager = new AgentManager(config, undefined, { models: config.models });
    const runtime = makeMockRuntime({ agentManager, config });
    createdRuntimes.push(runtime);

    const dispatched: Array<{ agent: string; hopKind: HopKind }> = [];
    const origBuildHopCallback = _callOpDeps.buildHopCallback;
    // Only the hop's own dispatch is stubbed — everything upstream of it (candidate
    // selection, cooldown marking, the swap decision) is the real AgentManager.
    _callOpDeps.buildHopCallback = () => async (agent, bundle, hopKind) => {
      dispatched.push({ agent, hopKind });
      const isDeadPrimary = agent === "claude";
      return {
        result: isDeadPrimary
          ? {
              success: false,
              exitCode: 1,
              output: "rate limited",
              rateLimited: true,
              durationMs: 0,
              estimatedCostUsd: 0,
              adapterFailure: RATE_LIMIT_FAILURE,
            }
          : { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
        bundle,
      };
    };

    try {
      const ctx = makeMockCallContext({ runtime, agentName: "claude", storyId: "swap-loop-us-001" });

      await callOp(ctx, makeOp("op-one"), "work");
      await callOp(ctx, makeOp("op-two"), "work");
    } finally {
      _callOpDeps.buildHopCallback = origBuildHopCallback;
    }

    // op-one: claude (real primary, fails) -> native (the real nextCandidate's literal
    // pin, dispatched with the pinned model). op-two: native directly — the sticky
    // target op-one's swap recorded, not a re-probe of the dead primary.
    expect(dispatched.map((d) => d.agent)).toEqual(["claude", "native", "native"]);
    expect(dispatched[1]?.hopKind).toMatchObject({ kind: "swap", model: PIN, failure: RATE_LIMIT_FAILURE });
    expect(dispatched[2]?.hopKind).toEqual({ kind: "primary" });
  });
});
