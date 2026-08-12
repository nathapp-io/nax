import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import type { CompleteOptions } from "../../../src/agents/types";
import { PidRegistry } from "../../../src/execution/pid-registry";
import { makeNaxConfig } from "../../helpers";

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

function makeRegistry(
  results: Record<string, { output: string; failure?: typeof availFailure; throws?: unknown }>,
) {
  return {
    getAgent: (name: string) => {
      const r = results[name];
      if (!r) return undefined;
      return {
        complete: mock(async () => {
          if (r.throws !== undefined) throw r.throws;
          return {
            output: r.output,
            tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.01, exactCostUsd: 0.01,
            adapterFailure: r.failure,
          };
        }),
      };
    },
  } as unknown as AgentRegistry;
}

describe("AgentManager PID lifecycle — configureRuntime", () => {
  test("attaches onPidSpawned and onPidExited to adapter.complete when pidRegistry is configured", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = {
      getAgent: () => ({
        complete: mock(async (_prompt: string, opts: CompleteOptions) => {
          capturedOptions = opts;
          return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
        }),
      }),
    } as unknown as AgentRegistry;

    const m = new AgentManager(makeNaxConfig(), registry);
    const pidRegistry = new PidRegistry("/tmp/test-pid-manager");
    const registerSpy = mock((pid: number) => pidRegistry.register(pid));
    const unregisterSpy = mock((pid: number) => pidRegistry.unregister(pid));
    const patchedRegistry = {
      ...pidRegistry,
      register: registerSpy,
      unregister: unregisterSpy,
    } as unknown as PidRegistry;

    m.configureRuntime({ pidRegistry: patchedRegistry });

    await m.completeWithFallback("prompt", { modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} }, workdir: "/tmp/test", resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const } });

    expect(capturedOptions?.onPidSpawned).toBeDefined();
    expect(capturedOptions?.onPidExited).toBeDefined();

    capturedOptions?.onPidSpawned?.(99);
    expect(registerSpy).toHaveBeenCalledWith(99);

    capturedOptions?.onPidExited?.(99);
    expect(unregisterSpy).toHaveBeenCalledWith(99);
  });

  test("does not attach lifecycle when no pidRegistry is configured", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const registry = {
      getAgent: () => ({
        complete: mock(async (_prompt: string, opts: CompleteOptions) => {
          capturedOptions = opts;
          return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
        }),
      }),
    } as unknown as AgentRegistry;

    const m = new AgentManager(makeNaxConfig(), registry);
    await m.completeWithFallback("prompt", { modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} }, workdir: "/tmp/test", resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const } });

    expect(capturedOptions?.onPidSpawned).toBeUndefined();
    expect(capturedOptions?.onPidExited).toBeUndefined();
  });
});

describe("AgentManager.completeWithFallback (#567)", () => {
  test("returns output on success", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: { output: "hello" } }));
    const outcome = await m.completeWithFallback("prompt", { modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} }, workdir: "/tmp/test", resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const } });
    expect(outcome.result.output).toBe("hello");
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure", async () => {
    const registry = makeRegistry({
      claude: { output: "", failure: availFailure },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    const outcome = await m.completeWithFallback("prompt", { modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} }, workdir: "/tmp/test", resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const } });
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
    const m = new AgentManager(
      config,
      makeRegistry({ claude: { output: "", failure: availFailure } }),
    );
    const outcome = await m.completeWithFallback("prompt", { modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} }, workdir: "/tmp/test", resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const } });
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
      resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const },
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
      resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const },
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
      resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const },
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
    const registry = {
      getAgent: () => ({
        complete: mock(async (_prompt: string, opts: CompleteOptions) => {
          capturedOptions = opts;
          return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
        }),
      }),
    } as unknown as AgentRegistry;

    const config = makeNaxConfig({ agent: { acp: { promptRetries: 3 } } });
    const m = new AgentManager(config, registry);

    await m.completeAs("claude", "prompt", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
    });

    expect(capturedOptions?.promptRetries).toBe(3);
  });
});
