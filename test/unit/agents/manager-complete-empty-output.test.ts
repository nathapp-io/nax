import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "@/agents/manager";
import type { AgentRegistry } from "@/agents/registry";
import { makeNaxConfig } from "@test/helpers";

const baseOptions = {
  modelDef: { provider: "anthropic" as const, model: "claude-sonnet-4-6", env: {} as Record<string, string> },
  workdir: "/tmp/test",
  resolvedPermissions: { mode: "approve-reads" as const },
};

/** Build a NaxConfig slice for watchdog + fallback tuning used by these tests. */
const naxConfigWith = (maxRetryAttempts = 3, enableFallback = true) =>
  makeNaxConfig({
    agent: {
      idleWatchdog: {
        enabled: true,
        idleTimeoutSeconds: 900,
        maxRetryAttempts,
      },
      fallback: {
        enabled: enableFallback,
        map: enableFallback ? { claude: ["codex"] } : {},
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });

function makeStaticRegistry(agentName: string, outputSequence: string[]) {
  let callCount = 0;
  const completeMock = mock(async () => {
    const output = outputSequence[callCount] ?? "";
    callCount++;
    return {
      output,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    };
  });
  return {
    registry: {
      getAgent: (name: string) => {
        if (name !== agentName) return undefined;
        return { complete: completeMock };
      },
    } as unknown as AgentRegistry,
    completeMock,
    getCallCount: () => callCount,
  };
}

function makeMultiAgentRegistry(
  agents: Record<string, { outputs: string[] }>,
) {
  const mocks: Record<string, ReturnType<typeof mock>> = {};
  const callCounts: Record<string, number> = {};

  for (const [name, cfg] of Object.entries(agents)) {
    callCounts[name] = 0;
    const localName = name;
    mocks[localName] = mock(async () => {
      const output = cfg.outputs[callCounts[localName]] ?? "";
      callCounts[localName]++;
      return {
        output,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      };
    });
  }

  return {
    registry: {
      getAgent: (name: string) => {
        const m = mocks[name];
        if (!m) return undefined;
        return { complete: m };
      },
    } as unknown as AgentRegistry,
    mocks,
    callCounts,
  };
}

describe("completeWithFallback empty-output synthesis (AC4)", () => {
  test("AC4a: empty output with no adapterFailure synthesizes fail-stale with reason empty-output", async () => {
    const { registry } = makeStaticRegistry("claude", [""]);
    // maxStaleRetries=0, no fallback — so synthesized failure is returned immediately
    const config = naxConfigWith(0, false);
    const m = new AgentManager(config, registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    const failure = outcome.result.adapterFailure;
    expect(failure).toBeDefined();
    expect(failure?.outcome).toBe("fail-stale");
    expect(failure?.reason).toBe("empty-output");
    expect(failure?.retriable).toBe(true);
  });

  test("AC4b: non-empty output returns success with no synthesis", async () => {
    const { registry } = makeStaticRegistry("claude", ["hello world"]);
    const m = new AgentManager(naxConfigWith(), registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(outcome.result.output).toBe("hello world");
    expect(outcome.result.adapterFailure).toBeUndefined();
  });

  test("AC4c: whitespace-only output triggers synthesis", async () => {
    const { registry } = makeStaticRegistry("claude", ["   "]);
    const config = naxConfigWith(0, false);
    const m = new AgentManager(config, registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
    expect(outcome.result.adapterFailure?.reason).toBe("empty-output");
  });

  test("AC4d: pre-existing adapterFailure on empty output is NOT overwritten", async () => {
    // Registry returns empty output but also a pre-existing failure
    const existingFailure = {
      outcome: "fail-auth" as const,
      category: "availability" as const,
      retriable: false,
      message: "auth failed",
    };
    const registry = {
      getAgent: (name: string) => {
        if (name !== "claude") return undefined;
        return {
          complete: mock(async () => ({
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            adapterFailure: existingFailure,
          })),
        };
      },
    } as unknown as AgentRegistry;

    const config = naxConfigWith(0, false);
    const m = new AgentManager(config, registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    // Should NOT be overwritten with fail-stale
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-auth");
  });
});

describe("completeWithFallback staleRetryAttempts counter (AC5)", () => {
  test("AC5a: retries same agent up to maxRetryAttempts=3 before exhausting (adapter called 4 times total)", async () => {
    // 4 calls all return empty: initial + 3 retries = 4 total; no fallback so we stop there
    const { registry, getCallCount } = makeStaticRegistry("claude", ["", "", "", ""]);
    const config = naxConfigWith(3, false);
    const m = new AgentManager(config, registry);
    await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(getCallCount()).toBe(4);
  });

  test("AC5b: maxRetryAttempts=1 results in 2 calls total (1 initial + 1 retry)", async () => {
    const { registry, getCallCount } = makeStaticRegistry("claude", ["", ""]);
    const config = naxConfigWith(1, false);
    const m = new AgentManager(config, registry);
    await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(getCallCount()).toBe(2);
  });
});

describe("completeWithFallback retry success (AC6)", () => {
  test("AC6a: retry succeeds on second attempt — only 2 calls, no fallback", async () => {
    // First call returns empty, second returns non-empty
    const { registry, getCallCount } = makeStaticRegistry("claude", ["", "success output"]);
    const m = new AgentManager(naxConfigWith(3, false), registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(outcome.result.output).toBe("success output");
    expect(outcome.result.adapterFailure).toBeUndefined();
    // Stale-retry hop is recorded in fallbacks (mirrors runWithFallback behavior)
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
    expect(outcome.fallbacks[0].newAgent).toBe("claude"); // same-agent retry
    expect(getCallCount()).toBe(2);
  });

  test("AC6b: exhausted retries + fallback configured → swaps to fallback agent", async () => {
    const { registry, callCounts } = makeMultiAgentRegistry({
      claude: { outputs: ["", "", "", ""] },  // 4 empties: initial + 3 retries
      codex: { outputs: ["from codex"] },
    });
    const m = new AgentManager(naxConfigWith(3), registry);
    const outcome = await m.completeWithFallback("prompt", baseOptions, "claude");
    expect(outcome.result.output).toBe("from codex");
    expect(outcome.fallbacks.length).toBeGreaterThan(0);
    expect(callCounts["claude"]).toBe(4);
    expect(callCounts["codex"]).toBe(1);
  });
});

// BUG-4 (Round 2 review): when the registry returned `undefined` for the
// requested agent (e.g. `agent.default: "foo"` where "foo" isn't registered),
// completeWithFallback early-returned `{ output: "", tokenUsage: {0,0},
// estimatedCostUsd: 0 }` with no `adapterFailure` and no fallback attempt —
// silently producing empty success on every complete() path. The pre-fix
// fail-stale synthesis at lines 514-519 only wrapped results from
// `adapter.complete`, so a missing adapter skipped it entirely. `runAs`
// correctly throws NaxError("AGENT_NOT_FOUND") at the same boundary.
describe("completeWithFallback — BUG-4 missing adapter regression", () => {
  test("throws NaxError('AGENT_NOT_FOUND') when registry has no entry for the requested agent", async () => {
    const emptyRegistry = {
      getAgent: (_name: string) => undefined,
    } as unknown as AgentRegistry; // test-ratchet-allow: as-unknown-as

    const m = new AgentManager(naxConfigWith(), emptyRegistry);

    let caught: unknown;
    try {
      await m.completeWithFallback("prompt", baseOptions, "unregistered-agent");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("AGENT_NOT_FOUND");
    expect((caught as { message?: string }).message ?? "").toContain("unregistered-agent");
  });

  test("does NOT silently return empty success when the agent is missing (pre-fix regression)", async () => {
    const emptyRegistry = {
      getAgent: (_name: string) => undefined,
    } as unknown as AgentRegistry; // test-ratchet-allow: as-unknown-as

    const m = new AgentManager(naxConfigWith(), emptyRegistry);

    // Pre-fix this resolved to `{ output: "", tokenUsage: {0,0}, ...}` with
    // no adapterFailure — silently producing empty success on every
    // complete() path. Post-fix it throws instead.
    const callCompleteAs = () => m.completeAs("unregistered-agent", "prompt", {
      ...baseOptions,
      resolvedPermissions: baseOptions.resolvedPermissions,
    });

    await expect(callCompleteAs()).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
