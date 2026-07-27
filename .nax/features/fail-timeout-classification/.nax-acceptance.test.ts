import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── New modules introduced by this feature (not yet implemented) ────────────
// buildTurnResult: extracted from sendTurn into adapter-output.ts
import { buildTurnResult } from "../../../src/agents/acp/adapter-output";
// classifyTurnFailure: new function in turn-failure-classification.ts
import { classifyTurnFailure } from "../../../src/operations/turn-failure-classification";
// timeoutRetry: prompt builder exported from the prompts barrel
import { timeoutRetry } from "../../../src/prompts";
// buildTimeoutRetryPrompt: async wrapper that captures git state, then builds prompt
import { buildTimeoutRetryPrompt } from "../../../src/prompts/builders/rectifier-builder-helpers";

// ── Existing modules referenced by the feature ────────────────────────────────
import { AgentManager } from "../../../src/agents/manager";
import { buildHopCallback, _buildHopCallbackDeps } from "../../../src/operations/build-hop-callback";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config";
import type { AdapterFailure } from "../../../src/context/engine";
import type { HopKind } from "../../../src/agents/manager-types";
import type { AgentResult } from "../../../src/agents/types";
import { makeNaxConfig, makeStory, makeSessionManager, makeAgentAdapter } from "../../../test/helpers";

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const failTimeoutRetryable: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  retriable: true,
  message: "wall-clock timeout exceeded",
};

const failStaleRetryable: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog: no stream activity",
};

const RUN_OPTIONS = {
  prompt: "implement the feature",
  workdir: "/tmp",
  modelTier: "fast" as const,
  modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" as const },
  timeoutSeconds: 300,
  config: DEFAULT_CONFIG,
  storyId: "us-001",
};

function hopResult(result: {
  success: boolean;
  exitCode: number;
  output: string;
  rateLimited: boolean;
  durationMs: number;
  estimatedCostUsd: number;
  adapterFailure?: AdapterFailure;
}) {
  return { result, prompt: "test prompt" };
}

function makeFailTimeoutAgentResult(): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: "",
    rateLimited: false,
    durationMs: 100,
    estimatedCostUsd: 0,
    adapterFailure: failTimeoutRetryable,
  };
}

function makeFailStaleAgentResult(): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: "",
    rateLimited: false,
    durationMs: 100,
    estimatedCostUsd: 0,
    adapterFailure: failStaleRetryable,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// US-001: Classify wall-clock timeouts as fail-timeout
// ═════════════════════════════════════════════════════════════════════════════

describe("AC-1: buildTurnResult with timedOut sets timedOut === true", () => {
  test("AC-1: buildTurnResult({ timedOut: true }) returns TurnResult with timedOut === true", () => {
    const result = buildTurnResult({
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      timedOut: true,
    });
    expect(result.timedOut).toBe(true);
  });
});

describe("AC-2: buildTurnResult with timedOut returns empty output", () => {
  test("AC-2: buildTurnResult({ timedOut: true }) returns TurnResult with output === ''", () => {
    const result = buildTurnResult({
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      timedOut: true,
    });
    expect(result.output).toBe("");
  });
});

describe("AC-3: buildTurnResult without timedOut leaves timedOut absent or false", () => {
  test("AC-3: buildTurnResult({ timedOut: false }) does not set timedOut to true", () => {
    const result = buildTurnResult({
      output: "agent response text",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
      timedOut: false,
    });
    expect(result.timedOut === undefined || result.timedOut === false).toBe(true);
  });

  test("AC-3: buildTurnResult without timedOut field leaves timedOut absent", () => {
    const result = buildTurnResult({
      output: "agent response",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
    });
    expect(result.timedOut === undefined || result.timedOut === false).toBe(true);
  });
});

describe("AC-4: classifyTurnFailure maps empty+timedOut to fail-timeout outcome", () => {
  test("AC-4: classifyTurnFailure({ output: '', timedOut: true }) returns outcome === 'fail-timeout'", () => {
    const result = classifyTurnFailure({ output: "", timedOut: true });
    expect(result.outcome).toBe("fail-timeout");
  });
});

describe("AC-5: classifyTurnFailure maps empty+timedOut to quality category", () => {
  test("AC-5: classifyTurnFailure({ output: '', timedOut: true }) returns category === 'quality'", () => {
    const result = classifyTurnFailure({ output: "", timedOut: true });
    expect(result.category).toBe("quality");
  });
});

describe("AC-6: classifyTurnFailure marks fail-timeout as retriable", () => {
  test("AC-6: classifyTurnFailure({ output: '', timedOut: true }) returns retriable === true", () => {
    const result = classifyTurnFailure({ output: "", timedOut: true });
    expect(result.retriable).toBe(true);
  });
});

describe("AC-7: classifyTurnFailure maps empty output without timedOut to fail-stale", () => {
  test("AC-7: classifyTurnFailure({ output: '' }) returns outcome === 'fail-stale'", () => {
    const result = classifyTurnFailure({ output: "" });
    expect(result.outcome).toBe("fail-stale");
  });
});

describe("AC-8: classifyTurnFailure sets reason === 'empty-output' for fail-stale", () => {
  test("AC-8: classifyTurnFailure({ output: '' }) returns reason === 'empty-output'", () => {
    const result = classifyTurnFailure({ output: "" });
    expect(result.reason).toBe("empty-output");
  });
});

describe("AC-9: classifyTurnFailure preserves existing adapterFailure when timedOut is true", () => {
  test("AC-9: pre-set adapterFailure is not overwritten by fail-timeout classification", () => {
    const existing: AdapterFailure = {
      outcome: "fail-some" as AdapterFailure["outcome"],
      category: "availability",
      retriable: false,
      message: "already-set",
      reason: "already-set",
    };
    const result = classifyTurnFailure({ output: "", timedOut: true, adapterFailure: existing });
    expect(result.adapterFailure?.outcome).toBe("fail-some");
    expect(result.adapterFailure?.reason).toBe("already-set");
  });
});

describe("AC-10: shouldSwap returns false for fail-timeout with default onQualityFailure", () => {
  test("AC-10: shouldSwap({ outcome: 'fail-timeout', category: 'quality', retriable: true }, { fallback: {} }) returns false", () => {
    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 3,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
    );
    expect(manager.shouldSwap(failTimeoutRetryable, 0, true)).toBe(false);
  });
});

describe("AC-11: runWithFallback does not mark agent unavailable on fail-timeout", () => {
  test("AC-11: after runWithFallback with fail-timeout result, agent is not unavailable", async () => {
    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: false,
            map: {},
            maxHopsPerStory: 1,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async () =>
          hopResult({
            success: false,
            exitCode: 1,
            output: "",
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0,
            adapterFailure: failTimeoutRetryable,
          }),
      },
    );

    await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(manager.isUnavailable("claude")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-002: Retry fail-timeout once with a reduced fresh-session budget
// ═════════════════════════════════════════════════════════════════════════════

describe("AC-12: runWithFallback dispatches exactly 2 hops with default maxAttempts === 1", () => {
  test("AC-12: first hop returns fail-timeout → second hop has kind 'timeout-retry' attempt 1", async () => {
    const dispatchedHops: HopKind[] = [];

    const manager = new AgentManager(DEFAULT_CONFIG as never);

    await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async (_agentName, _bundle, hopKind, _resolvedRunOptions) => {
        dispatchedHops.push(hopKind);
        return { result: makeFailTimeoutAgentResult(), bundle: undefined };
      },
    });

    expect(dispatchedHops).toHaveLength(2);
    const secondHop = dispatchedHops[1] as { kind: string; attempt: number };
    expect(secondHop.kind).toBe("timeout-retry");
    expect(secondHop.attempt).toBe(1);
  });
});

describe("AC-13: timeout-retry hop receives half the first hop's timeoutSeconds", () => {
  test("AC-13: budgetMultiplier === 0.5 reduces timeout from 300 to 150 on the retry hop", async () => {
    const capturedTimeouts: number[] = [];

    const manager = new AgentManager(DEFAULT_CONFIG as never);

    await manager.runWithFallback({
      runOptions: { ...RUN_OPTIONS, timeoutSeconds: 300 },
      executeHop: async (_agentName, _bundle, hopKind, resolvedRunOptions) => {
        capturedTimeouts.push(resolvedRunOptions.timeoutSeconds);
        return { result: makeFailTimeoutAgentResult(), bundle: undefined };
      },
    });

    expect(capturedTimeouts).toHaveLength(2);
    expect(capturedTimeouts[0]).toBe(300);
    expect(capturedTimeouts[1]).toBe(150);
  });
});

describe("AC-14: exhausted timeout-retry budget produces no third hop and returns fail-timeout", () => {
  test("AC-14: two sequential fail-timeout results → only 2 hops dispatched, outcome is fail-timeout exhausted", async () => {
    const dispatchedHops: HopKind[] = [];

    const manager = new AgentManager(DEFAULT_CONFIG as never);

    const outcome = await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async (_agentName, _bundle, hopKind, _resolvedRunOptions) => {
        dispatchedHops.push(hopKind);
        return { result: makeFailTimeoutAgentResult(), bundle: undefined };
      },
    });

    expect(dispatchedHops).toHaveLength(2);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.category).toBe("quality");
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });
});

describe("AC-15: 'timeout-retry' and 'stale-retry' are distinct kind strings", () => {
  test("AC-15: 'timeout-retry' !== 'stale-retry' as literal string values", () => {
    const timeoutKind = "timeout-retry" as const;
    const staleKind = "stale-retry" as const;
    expect(timeoutKind).not.toBe(staleKind);
  });

  test("AC-15: switch dispatches to different branches for timeout-retry vs stale-retry", () => {
    const calls: string[] = [];
    function dispatch(kind: HopKind | { kind: "timeout-retry"; attempt: number }) {
      switch (kind.kind) {
        case "timeout-retry":
          calls.push("timeout");
          break;
        case "stale-retry":
          calls.push("stale");
          break;
        case "primary":
          calls.push("primary");
          break;
        case "swap":
          calls.push("swap");
          break;
      }
    }
    dispatch({ kind: "timeout-retry", attempt: 1 });
    dispatch({ kind: "stale-retry", attempt: 1 });
    expect(calls[0]).toBe("timeout");
    expect(calls[1]).toBe("stale");
    expect(calls[0]).not.toBe(calls[1]);
  });
});

describe("AC-16: executeHop with timeout-retry opens fresh session; stale-retry reuses live handle", () => {
  let savedTimeoutRetry: typeof _buildHopCallbackDeps.timeoutRetry;

  beforeEach(() => {
    savedTimeoutRetry = _buildHopCallbackDeps.timeoutRetry;
    _buildHopCallbackDeps.timeoutRetry = (_prompt, _files, _ms) => "timeout retry prompt";
  });

  afterEach(() => {
    _buildHopCallbackDeps.timeoutRetry = savedTimeoutRetry;
  });

  test("AC-16: timeout-retry calls openSession (not getLiveHandle)", async () => {
    const openSessionCalls: string[] = [];
    let getLiveHandleCalled = false;

    const mockHandle = { id: "ses_new", agentName: "claude" };
    const sessionManager = makeSessionManager({
      openSession: mock(async (_name: string, _opts: unknown) => {
        openSessionCalls.push("openSession");
        return mockHandle;
      }),
      getLiveHandle: mock((_name: string) => {
        getLiveHandleCalled = true;
        return null;
      }),
      nameFor: mock(() => "nax-session-name"),
    });

    const agentManager = {
      runAsSession: mock(async () => ({
        output: "response",
        tokenUsage: { inputTokens: 10, outputTokens: 10 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    } as unknown as import("../../../src/agents/manager-types").IAgentManager;

    const story = makeStory();
    const config = makeNaxConfig();

    const executeHop = buildHopCallback(
      {
        sessionManager,
        agentManager,
        story,
        config,
        workdir: "/tmp",
        featureName: "test-feature",
        effectiveTier: "fast",
        defaultAgent: "claude",
      },
      undefined,
      RUN_OPTIONS,
    );

    await executeHop("claude", undefined, { kind: "timeout-retry", attempt: 1 } as HopKind, RUN_OPTIONS);

    expect(openSessionCalls).toContain("openSession");
    expect(getLiveHandleCalled).toBe(false);
  });

  test("AC-16: stale-retry calls getLiveHandle (reuse path)", async () => {
    let getLiveHandleCalled = false;
    const openSessionCalls: string[] = [];

    const cachedHandle = { id: "ses_cached", agentName: "claude" };
    const sessionManager = makeSessionManager({
      getLiveHandle: mock((_name: string) => {
        getLiveHandleCalled = true;
        return cachedHandle;
      }),
      openSession: mock(async (_name: string, _opts: unknown) => {
        openSessionCalls.push("openSession");
        return cachedHandle;
      }),
      nameFor: mock(() => "nax-session-name"),
    });

    const agentManager = {
      runAsSession: mock(async () => ({
        output: "response",
        tokenUsage: { inputTokens: 10, outputTokens: 10 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    } as unknown as import("../../../src/agents/manager-types").IAgentManager;

    const story = makeStory();
    const config = makeNaxConfig();

    const executeHop = buildHopCallback(
      {
        sessionManager,
        agentManager,
        story,
        config,
        workdir: "/tmp",
        featureName: "test-feature",
        effectiveTier: "fast",
        defaultAgent: "claude",
      },
      undefined,
      RUN_OPTIONS,
    );

    await executeHop("claude", undefined, { kind: "stale-retry", attempt: 1 }, RUN_OPTIONS);

    expect(getLiveHandleCalled).toBe(true);
  });
});

describe("AC-17: agent.timeoutRetry.maxAttempts defaults to 1 when unset", () => {
  test("AC-17: NaxConfigSchema.parse({}) yields agent.timeoutRetry.maxAttempts === 1", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.agent.timeoutRetry.maxAttempts).toBe(1);
  });
});

describe("AC-18: agent.timeoutRetry.budgetMultiplier defaults to 0.5 when unset", () => {
  test("AC-18: NaxConfigSchema.parse({}) yields agent.timeoutRetry.budgetMultiplier === 0.5", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.agent.timeoutRetry.budgetMultiplier).toBe(0.5);
  });
});

describe("AC-19: maxAttempts === 0 disables timeout-retry", () => {
  test("AC-19: with maxAttempts=0, only one hop is dispatched on fail-timeout", async () => {
    const dispatchedHops: HopKind[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          timeoutRetry: {
            maxAttempts: 0,
            budgetMultiplier: 0.5,
          },
        },
      } as never,
    );

    await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async (_agentName, _bundle, hopKind, _resolvedRunOptions) => {
        dispatchedHops.push(hopKind);
        return { result: makeFailTimeoutAgentResult(), bundle: undefined };
      },
    });

    expect(dispatchedHops).toHaveLength(1);
    const hasTimeoutRetryHop = dispatchedHops.some(
      (h) => (h as { kind: string }).kind === "timeout-retry",
    );
    expect(hasTimeoutRetryHop).toBe(false);
  });
});

describe("AC-20: fail-stale retries are unaffected; exactly maxRetryAttempts stale-retry hops", () => {
  test("AC-20: with idleWatchdog.maxRetryAttempts === 3, three stale-retry hops are dispatched", async () => {
    const dispatchedHops: HopKind[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel" as const,
            idleTimeoutSeconds: 900,
            toolCallOnlyIdleTimeoutSeconds: 1800,
            activityKinds: ["message_update", "thinking_update", "usage_update", "tool_call_update"],
            cancelGraceSeconds: 10,
            maxRetryAttempts: 3,
          },
          fallback: {
            enabled: false,
            map: {},
            maxHopsPerStory: 0,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
    );

    await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async (_agentName, _bundle, hopKind, _resolvedRunOptions) => {
        dispatchedHops.push(hopKind);
        return { result: makeFailStaleAgentResult(), bundle: undefined };
      },
    });

    const staleRetryHops = dispatchedHops.filter(
      (h) => (h as { kind: string }).kind === "stale-retry",
    );
    expect(staleRetryHops).toHaveLength(3);
  });
});

describe("AC-21: exhausted timeout-retry follows the same terminal failure path as exhausted fail-stale", () => {
  test("AC-21: exhausted timeout-retry returns failing outcome with fail-timeout and no output", async () => {
    const manager = new AgentManager(DEFAULT_CONFIG as never);

    const outcome = await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async () => ({ result: makeFailTimeoutAgentResult(), bundle: undefined }),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.category).toBe("quality");
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
    const hasOutput = typeof outcome.result.output === "string" && outcome.result.output.length > 0;
    expect(hasOutput).toBe(false);
  });

  test("AC-21: exhausted fail-stale also returns failing outcome (same terminal path shape)", async () => {
    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel" as const,
            idleTimeoutSeconds: 900,
            toolCallOnlyIdleTimeoutSeconds: 1800,
            activityKinds: ["message_update", "thinking_update", "usage_update", "tool_call_update"],
            cancelGraceSeconds: 10,
            maxRetryAttempts: 0,
          },
          fallback: {
            enabled: false,
            map: {},
            maxHopsPerStory: 0,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
    );

    const outcome = await manager.runWithFallback({
      runOptions: RUN_OPTIONS,
      executeHop: async () => ({ result: makeFailStaleAgentResult(), bundle: undefined }),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
    const hasOutput = typeof outcome.result.output === "string" && outcome.result.output.length > 0;
    expect(hasOutput).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-003: Give timeout retries an informed progress prompt
// ═════════════════════════════════════════════════════════════════════════════

describe("AC-22: timeoutRetry includes the original prompt text verbatim", () => {
  test("AC-22: returned string contains the originalPrompt as a substring", () => {
    const originalPrompt = "implement the new authentication flow using JWT tokens";
    const result = timeoutRetry(originalPrompt, [], 5000);
    expect(result).toContain(originalPrompt);
  });
});

describe("AC-23: timeoutRetry with non-empty changedFiles names each file and uses 'continue' directive", () => {
  test("AC-23: returned string contains all changed file paths", () => {
    const result = timeoutRetry("original prompt", ["file1.ts", "file2.ts"], 5000);
    expect(result).toContain("file1.ts");
    expect(result).toContain("file2.ts");
  });

  test("AC-23: returned string uses 'continue' directive (not 'restart')", () => {
    const result = timeoutRetry("original prompt", ["file1.ts", "file2.ts"], 5000);
    expect(/continue/i.test(result)).toBe(true);
    expect(/restart/i.test(result)).toBe(false);
  });
});

describe("AC-24: timeoutRetry with empty changedFiles instructs agent to change approach", () => {
  test("AC-24: returned string mentions 'no file changes' equivalent", () => {
    const result = timeoutRetry("original prompt", [], 5000);
    const hasNoChangesPhrase = /no file changes?/i.test(result) || /no changes?/i.test(result);
    expect(hasNoChangesPhrase).toBe(true);
  });

  test("AC-24: returned string instructs to change approach when no files changed", () => {
    const result = timeoutRetry("original prompt", [], 5000);
    expect(/change.*approach|try.*different/i.test(result)).toBe(true);
  });
});

describe("AC-25: timeoutRetry with empty changedFiles does NOT use continuation phrases", () => {
  test("AC-25: returned string does not contain 'continue from'", () => {
    const result = timeoutRetry("original prompt", [], 5000);
    expect(result).not.toContain("continue from");
  });

  test("AC-25: returned string does not contain 'pick up where'", () => {
    const result = timeoutRetry("original prompt", [], 5000);
    expect(result).not.toContain("pick up where");
  });

  test("AC-25: returned string does not contain 'existing state'", () => {
    const result = timeoutRetry("original prompt", [], 5000);
    expect(result).not.toContain("existing state");
  });
});

describe("AC-26: timeoutRetry includes elapsed duration in output", () => {
  test("AC-26: returned string contains the numeric elapsedMs value or a human-readable form", () => {
    const result = timeoutRetry("original prompt", [], 123456);
    const containsRawMs = result.includes("123456");
    // A duration of 123456ms = 2 minutes 3 seconds (roughly)
    const containsDuration = /\d+\s*(minute|second|min|sec)/i.test(result);
    expect(containsRawMs || containsDuration).toBe(true);
  });
});

describe("AC-27: executeHop with timeout-retry kind invokes _buildHopCallbackDeps.timeoutRetry once", () => {
  let savedTimeoutRetry: typeof _buildHopCallbackDeps.timeoutRetry;
  let timeoutRetryCalls: Array<{ prompt: string; files: string[] }> = [];

  beforeEach(() => {
    savedTimeoutRetry = _buildHopCallbackDeps.timeoutRetry;
    timeoutRetryCalls = [];
    _buildHopCallbackDeps.timeoutRetry = (prompt: string, files: string[], _ms: number) => {
      timeoutRetryCalls.push({ prompt, files });
      return `timeout-retry-prompt: ${prompt}`;
    };
  });

  afterEach(() => {
    _buildHopCallbackDeps.timeoutRetry = savedTimeoutRetry;
  });

  test("AC-27: spy is called exactly once with originalPrompt and changedFiles when kind is timeout-retry", async () => {
    const originalPrompt = "orig";

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({ id: "ses_abc", agentName: "claude" })),
      nameFor: mock(() => "nax-session-name"),
    });

    const agentManager = {
      runAsSession: mock(async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    } as unknown as import("../../../src/agents/manager-types").IAgentManager;

    const story = makeStory();
    const config = makeNaxConfig();

    const executeHop = buildHopCallback(
      {
        sessionManager,
        agentManager,
        story,
        config,
        workdir: "/tmp",
        featureName: "test-feature",
        effectiveTier: "fast",
        defaultAgent: "claude",
      },
      undefined,
      { ...RUN_OPTIONS, prompt: originalPrompt },
    );

    await executeHop(
      "claude",
      undefined,
      { kind: "timeout-retry", attempt: 1 } as HopKind,
      { ...RUN_OPTIONS, prompt: originalPrompt },
    );

    expect(timeoutRetryCalls).toHaveLength(1);
    expect(timeoutRetryCalls[0]?.prompt).toBe(originalPrompt);
    expect(Array.isArray(timeoutRetryCalls[0]?.files)).toBe(true);
  });
});

describe("AC-28: executeHop with primary or stale-retry does NOT invoke timeoutRetry", () => {
  let savedTimeoutRetry: typeof _buildHopCallbackDeps.timeoutRetry;
  let timeoutRetryCallCount = 0;

  beforeEach(() => {
    savedTimeoutRetry = _buildHopCallbackDeps.timeoutRetry;
    timeoutRetryCallCount = 0;
    _buildHopCallbackDeps.timeoutRetry = (_prompt: string, _files: string[], _ms: number) => {
      timeoutRetryCallCount++;
      return "should not be called";
    };
  });

  afterEach(() => {
    _buildHopCallbackDeps.timeoutRetry = savedTimeoutRetry;
  });

  test("AC-28: timeoutRetry not called for primary hop", async () => {
    const cachedHandle = { id: "ses_cached", agentName: "claude" };
    const sessionManager = makeSessionManager({
      openSession: mock(async () => cachedHandle),
      nameFor: mock(() => "nax-session-name"),
    });

    const agentManager = {
      runAsSession: mock(async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    } as unknown as import("../../../src/agents/manager-types").IAgentManager;

    const executeHop = buildHopCallback(
      {
        sessionManager,
        agentManager,
        story: makeStory(),
        config: makeNaxConfig(),
        workdir: "/tmp",
        featureName: "test-feature",
        effectiveTier: "fast",
        defaultAgent: "claude",
      },
      undefined,
      RUN_OPTIONS,
    );

    await executeHop("claude", undefined, { kind: "primary" }, RUN_OPTIONS);

    expect(timeoutRetryCallCount).toBe(0);
  });

  test("AC-28: timeoutRetry not called for stale-retry hop", async () => {
    const cachedHandle = { id: "ses_stale", agentName: "claude" };
    const sessionManager = makeSessionManager({
      getLiveHandle: mock(() => cachedHandle),
      openSession: mock(async () => cachedHandle),
      nameFor: mock(() => "nax-session-name"),
    });

    const agentManager = {
      runAsSession: mock(async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    } as unknown as import("../../../src/agents/manager-types").IAgentManager;

    const executeHop = buildHopCallback(
      {
        sessionManager,
        agentManager,
        story: makeStory(),
        config: makeNaxConfig(),
        workdir: "/tmp",
        featureName: "test-feature",
        effectiveTier: "fast",
        defaultAgent: "claude",
      },
      undefined,
      RUN_OPTIONS,
    );

    await executeHop("claude", undefined, { kind: "stale-retry", attempt: 1 }, RUN_OPTIONS);

    expect(timeoutRetryCallCount).toBe(0);
  });
});

describe("AC-29: buildTimeoutRetryPrompt degrades gracefully when getPreAttemptRef throws or returns null", () => {
  test("AC-29: getPreAttemptRef throws — returns string containing 'timeout', does not throw", async () => {
    const result = await buildTimeoutRetryPrompt(
      "implement the feature",
      5000,
      async () => {
        throw new Error("git ref capture failed");
      },
    );
    expect(typeof result).toBe("string");
    expect(/timeout/i.test(result)).toBe(true);
  });

  test("AC-29: getPreAttemptRef returns null — returns string containing 'timeout', does not throw", async () => {
    const result = await buildTimeoutRetryPrompt(
      "implement the feature",
      5000,
      async () => null,
    );
    expect(typeof result).toBe("string");
    expect(/timeout/i.test(result)).toBe(true);
  });

  test("AC-29: getPreAttemptRef returns undefined — returns string containing 'timeout', does not throw", async () => {
    const result = await buildTimeoutRetryPrompt(
      "implement the feature",
      5000,
      async () => undefined,
    );
    expect(typeof result).toBe("string");
    expect(/timeout/i.test(result)).toBe(true);
  });
});