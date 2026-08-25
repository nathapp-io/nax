/**
 * Integration test — AC5, AC6: complete-kind callOp empty-output retry via completeWithFallback.
 *
 * When a complete-kind op returns empty agent output, completeWithFallback synthesises
 * a retriable fail-stale AdapterFailure (spec §B2). AgentManager.completeWithFallback
 * recognises this and retries the same agent up to idleWatchdog.maxRetryAttempts times
 * before exhaustion (or fallback agent swap).
 *
 * These tests exercise the full dispatch path through the real AgentManager:
 *   callOp → completeAs → completeWithFallback → synthesis → same-agent retry → success
 *
 * Pattern:
 *   - makeTestRuntime({ config }) for tests that need the real AgentManager
 *   - Inject mock adapters via agentManagerInternals(rt.agentManager)._resolveRegistry
 *   - Track created runtimes for mandatory afterEach cleanup
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { agentManagerInternals, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { CompleteOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const sel = pickSelector("complete-empty-output-retry-test", "routing");

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
// AC5 + AC6: happy path — empty on first attempt, success on retry
// ---------------------------------------------------------------------------

describe("AC5+AC6: complete-kind empty-output → completeWithFallback retry (same agent)", () => {
  test("empty output on first attempt → same-agent retry → returns success on second", async () => {
    let callCount = 0;
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 3, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    // Inject mock adapter: empty on first, success on second.
    const adapter = {
      complete: mock(async () => {
        callCount++;
        return {
          output: callCount === 1 ? "" : "success on retry",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeCompleteOp("ac5-ac6-happy-path"),
      "hello",
    );

    expect(result).toBe("success on retry");
    // 1 initial + 1 retry = 2 total adapter calls
    expect(callCount).toBe(2);
  });

  test("empty on first two → retry twice → returns success on third", async () => {
    let callCount = 0;
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 3, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    const adapter = {
      complete: mock(async () => {
        callCount++;
        return {
          output: callCount <= 2 ? "" : "eventual success",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      makeCompleteOp("ac5-two-retries-then-success"),
      "hello",
    );

    expect(result).toBe("eventual success");
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC5 exhaustion: maxRetryAttempts=1, all-empty → parse receives empty string
// The complete-kind path does not throw CALL_OP_NO_OUTPUT — op.parse("") returns ""
// ---------------------------------------------------------------------------

describe("AC5: complete-kind empty-output — retries exhausted", () => {
  test("maxRetryAttempts=1: 2 total calls (initial + 1 retry), parse receives empty string", async () => {
    let callCount = 0;
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 1, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    const adapter = {
      complete: mock(async () => {
        callCount++;
        return {
          output: "", // always empty
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    // op.parse("".trim()) returns "" — callOp returns "".
    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-003" },
      makeCompleteOp("ac5-exhaustion-maxretry-1"),
      "hello",
    );

    // 1 initial + 1 retry = 2 total calls (maxRetryAttempts=1)
    expect(callCount).toBe(2);
    // parse("") = "" — callOp returns empty string on complete-kind exhaustion
    expect(result).toBe("");
  });

  test("maxRetryAttempts=3: 4 total calls (initial + 3 retries) on all-empty output", async () => {
    let callCount = 0;
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 3, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    const adapter = {
      complete: mock(async () => {
        callCount++;
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-004" },
      makeCompleteOp("ac5-exhaustion-maxretry-3"),
      "hello",
    );

    // 1 initial + 3 retries = 4 total
    expect(callCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// AC6 swap: all-empty claude + working codex → callOp returns codex output
// ---------------------------------------------------------------------------

describe("AC6: complete-kind empty-output → agent swap to fallback", () => {
  test("claude exhausted + codex configured → callOp returns codex output", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 1, enabled: true, idleTimeoutSeconds: 900 },
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 3,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    let claudeCallCount = 0;
    let codexCallCount = 0;

    // Multi-agent adapter registry: claude always empty, codex returns success
    const adapters: Record<string, { complete: ReturnType<typeof mock> }> = {
      claude: {
        complete: mock(async () => {
          claudeCallCount++;
          return {
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        }),
      },
      codex: {
        complete: mock(async () => {
          codexCallCount++;
          return {
            output: "codex output",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        }),
      },
    };

    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({
      getAgent: (name: string) => adapters[name],
    });

    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-005" },
      makeCompleteOp("ac6-swap-to-codex"),
      "hello",
    );

    expect(result).toBe("codex output");
    // claude called: 1 initial + 1 retry (maxRetryAttempts=1) = 2 times
    expect(claudeCallCount).toBe(2);
    // codex called once after swap
    expect(codexCallCount).toBe(1);
  });

  test("claude immediate-swap (no retries) + codex → callOp returns codex output with maxRetryAttempts=0", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 0, enabled: true, idleTimeoutSeconds: 900 },
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 3,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    let claudeCallCount = 0;
    let codexCallCount = 0;

    const adapters: Record<string, { complete: ReturnType<typeof mock> }> = {
      claude: {
        complete: mock(async () => {
          claudeCallCount++;
          return {
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        }),
      },
      codex: {
        complete: mock(async () => {
          codexCallCount++;
          return {
            output: "codex success",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        }),
      },
    };

    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({
      getAgent: (name: string) => adapters[name],
    });

    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-006" },
      makeCompleteOp("ac6-immediate-swap"),
      "hello",
    );

    expect(result).toBe("codex success");
    // claude called once only (maxRetryAttempts=0 → no same-agent retries)
    expect(claudeCallCount).toBe(1);
    // codex called once after swap
    expect(codexCallCount).toBe(1);
  });
});
