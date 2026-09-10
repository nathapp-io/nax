import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { CompleteOptions } from "@/agents/types";
import { NaxConfigSchema } from "@/config/schemas";
import { PidRegistry } from "@/execution/pid-registry";

const availFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};

function makeConfig() {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

function makeRegistry(results: Record<string, { output: string; failure?: typeof availFailure; throws?: unknown }>) {
  return makeAgentRegistry({
    getAgent: (name: string) => {
      const r = results[name];
      if (!r) return undefined;
      return makeAgentAdapter({
        complete: mock(async () => {
          if (r.throws !== undefined) throw r.throws;
          return {
            output: r.output,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0.01,
            exactCostUsd: 0.01,
            adapterFailure: r.failure,
          };
        }),
      });
    },
  });
}

describe("AgentManager PID lifecycle — configureRuntime", () => {
  test("attaches onPidSpawned and onPidExited to adapter.complete when pidRegistry is configured", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          complete: mock(async (_prompt: string, opts: CompleteOptions) => {
            capturedOptions = opts;
            return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
          }),
        }),
    });

    const m = new AgentManager(makeNaxConfig(), registry);
    const pidRegistry = new PidRegistry("/tmp/test-pid-manager");
    const originalRegister = pidRegistry.register.bind(pidRegistry);
    const originalUnregister = pidRegistry.unregister.bind(pidRegistry);
    const registerSpy = mock<PidRegistry["register"]>((pid: number) => originalRegister(pid));
    const unregisterSpy = mock<PidRegistry["unregister"]>((pid: number) => originalUnregister(pid));
    pidRegistry.register = registerSpy;
    pidRegistry.unregister = unregisterSpy;

    m.configureRuntime({ pidRegistry });

    await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });

    expect(capturedOptions?.onPidSpawned).toBeDefined();
    expect(capturedOptions?.onPidExited).toBeDefined();

    capturedOptions?.onPidSpawned?.(99);
    expect(registerSpy).toHaveBeenCalledWith(99);

    capturedOptions?.onPidExited?.(99);
    expect(unregisterSpy).toHaveBeenCalledWith(99);
  });

  test("does not attach lifecycle when no pidRegistry is configured", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          complete: mock(async (_prompt: string, opts: CompleteOptions) => {
            capturedOptions = opts;
            return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
          }),
        }),
    });

    const m = new AgentManager(makeNaxConfig(), registry);
    await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });

    expect(capturedOptions?.onPidSpawned).toBeUndefined();
    expect(capturedOptions?.onPidExited).toBeUndefined();
  });

  test("backfills models so an injected AgentManager resolves a { agent, model } tier-naming rung", () => {
    // runtime/index.ts builds `agentManagerOpts` including `models: config.models` and,
    // when an AgentManager is injected via opts.agentManager, spreads that whole object
    // into configureRuntime(...). Before models is accepted there, it was silently
    // dropped: an injected manager's `_models` stayed undefined forever, so a fallback
    // rung shaped like `{ agent: "native", model: "powerful" }` never folded to
    // `{ agent: "native", tier: "powerful" }` — it dispatched the literal string
    // "powerful" as a model id, with no error and no log.
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "native",
        fallback: { enabled: true, map: { native: [{ agent: "native", model: "powerful" }] } },
      },
    });
    // Constructed with no `models` — mirrors the injected-`opts.agentManager` path,
    // which never passes `models` to the constructor.
    const manager = new AgentManager(config);

    // With no models available yet, "powerful" cannot be recognised as a tier name,
    // so it stays a literal pin.
    expect(manager.nextCandidate("native", 0, "native")).toEqual({ agent: "native", model: "powerful" });

    manager.configureRuntime({ models: { native: { powerful: "opencode-go/deepseek-v4-flash" } } });

    // Once backfilled, "powerful" is recognised as a real tier key and folds to
    // `{ agent, tier }` — proving `_models` actually reached fallback identity
    // resolution, not just that `configureRuntime` accepted the option inertly.
    expect(manager.nextCandidate("native", 0, "native")).toEqual({ agent: "native", tier: "powerful" });
  });
});

describe("AgentManager.completeWithFallback (#567)", () => {
  test("returns output on success", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: { output: "hello" } }));
    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });
    expect(outcome.result.output).toBe("hello");
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure", async () => {
    const registry = makeRegistry({
      claude: { output: "", failure: availFailure },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });
    expect(outcome.result.output).toBe("from codex");
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
  });

  test("returns failure when no swap configured", async () => {
    const config = makeNaxConfig({
      agent: {
        fallback: {
          enabled: false,
          map: {},
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const m = new AgentManager(config, makeRegistry({ claude: { output: "", failure: availFailure } }));
    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-auth");
  });
});

describe("AgentManager.completeWithFallback — hard-exception classification (BUG-20)", () => {
  test("a thrown auth error now swaps to the fallback agent instead of a blanket fail-unknown", async () => {
    const registry = makeRegistry({
      claude: { output: "", throws: new Error(JSON.stringify({ type: "auth" })) },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });
    expect(outcome.result.output).toBe("from codex");
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("a thrown availability-classified error marks the source agent unavailable for the rest of the run", async () => {
    // New side effect of correct classification: a thrown auth/rate-limit exception now
    // reaches shouldSwap's availability branch, which calls markUnavailable before picking
    // the next candidate. Unlike a pre-classified adapterFailure (already covered by the
    // "swaps to codex" test above), this path was previously unreachable for thrown
    // exceptions — they were always tagged "quality" and never called markUnavailable.
    const registry = makeRegistry({
      claude: { output: "", throws: new Error(JSON.stringify({ type: "auth" })) },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    expect(m.isUnavailable("claude")).toBe(false);

    await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });

    expect(m.isUnavailable("claude")).toBe(true);
    m.reset();
    expect(m.isUnavailable("claude")).toBe(false);
  });

  test("an unclassifiable thrown error still terminates as non-retriable quality/fail-unknown", async () => {
    const m = new AgentManager(
      makeConfig(),
      makeRegistry({ claude: { output: "", throws: new Error("totally unexpected explosion") } }),
    );
    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });
    expect(outcome.result.adapterFailure).toEqual({
      category: "quality",
      outcome: "fail-unknown",
      retriable: false,
      message: "totally unexpected explosion",
    });
  });
});

describe("AgentManager.completeAs — promptRetries flows from config, not options", () => {
  test("promptRetries is pre-resolved from this._config.agent.acp.promptRetries", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          complete: mock(async (_prompt: string, opts: CompleteOptions) => {
            capturedOptions = opts;
            return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
          }),
        }),
    });

    const config = makeNaxConfig({ agent: { acp: { promptRetries: 3 } } });
    const m = new AgentManager(config, registry);

    await m.completeAs("claude", "prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
    });

    expect(capturedOptions?.promptRetries).toBe(3);
  });
});

// SEC-3 (Round 2 review): completeAs previously resolved permissions from
// AgentManager._config unconditionally. In a monorepo, a per-package
// `.nax/mono/<pkg>/config.json` `execution.permissionProfile` was honored
// for run-kind ops (manager.ts:630 reads `request.runOptions.config`) but
// silently ignored by completeAs. This regression pins the contract: a
// per-package config threaded via `options.config` takes precedence over
// the root _config.
describe("AgentManager.completeAs — SEC-3 per-package config threading", () => {
  test("options.config.permissionProfile takes precedence over _config (pre-fix: ignored)", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          complete: mock(async (_prompt: string, opts: CompleteOptions) => {
            capturedOptions = opts;
            return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
          }),
        }),
    });

    // Root config: unrestricted (approve-all)
    const rootConfig = makeNaxConfig({ execution: { permissionProfile: "unrestricted" } });
    const m = new AgentManager(rootConfig, registry);

    // Per-package override: safe (approve-reads)
    const packageConfig = makeNaxConfig({ execution: { permissionProfile: "safe" } });

    await m.completeAs("claude", "prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      config: packageConfig,
    });

    expect(capturedOptions?.resolvedPermissions?.mode).toBe("approve-reads");
  });
});

// nax#1965 fix-round-1 CRITICAL 2: completeWithFallback's swap loop still fed
// StoryHopBudget's swap-EVENT tally into nextCandidate's `hops` parameter, which
// runWithFallback (Task 7) made a ladder-DEPTH parameter. A cooling middle rung
// makes one swap event skip more than one ladder position, so the event tally
// lags true depth — reopening the "wrong baseline fed into the depth filter"
// defect class this feature exists to close, on the complete() path instead of
// run().
describe("AgentManager.completeWithFallback — depth vs event count (nax#1965 fix-round-1 CRITICAL 2)", () => {
  test("passes ladder DEPTH, not the swap-event tally, into nextCandidate when a middle rung is cooling", async () => {
    const config = makeNaxConfig({
      agent: {
        fallback: {
          enabled: true,
          map: { claude: ["codex", "gemini", "grok"] },
          maxHopsPerStory: 3,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const registry = makeRegistry({
      claude: { output: "", failure: availFailure },
      gemini: { output: "", failure: availFailure },
      grok: { output: "from grok" },
    });
    const m = new AgentManager(config, registry);
    // codex is already cooling before the walk starts, so the FIRST swap skips
    // straight from claude to gemini: one swap EVENT, but a ladder DEPTH of 2.
    m.markUnavailable("codex", availFailure);

    const seenHops: number[] = [];
    const originalNextCandidate = m.nextCandidate.bind(m);
    m.nextCandidate = (cur, hops, exclude, tier, model) => {
      seenHops.push(hops);
      return originalNextCandidate(cur, hops, exclude, tier, model);
    };

    const outcome = await m.completeWithFallback("prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-reads" as const },
    });

    // First call: still on the primary — depth 0, no swap has happened yet.
    // Second call: right after the first swap landed on gemini (real ladder
    // depth 2, skipping the cooling codex). An event tally would report 1
    // here (only one swap event occurred); depth must report 2, or every
    // downstream depth-based decision (ladder-slot.ts's `nextLadderCandidate`)
    // is evaluated against the wrong baseline. Before the fix this was [0, 1].
    expect(seenHops).toEqual([0, 2]);
    expect(outcome.result.output).toBe("from grok");
  });
});
