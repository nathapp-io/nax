import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertCaughtInstanceOf,
  assertDefined,
  makeAgentAdapter,
  makeContextBundle,
  makeNaxConfig,
} from "@test/helpers";
import type { AgentResult, AgentRunOptions, AgentRunOutcome, AgentRunRequest, HopKind } from "@/agents";
import { _acpAdapterDeps } from "@/agents/acp/adapter";
import type { ResolvedRates } from "@/agents/cost";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { AgentRegistry } from "@/agents/registry";
import type { CompleteOptions, SessionHandle, TurnResult } from "@/agents/types";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { ResolvedPermissions } from "@/config/permissions";
import { resolvePermissions } from "@/config/permissions";
import { NaxConfigSchema } from "@/config/schemas";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { ContextBundle } from "@/context/engine";
import { type AgentMiddleware, MiddlewareChain, type MiddlewareContext } from "@/runtime/agent-middleware";
import { makeClient, makeSession } from "./acp/adapter.test";

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

function makeManager(fallback: Record<string, unknown> = {}) {
  return new AgentManager(
    agentManagerConfigSelector.select({
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
    }),
  );
}

const availFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};
const qualityFailure = {
  category: "quality" as const,
  outcome: "fail-quality" as const,
  retriable: false,
  message: "",
};

describe("AgentManager — Phase 1 pass-through", () => {
  test("getDefault() returns 'claude' when unset and prefers agent.default when explicitly set", () => {
    const mgrUnset = new AgentManager({
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, default: undefined },
    } as NaxConfig);
    expect(mgrUnset.getDefault()).toBe("claude");

    const config = NaxConfigSchema.parse({ agent: { default: "codex" } }) as NaxConfig;
    expect(new AgentManager(config).getDefault()).toBe("codex");
  });

  test("isUnavailable() is false by default, true after markUnavailable(), false after reset()", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.isUnavailable("claude")).toBe(false);

    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      message: "401 unauthorized",
      retriable: false,
    });
    expect(manager.isUnavailable("claude")).toBe(true);

    manager.reset();
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  // Was "returns false when hasBundle is false" — nax#1722 removed that gate. DEFAULT_CONFIG
  // leaves fallback disabled, which is the gate that actually declines here.
  test("shouldSwap() returns false when fallback is disabled", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(
      manager.shouldSwap({ category: "availability", outcome: "fail-auth", message: "x", retriable: false }, 0),
    ).toBe(false);
  });

  test("nextCandidate() returns null when no fallback map configured", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.nextCandidate("claude", 0)).toBeNull();
  });

  test("runWithFallback() with stub registry returning undefined returns failure result and empty fallbacks", async () => {
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

  test("runWithFallback() delegates plain run hops through injected runHop", async () => {
    let capturedAgent = "";
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      runHop: async (agentName) => {
        capturedAgent = agentName;
        return {
          prompt: "test",
          result: {
            success: true,
            exitCode: 0,
            output: "done",
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0.001,
          },
        };
      },
    });
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
    expect(capturedAgent).toBe("claude");
  });

  test("AgentAdapter interface has no run() method", () => {
    const hasRun = "run" in ({} as import("@/agents/types").AgentAdapter);
    expect(typeof hasRun).toBe("boolean");
  });
});

describe("AgentManager.shouldSwap (Phase 4)", () => {
  test.each([
    ["availability failure when enabled", makeManager(), availFailure, 0, true],
    ["fallback disabled", makeManager({ enabled: false }), availFailure, 0, false],
    ["hop cap reached", makeManager({ maxHopsPerStory: 1 }), availFailure, 1, false],
    ["quality failure onQualityFailure=false", makeManager({ onQualityFailure: false }), qualityFailure, 0, false],
    ["quality failure onQualityFailure=true", makeManager({ onQualityFailure: true }), qualityFailure, 0, true],
    ["failure is undefined", makeManager(), undefined, 0, false],
  ] as const)("shouldSwap(%s) → %s", (_label, mgr, failure, hops, expected) => {
    expect(mgr.shouldSwap(failure, hops)).toBe(expected);
  });
});

describe("AgentManager.nextCandidate (Phase 4)", () => {
  test("returns the first candidate deeper than hopsSoFar", () => {
    expect(makeManager().nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });

  // nax#1965: `hops` used to be ignored entirely — any candidate not excluded by
  // cooldown state was offered regardless of how far the story had already
  // descended. That let `runWithFallback`'s ladder-depth counter land back on a
  // rung it was already AT (a same-tier dispatch's `dispatchedModel` does not
  // reliably re-key the cooldown that would otherwise exclude it — see
  // ladder-slot.ts `nextLadderCandidate`), which never advances `hopsSoFar` and
  // never reaches `decideSwap`'s cap: an infinite swap loop. `hops` now names
  // the caller's current ladder depth, and only a STRICTLY deeper candidate is
  // offered — codex is this one-rung ladder's only candidate, at depth 1, so an
  // op already reporting depth 1 has no candidate left.
  test("returns null once hopsSoFar is already at the ladder's deepest rung", () => {
    expect(makeManager().nextCandidate("claude", 1)).toBeNull();
  });

  test("returns null for unknown agent", () => {
    expect(makeManager().nextCandidate("gemini", 0)).toBeNull();
  });

  test("filters pruned candidates", async () => {
    // Drive the real pruning path (validateCredentials) instead of reaching into the
    // private `_prunedFallback` set — "codex" reports no usable credentials, so it is
    // pruned from the fallback candidates and nextCandidate() skips it.
    const registry: AgentRegistry = {
      protocol: "acp",
      getAgent: (name) => makeAgentAdapter({ name, hasCredentials: async () => name !== "codex" }),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
    };
    const m = new AgentManager(
      makeNaxConfig({
        agent: {
          fallback: {
            enabled: true,
            map: { claude: ["codex", "gemini"] },
            maxHopsPerStory: 2,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      }),
      registry,
    );
    await m.validateCredentials();
    expect(m.nextCandidate("claude", 0)).toEqual({ agent: "gemini" });
  });

  test("filters unavailable candidates", () => {
    const m = makeManager({ map: { claude: ["codex"] } });
    m.markUnavailable("codex", availFailure);
    expect(m.nextCandidate("claude", 0)).toBeNull();
  });
});

describe("AgentManager — middleware envelope", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  beforeEach(() => {
    _acpAdapterDeps.createClient = mock(() => makeClient(makeSession()));
  });
  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  function makeMiddlewareManager(mw?: AgentMiddleware): AgentManager {
    return new AgentManager(DEFAULT_CONFIG, undefined, {
      middleware: mw ? MiddlewareChain.from([mw]) : MiddlewareChain.empty(),
      runId: "r-test",
    });
  }

  test("run() delegates to runAs(getDefault(), request) and complete() delegates to completeAs()", async () => {
    const manager = makeMiddlewareManager();

    let calledRunAs = false;
    manager.runAs = async (_name, _req) => {
      calledRunAs = true;
      return { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
    };
    // The stubbed hop rejects; the assertion below is about the side effect, not the outcome.
    await manager.run({ runOptions: makeRunOptions({ prompt: "test" }) }).catch(() => {});
    expect(calledRunAs).toBe(true);

    let calledCompleteAs = false;
    manager.completeAs = async (_name, _prompt, _opts) => {
      calledCompleteAs = true;
      return { output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    };
    await manager
      .complete("prompt", {
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
        workdir: "/tmp",
      })
      .catch(() => {});
    expect(calledCompleteAs).toBe(true);
  });

  test("middleware before() is called before the adapter", async () => {
    const calls: string[] = [];
    const mw: AgentMiddleware = {
      name: "spy",
      before: async () => {
        calls.push("before");
      },
    };
    const manager = makeMiddlewareManager(mw);
    await manager.runAs("claude", { runOptions: makeRunOptions({ prompt: "test", workdir: "/tmp" }) }).catch(() => {});
    expect(calls).toContain("before");
  });

  test("runAs() injects resolvedPermissions into request.runOptions", async () => {
    let capturedPerms: ResolvedPermissions | undefined;
    const mw: AgentMiddleware = {
      name: "spy",
      before: async (ctx: MiddlewareContext) => {
        capturedPerms = ctx.resolvedPermissions;
      },
    };
    const manager = makeMiddlewareManager(mw);
    await manager.runAs("claude", { runOptions: makeRunOptions({ prompt: "test", workdir: "/tmp" }) }).catch(() => {});
    expect(capturedPerms).toBeDefined();
    assertDefined(capturedPerms, "capturedPerms");
    expect(typeof capturedPerms.mode).toBe("string");
  });

  test("runAs() re-throws adapter errors (middleware onError no longer invoked — ADR-020 Wave 1)", async () => {
    const manager = makeMiddlewareManager();
    await expect(
      manager.runAs("nonexistent-agent-xyz", { runOptions: makeRunOptions({ prompt: "test" }) }),
    ).rejects.toThrow();
  });

  test("fallback still works after agent swap (agentFallbacks in result)", async () => {
    const config = NaxConfigSchema.parse({
      agent: {
        default: "claude",
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: true,
        },
      },
    }) as NaxConfig;
    const manager = new AgentManager(config, undefined, { runId: "r-fallback-test" });

    let callCount = 0;
    const result = await manager.runAs("claude", {
      runOptions: makeRunOptions({
        prompt: "original-prompt",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 10,
        config: agentManagerConfigSelector.select(config),
      }),
      executeHop: async (_agentName, _bundle, _failure) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            result: {
              success: false,
              exitCode: 1,
              output: "unavailable",
              rateLimited: false,
              durationMs: 10,
              estimatedCostUsd: 0,
              adapterFailure: {
                category: "availability" as const,
                outcome: "fail-auth" as const,
                retriable: false,
                message: "",
              },
            },
            bundle: makeContextBundle(),
            prompt: "original-prompt",
          };
        }
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "fallback-done",
            rateLimited: false,
            durationMs: 20,
            estimatedCostUsd: 0.001,
          },
          bundle: undefined,
          prompt: "swap-handoff-prompt",
        };
      },
    });

    expect(result.output).toBe("fallback-done");
    expect(result.agentFallbacks).toBeDefined();
    expect(result.agentFallbacks?.length).toBeGreaterThan(0);
  });

  // nax#1722: every CallContext built in src/ omits contextBundle, so `request.bundle`
  // is undefined for every runWithFallback call in production and the swap gate used to
  // decline with "no-bundle". A swap does not need a bundle — buildHopCallback skips the
  // rebuild when there is none, exactly as the complete() path has always done.
  test("swaps with no context bundle at all (nax#1722)", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: true,
        },
      },
    });
    const manager = new AgentManager(config, undefined, { runId: "r-fallback-no-bundle" });

    const agentsSeen: string[] = [];
    const result = await manager.runAs("claude", {
      runOptions: makeRunOptions({
        prompt: "original-prompt",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 10,
        config: agentManagerConfigSelector.select(config),
      }),
      // No `bundle` — the production shape for every op on the run() path.
      executeHop: async (agentName) => {
        agentsSeen.push(agentName);
        if (agentsSeen.length === 1) {
          return {
            result: {
              success: false,
              exitCode: 1,
              output: "unavailable",
              rateLimited: false,
              durationMs: 10,
              estimatedCostUsd: 0,
              adapterFailure: {
                category: "availability" as const,
                outcome: "fail-auth" as const,
                retriable: false,
                message: "",
              },
            },
            bundle: undefined,
          };
        }
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "fallback-done",
            rateLimited: false,
            durationMs: 20,
            estimatedCostUsd: 0.001,
          },
          bundle: undefined,
        };
      },
    });

    expect(agentsSeen).toEqual(["claude", "codex"]);
    expect(result.output).toBe("fallback-done");
    expect(result.agentFallbacks?.length).toBe(1);
  });

  test("completeAs() does not call middleware and middleware context has undefined signal", async () => {
    const calls: string[] = [];
    let capturedSignal: AbortSignal | undefined;
    const mw: AgentMiddleware = {
      name: "spy",
      before: async (ctx: MiddlewareContext) => {
        calls.push("before");
        capturedSignal = ctx.signal;
      },
    };
    const manager = makeMiddlewareManager(mw);
    await manager
      .completeAs("claude", "prompt", {
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
        workdir: "/tmp/test",
        timeoutMs: 100,
      })
      .catch(() => {});
    expect(calls).toHaveLength(0);
    expect(capturedSignal).toBeUndefined();
  });
});

// ─── US-002: rates passenger on dispatch events ──────────────────────────────

const PERMS = resolvePermissions(DEFAULT_CONFIG, "complete");

function makeOptions(): CompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    workdir: "/tmp",
    resolvedPermissions: PERMS,
  };
}

describe("buildCompleteEvent — rates passenger (US-002 AC9, AC10)", () => {
  // AC9 (success): when the CompleteResult carries `rates`, the event
  // exposes the same four rate values.
  test("AC9: CompleteResult.rates (4 fields) reaches the DispatchEvent.rates", () => {
    const rates: ResolvedRates = {
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheCreationPer1M: 2.5,
    };
    const options = makeOptions();
    options.sessionName = "nax-ac9";
    const event = buildCompleteEvent({
      sessionName: "nax-ac9",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0,
      startedAt: 1_000,
      rates,
    });

    expect(event.rates).toEqual(rates);
    expect(event.rates?.inputPer1M).toBe(2);
    expect(event.rates?.outputPer1M).toBe(10);
    expect(event.rates?.cacheReadPer1M).toBe(0.2);
    expect(event.rates?.cacheCreationPer1M).toBe(2.5);
  });

  // AC10 (boundary): when the CompleteResult has NO `rates` (e.g. native path
  // that always stamps vs ACP that stamps only when nonzero-usage guard let
  // pricing run), the event OMITS the field entirely. The AC explicitly
  // says "omits... rather than exposing it as undefined" — the "no field"
  // contract is what lets a downstream subscriber distinguish "no report"
  // from "explicitly unknown".
  test("AC10: CompleteResult without rates means the returned event has no rates property", () => {
    const options = makeOptions();
    options.sessionName = "nax-ac10";
    const event = buildCompleteEvent({
      sessionName: "nax-ac10",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      startedAt: 1_000,
      // No `rates` supplied — the builder must NOT set event.rates to
      // undefined, must NOT set it to a zeroed object: it must omit it.
    });

    expect("rates" in event).toBe(false);
  });
});

describe("buildSessionTurnEvent — rates passenger (US-002 AC9, AC10)", () => {
  // AC9 (success, sendTurn path): TurnResult.rates propagates onto the
  // session-turn event's `rates`.
  test("AC9: TurnResult.rates (4 fields) reaches the DispatchEvent.rates", () => {
    const rates: ResolvedRates = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 3,
      cacheCreationPer1M: 3,
    };
    const handle: SessionHandle = {
      id: "nax-ac9-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      rates,
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run", storyId: "US-002" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect(event.rates).toEqual(rates);
    expect(event.rates?.inputPer1M).toBe(3);
    expect(event.rates?.outputPer1M).toBe(15);
  });

  // AC10 (boundary, sendTurn path): when TurnResult has no `rates`, the
  // event omits the field.
  test("AC10: TurnResult without rates means the returned event has no rates property", () => {
    const handle: SessionHandle = {
      id: "nax-ac10-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      // No `rates` — the builder must omit it.
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect("rates" in event).toBe(false);
  });
});

// ─── Phase 5 type surface: executeHop callback + outcome shape ───────────────

function phase5MakeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
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

describe("AgentRunRequest — executeHop callback", () => {
  test("AgentRunRequest accepts executeHop callback", () => {
    const req: AgentRunRequest = {
      runOptions: phase5MakeRunOptions(),
      executeHop: async (_agentName: string, bundle: ContextBundle | undefined, _hopKind: HopKind) => ({
        result: {} as AgentResult,
        bundle,
        prompt: "test",
      }),
    };
    expect(typeof req.executeHop).toBe("function");
  });

  test("AgentRunOutcome has finalBundle and finalPrompt", () => {
    const outcome: AgentRunOutcome = {
      result: {} as AgentResult,
      fallbacks: [],
      finalBundle: undefined,
      finalPrompt: undefined,
      dispatchesCompleted: 1,
    };
    expect(outcome.finalBundle).toBeUndefined();
    expect(outcome.finalPrompt).toBeUndefined();
    expect(outcome.dispatchesCompleted).toBe(1);
  });
});

// ─── ADR-012: cancellable rate-limit backoff wiring ──────────────────────────

describe("AgentManager — rate-limit backoff wiring", () => {
  test("_deps.sleep accepts an AbortSignal and aborts mid-flight", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("aborted")), 10);

    const start = performance.now();
    let error: unknown;
    try {
      await _agentManagerDeps.sleep(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    assertCaughtInstanceOf(error, Error, "cancellable backoff rejection");
    expect(error.message).toBe("aborted");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("_deps.sleep resolves normally when no signal is passed", async () => {
    const start = performance.now();
    await _agentManagerDeps.sleep(30);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});
