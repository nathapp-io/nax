/**
 * Unit test — AC7: exhaustion boundary — callOp throws CALL_OP_NO_OUTPUT when all retries exhaust.
 *
 * Tests that after all manager-tier retries and swaps exhaust with empty output,
 * callOp throws NaxError with code CALL_OP_NO_OUTPUT (not CALL_OP_PARSE_FAILED
 * or any other code).
 *
 * - Run-kind: CALL_OP_NO_OUTPUT is thrown at call.ts line 471 when rawOutput is falsy.
 * - Complete-kind: completeWithFallback exhaustion returns empty output; op.parse receives "".
 *   When op.parse throws on empty, the error propagates through callOp (not as CALL_OP_NO_OUTPUT).
 *   When op.parse succeeds on empty (returns ""), callOp returns "".
 *   The AC7 test for complete-kind verifies callOp does NOT throw CALL_OP_PARSE_FAILED —
 *   it either returns empty or the error from op.parse, preserving the correct code boundary.
 *
 * Pattern:
 *   - makeMockAgentManager for tests that control dispatch at the manager level
 *   - makeTestRuntime for tests that use the real AgentManager
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TurnResult } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { callOp } from "@/operations";
import type { CompleteOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import {
  agentManagerInternals,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";

const sel = pickSelector("call-exhaustion-test", "routing");

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

function makeCompleteOp(name: string): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name,
    stage: "run",
    config: sel,
    build: (input) => ({
      role: { id: "role", content: "Echo the input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

// ---------------------------------------------------------------------------
// Runtime cleanup (mandatory per project rules)
// ---------------------------------------------------------------------------

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// ---------------------------------------------------------------------------
// AC7: run-kind exhaustion → CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("AC7: run-kind — all retries exhaust → CALL_OP_NO_OUTPUT", () => {
  test("maxRetryAttempts=0, no fallback, empty output → throws CALL_OP_NO_OUTPUT", async () => {
    // runWithFallbackFn performs a single hop with empty output (no same-agent retry).
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: (Error & { code?: string }) | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-001" },
        makeRunOp("run-exhaustion-no-retry"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("multiple retries all return empty → throws CALL_OP_NO_OUTPUT (not CALL_OP_PARSE_FAILED)", async () => {
    let hopCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        // Simulate 3 retries (1 initial + 2 retries), all returning empty.
        let lastHop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        hopCount++;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (lastHop.result.adapterFailure?.outcome !== "fail-stale") break;
          lastHop = await req.executeHop!("claude", undefined, { kind: "stale-retry", attempt }, req.runOptions);
          hopCount++;
        }
        return { result: { ...lastHop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "", // always empty
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: (Error & { code?: string }) | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-002" },
        makeRunOp("run-exhaustion-after-retries"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    // Error code must specifically be CALL_OP_NO_OUTPUT, not CALL_OP_PARSE_FAILED
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown?.code).not.toBe("CALL_OP_PARSE_FAILED");
    expect(hopCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC7: complete-kind exhaustion via real AgentManager
// ---------------------------------------------------------------------------

describe("AC7: complete-kind — all retries exhaust → parse receives empty string", () => {
  test("maxRetryAttempts=0, no fallback, empty output → callOp returns empty string (parse succeeds)", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 0, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    let callCount = 0;
    const adapter = {
      complete: async () => {
        callCount++;
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      },
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    // complete-kind: completeWithFallback exhausts, completeAs returns empty output,
    // callOp calls op.parse("") → returns "" (trim of empty string).
    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-003" },
      makeCompleteOp("complete-exhaustion-no-retry"),
      "hello",
    );

    // No exception thrown — op.parse("") returns "" which callOp returns as-is.
    expect(result).toBe("");
    // maxRetryAttempts=0 → only 1 call (no same-agent retries)
    expect(callCount).toBe(1);
  });

  test("complete-kind exhaustion error code is NOT CALL_OP_PARSE_FAILED when parse rejects empty", async () => {
    // When op.parse throws on empty output and there is no op.retry strategy,
    // callOp re-throws the parse error directly (not wrapped as CALL_OP_PARSE_FAILED).
    // This verifies the error code boundary — parse errors are not confused with
    // agent-level no-output errors.
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 0, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    const adapter = {
      complete: async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    // Op that throws on empty output (no retry strategy)
    const rejectEmptyOp: CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "complete",
      name: "reject-empty-parse",
      stage: "run",
      config: sel,
      build: (input) => ({
        role: { id: "role", content: "Echo the input.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => {
        if (!output.trim()) throw new Error("parse-rejected-empty");
        return output.trim();
      },
    };

    let thrown: (Error & { code?: string }) | null = null;
    try {
      await callOp(
        { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-004" },
        rejectEmptyOp,
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    // Parse error propagates as-is (no retry strategy) — NOT CALL_OP_PARSE_FAILED
    expect(thrown?.message).toContain("parse-rejected-empty");
    expect(thrown?.code).not.toBe("CALL_OP_PARSE_FAILED");
    expect(thrown?.code).not.toBe("CALL_OP_NO_OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// AC7: error code discrimination — CALL_OP_NO_OUTPUT vs CALL_OP_PARSE_FAILED
// ---------------------------------------------------------------------------

describe("AC7: error code is CALL_OP_NO_OUTPUT specifically (run-kind)", () => {
  test("run-kind empty output throws with code CALL_OP_NO_OUTPUT", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hop = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: (Error & { code?: string }) | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-005" },
        makeRunOp("error-code-check"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    // Specifically CALL_OP_NO_OUTPUT — not a parse failure or generic error
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown?.code).not.toBe("CALL_OP_PARSE_FAILED");
    expect(thrown?.code).not.toBe("CALL_OP_MAX_RETRIES");
    expect(thrown?.code).not.toBe("CALL_OP_ABORTED");
  });
});
