/**
 * Integration test — AC3: run-kind callOp empty-output retry via runWithFallback.
 *
 * When a run-kind op receives empty agent output, sendWithFileOutput synthesises
 * a retriable fail-stale AdapterFailure. AgentManager.runWithFallback recognises
 * this and retries the same agent up to idleWatchdog.maxRetryAttempts times before
 * exhaustion (or fallback agent swap).
 *
 * These tests exercise the full dispatch path:
 *   callOp → runWithFallback → executeHop (sendWithFileOutput synthesis) → fail-stale
 *   → same-agent retry → success / exhaustion
 *
 * Pattern (from test/unit/operations/call-empty-output.test.ts):
 *   - makeMockAgentManager({ runWithFallbackFn, runAsSessionFn })
 *   - runWithFallbackFn calls req.executeHop multiple times to simulate retry loop
 *   - runAsSessionFn controls what the underlying send returns (stateful via counter)
 */
import { describe, expect, test } from "bun:test";
import { callOp } from "../../../src/operations";
import type { RunOperation } from "../../../src/operations";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import { makeMockAgentManager, makeMockCallContext, makeMockRuntime, makeSessionManager } from "../../helpers";
import type { TurnResult } from "../../../src/agents/types";

const sel = pickSelector("run-empty-output-retry-test", "routing");

function makeRunOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: sel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "Echo the input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

function makeTurnResult(output: string): TurnResult {
  return {
    output,
    estimatedCostUsd: 0,
    internalRoundTrips: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// AC3 — happy path: empty output on first attempt, success on retry
// ---------------------------------------------------------------------------

describe("AC3: run-kind empty-output → runWithFallback retry (same agent)", () => {
  test("empty output on first hop → retry engages → returns success on second hop", async () => {
    let hopCallCount = 0;

    // runAsSessionFn is the underlying send. Return empty on first call, success on second.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        // Simulate retry: first hop triggers fail-stale synthesis, second succeeds.
        // executeHop calls sendWithFileOutput internally which synthesises fail-stale
        // when output is empty — we call it twice to exercise the retry loop.
        const firstHop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);

        // After first hop with empty output, adapterFailure is synthesised (fail-stale).
        // Retry by calling executeHop again (same agent).
        if (firstHop.result.adapterFailure?.outcome === "fail-stale") {
          const retryHop = await req.executeHop!(
            "claude",
            undefined,
            { kind: "stale-retry", attempt: 1 },
            req.runOptions,
          );
          return { result: { ...retryHop.result, agentFallbacks: [] }, fallbacks: [] };
        }

        return { result: { ...firstHop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        hopCallCount++;
        if (hopCallCount === 1) {
          return makeTurnResult(""); // empty — triggers fail-stale synthesis
        }
        return makeTurnResult("success on retry");
      },
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });

    const result = await callOp(
      makeMockCallContext({ runtime }),
      makeRunOp("retry-happy-path"),
      "hello",
    );

    expect(result).toBe("success on retry");
    expect(hopCallCount).toBe(2);
  });

  test("empty output on first two hops → retries → returns success on third hop", async () => {
    let hopCallCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        // Loop up to 3 times, retrying when fail-stale is synthesised.
        let lastHop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);

        for (let attempt = 1; attempt <= 2; attempt++) {
          if (lastHop.result.adapterFailure?.outcome !== "fail-stale") break;
          lastHop = await req.executeHop!(
            "claude",
            undefined,
            { kind: "stale-retry", attempt },
            req.runOptions,
          );
        }

        return { result: { ...lastHop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        hopCallCount++;
        if (hopCallCount <= 2) {
          return makeTurnResult(""); // empty — triggers fail-stale synthesis
        }
        return makeTurnResult("eventual success");
      },
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });

    const result = await callOp(
      makeMockCallContext({ runtime }),
      makeRunOp("retry-two-failures"),
      "hello",
    );

    expect(result).toBe("eventual success");
    expect(hopCallCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC3 — exhaustion path: all retries produce empty output → CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("AC3: run-kind empty-output — all retries exhausted → CALL_OP_NO_OUTPUT", () => {
  test("all hops return empty output → runWithFallback passes empty result → callOp throws CALL_OP_NO_OUTPUT", async () => {
    let hopCallCount = 0;

    // maxRetryAttempts=2: simulate 3 total hops (1 initial + 2 retries), all empty.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        // 1 initial + 2 retries = 3 hops, all producing empty output.
        let lastHop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);

        for (let attempt = 1; attempt <= 2; attempt++) {
          if (lastHop.result.adapterFailure?.outcome !== "fail-stale") break;
          lastHop = await req.executeHop!(
            "claude",
            undefined,
            { kind: "stale-retry", attempt },
            req.runOptions,
          );
        }

        // All retries exhausted — pass empty result back to callOp.
        return { result: { ...lastHop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        hopCallCount++;
        return makeTurnResult(""); // always empty
      },
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });

    let thrown: Error & { code?: string } | null = null;
    try {
      await callOp(makeMockCallContext({ runtime }), makeRunOp("exhaust-retries"), "hello");
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
    // 1 initial + 2 retries = 3 total send calls
    expect(hopCallCount).toBe(3);
  });

  test("single hop with empty output and no retry → immediately throws CALL_OP_NO_OUTPUT", async () => {
    let hopCallCount = 0;

    // runWithFallbackFn performs no retry — simulates maxRetryAttempts=0 case.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        hopCallCount++;
        return makeTurnResult(""); // always empty, no retry in manager
      },
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });

    let thrown: Error & { code?: string } | null = null;
    try {
      await callOp(makeMockCallContext({ runtime }), makeRunOp("zero-retries"), "hello");
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
    expect(hopCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — synthesis verification: empty output sets adapterFailure with correct shape
// ---------------------------------------------------------------------------

describe("AC3: sendWithFileOutput synthesises fail-stale on empty run-kind output", () => {
  test("synthesised adapterFailure has outcome=fail-stale, reason=empty-output, retriable=true", async () => {
    let capturedAdapterFailure: unknown;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        // Capture what sendWithFileOutput synthesised on the hop result.
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => makeTurnResult(""),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });

    try {
      await callOp(makeMockCallContext({ runtime }), makeRunOp("synthesis-check"), "hello");
    } catch {
      // expected CALL_OP_NO_OUTPUT — we only care about the synthesised failure shape
    }

    const f = capturedAdapterFailure as { outcome?: string; category?: string; retriable?: boolean; reason?: string } | undefined;
    expect(f?.outcome).toBe("fail-stale");
    expect(f?.category).toBe("availability");
    expect(f?.retriable).toBe(true);
    expect(f?.reason).toBe("empty-output");
  });
});
