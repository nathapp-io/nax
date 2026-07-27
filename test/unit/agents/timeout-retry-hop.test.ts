/**
 * US-002 — fail-timeout bounded retry via fresh-session hop.
 *
 * These tests assert runWithFallback's behaviour when a hop returns
 * `outcome: "fail-timeout"` (a wall-clock timeout):
 * - AC1: dispatch exactly one retry hop by default.
 * - AC2: the retry hop receives half the previous hop's timeoutSeconds.
 * - AC3: a fail-timeout on the retry hop terminates without a 3rd hop.
 * - AC5 (unit-level): the new hop's `HopKind` is `"timeout-retry"` (not
 *   `"stale-retry"`); the fresh-session dispatch test lives in the
 *   integration suite.
 * - AC8: maxAttempts=0 produces a single hop with no retry.
 * - AC9: fail-stale retries still respect `idleWatchdog.maxRetryAttempts`.
 * - AC10: exhausted fail-timeout surfaces the original failed result with no
 *   partial output, mirroring exhausted fail-stale.
 *
 * The fresh-session dispatch guarantee (AC5) is exercised end-to-end in
 * `test/integration/agents/timeout-retry-fresh-session.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents";
import type { AgentResult, HopKind } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import { makeNaxConfig } from "@test/helpers";

// Retriable wall-clock timeout — US-001 marked these as retriable=true so a
// fresh-session retry can extend the effective budget. Category is quality,
// outcome is fail-timeout.
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
  message: "idle timeout",
};

const STUB_BUNDLE = {
  pushMarkdown: "",
  pullTools: [],
  digest: "",
  manifest: {},
  chunks: [],
} as unknown as ContextBundle;

const STUB_RUN_OPTIONS = {
  prompt: "p",
  workdir: "/tmp",
  storyId: "US-002",
  sessionRole: "implementer" as const,
  // biome-ignore lint/suspicious/noExplicitAny: minimal AgentRunOptions stub for unit tests
} as any;

function makeSuccessResult(): AgentResult {
  return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
}

function makeFailResult(failure: AdapterFailure, output = ""): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCostUsd: 0.01,
    adapterFailure: failure,
  };
}

describe("AC1 — fail-timeout dispatches exactly one retry by default", () => {
  test("fail-timeout → 1 retry hop → success: exactly 2 dispatch calls", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind) => {
        hopKinds.push(hopKind);
        calls++;
        return { result: calls === 1 ? makeFailResult(failTimeoutRetryable) : makeSuccessResult(), bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(calls).toBe(2);
  });

  test("boundary: when noFallback is set, fail-timeout still retries once before terminal failure", async () => {
    // The noFallback flag suppresses swap, but the in-agent same-agent retry
    // for fail-timeout must still fire (ADR-018 §5.2 isolates swap, not retry).
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      noFallback: true,
      executeHop: async (_agent, _bundle, _hopKind) => {
        calls++;
        return { result: makeFailResult(failTimeoutRetryable), bundle: _bundle };
      },
    });

    // Primary + 1 retry = 2 calls.
    expect(calls).toBe(2);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });
});

describe("AC2 — timeout-retry hop receives half the previous timeoutSeconds", () => {
  test("primary timeoutSeconds=60 → retry hop receives timeoutSeconds=30", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const seenTimeoutSeconds: number[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind, resolvedRunOptions) => {
        calls++;
        seenTimeoutSeconds.push(resolvedRunOptions.timeoutSeconds);
        return { result: calls === 1 ? makeFailResult(failTimeoutRetryable) : makeSuccessResult(), bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(seenTimeoutSeconds).toEqual([60, 30]);
  });

  test("boundary: budgetMultiplier=0.25 doubles precision; multiplier is applied to the prior hop, not the original", async () => {
    // With multiplier=0.25 and primary=80s, the retry should see 20s — confirming
    // the multiplier is applied to the previous hop's budget (the spec wording is
    // "half the first hop's timeoutSeconds" only for the default 0.5; here we vary
    // the multiplier to lock in the "preceding-hop" semantics rather than the
    // original-hop semantics).
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.25 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const seenTimeoutSeconds: number[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 80 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind, resolvedRunOptions) => {
        calls++;
        seenTimeoutSeconds.push(resolvedRunOptions.timeoutSeconds);
        return { result: calls === 1 ? makeFailResult(failTimeoutRetryable) : makeSuccessResult(), bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(seenTimeoutSeconds[0]).toBe(80);
    expect(seenTimeoutSeconds[1]).toBe(20);
  });
});

describe("AC3 — exhausted fail-timeout retry does NOT dispatch a 3rd hop", () => {
  test("primary → timeout-retry (timeout) → terminal failure with 2 hops total", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind) => {
        calls++;
        return { result: makeFailResult(failTimeoutRetryable), bundle: _bundle };
      },
    });

    // Default maxAttempts=1 means: primary + 1 retry = 2 calls max.
    expect(calls).toBe(2);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });

  test("boundary: maxAttempts default caps retries at 1; ensures no third dispatch", async () => {
    // With default config (no explicit timeoutRetry block), exactly one retry
    // fires — the boundary condition for AC3 (no third hop).
    const manager = new AgentManager(DEFAULT_CONFIG);

    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind) => {
        calls++;
        return { result: makeFailResult(failTimeoutRetryable), bundle: _bundle };
      },
    });

    expect(calls).toBe(2);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });
});

describe("AC8 — maxAttempts=0 disables fail-timeout retry", () => {
  test("primary fail-timeout with maxAttempts=0 dispatches only 1 hop and never retries", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 0, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind) => {
        hopKinds.push(hopKind);
        calls++;
        return { result: makeFailResult(failTimeoutRetryable), bundle: _bundle };
      },
    });

    expect(calls).toBe(1);
    expect(hopKinds).toHaveLength(1);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });
});

describe("AC5 — fail-timeout retry emits { kind: 'timeout-retry', attempt: N }", () => {
  test("primary hop receives primary; timeout-retry hop receives timeout-retry with attempt=1", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind) => {
        hopKinds.push(hopKind);
        calls++;
        return { result: calls === 1 ? makeFailResult(failTimeoutRetryable) : makeSuccessResult(), bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(hopKinds).toHaveLength(2);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(hopKinds[1]).toEqual({ kind: "timeout-retry", attempt: 1 });
  });

  test("boundary: timeout-retry attempts increment by 1 on each retry (maxAttempts=2)", async () => {
    // With maxAttempts=2, a primary fail-timeout dispatches a 1st timeout-retry
    // (attempt=1); when that retry also fails, a 2nd timeout-retry fires
    // (attempt=2); when that retry also fails, runWithFallback returns the
    // terminal failure. The test must assert each retry is tagged with its
    // own monotonic attempt — a regression that mis-tagged every retry with
    // attempt=1 must NOT pass.
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 2, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const seenTimeoutRetry: HopKind[] = [];
    let calls = 0;
    await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind) => {
        calls++;
        if (hopKind.kind === "timeout-retry") seenTimeoutRetry.push(hopKind);
        return { result: makeFailResult(failTimeoutRetryable), bundle: _bundle };
      },
    });

    // 1 primary + 2 timeout-retries = 3 hops total.
    expect(calls).toBe(3);
    // Both retries must be present, with distinct attempt counters.
    expect(seenTimeoutRetry).toHaveLength(2);
    expect(seenTimeoutRetry[0]).toEqual({ kind: "timeout-retry", attempt: 1 });
    expect(seenTimeoutRetry[1]).toEqual({ kind: "timeout-retry", attempt: 2 });
  });
});

describe("AC9 — fail-stale retries still respect idleWatchdog.maxRetryAttempts (regression guard)", () => {
  // The fail-stale branch is verbatim in its existing shape per the design
  // notes; this regression test ensures the new fail-timeout retry wiring did
  // not disturb the fail-stale counter. Coverage for fail-stale=maxRetryAttempts
  // already exists in fail-stale-agent-manager.test.ts; this locks it in
  // alongside the new fail-timeout path.

  test("fail-stale with idleWatchdog.maxRetryAttempts=3 yields 4 dispatch calls, all on the same agent (regression AC4)", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: {
          enabled: true,
          mode: "warn-then-cancel",
          idleTimeoutSeconds: 30,
          activityKinds: ["message_update", "thinking_update", "usage_update"],
          cancelGraceSeconds: 5,
          maxRetryAttempts: 3,
        },
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const agents: string[] = [];
    const hopKinds: HopKind[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (agent, _bundle, hopKind) => {
        agents.push(agent);
        hopKinds.push(hopKind);
        calls++;
        return { result: makeFailResult(failStaleRetryable), bundle: _bundle };
      },
    });

    // 1 primary + 3 stale-retries = 4 calls.
    expect(calls).toBe(4);
    expect(agents.every((a) => a === "claude")).toBe(true);
    // First hop is primary; subsequent three are stale-retry with attempt 1..3.
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    for (let i = 1; i <= 3; i++) {
      expect(hopKinds[i]).toEqual({ kind: "stale-retry", attempt: i });
    }
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
  });
});

describe("AC10 — exhausted fail-timeout surfaces no partial output and follows the same terminal path", () => {
  test("exhausted fail-timeout returns the prior failed result with empty output and fail-timeout outcome", async () => {
    // When the retry hop also returns fail-timeout (exhausted), the calling
    // operation must receive the original failed result — no partial output
    // and no fallbacks-induced content — mirroring exhausted fail-stale
    // (which surfaces the final stale failure identically).
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind) => {
        // Both hops timeout — wall-clock exhausted, no partial output.
        return {
          result: makeFailResult(failTimeoutRetryable, ""),
          bundle: _bundle,
        };
      },
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.output).toBe("");
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
    expect(outcome.result.adapterFailure?.category).toBe("quality");
  });

  test("boundary: exhausted fail-timeout returns the retry hop's result (not the primary's), preserving current real-world behaviour", async () => {
    // AC10 says: "surfaced no output and follows the same terminal failure
    // path as exhausted fail-stale." `fail-stale` surfaces the *last* failing
    // result; this boundary test pins the contract that fail-timeout must do
    // the same — surface the retry hop's adapterFailure (which carries the
    // fresh attempt's wall-clock context), not the primary's.
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const RETRY_MESSAGE = "wall-clock timeout exceeded (30s limit, retry)";
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, timeoutSeconds: 60 },
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, _hopKind) => {
        calls++;
        const message = calls === 1 ? "primary timeout" : RETRY_MESSAGE;
        return {
          result: makeFailResult({ ...failTimeoutRetryable, message }),
          bundle: _bundle,
        };
      },
    });

    expect(calls).toBe(2);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.output).toBe("");
    expect(outcome.result.adapterFailure?.message).toBe(RETRY_MESSAGE);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
  });
});
