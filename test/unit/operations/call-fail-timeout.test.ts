import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// End-to-end test: a timed-out turn flows through sendWithFileOutput and
// surfaces an AdapterFailure with outcome "fail-timeout" to the manager.
describe("callOp end-to-end — turn with timedOut=true is classified fail-timeout", () => {
  const testSel = pickSelector("timeout-test", "routing");

  function makeRunOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You do the thing.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => output.trim(),
    };
  }

  const createdRuntimes: NaxRuntime[] = [];
  let origReadFileOutput: typeof _callOpDeps.readFileOutput;

  beforeEach(() => {
    origReadFileOutput = _callOpDeps.readFileOutput;
  });
  afterEach(async () => {
    _callOpDeps.readFileOutput = origReadFileOutput;
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  test("timed-out turn produces fail-timeout (quality, retriable) — manager sees it", async () => {
    let capturedAdapterFailure: { outcome?: string; category?: string; retriable?: boolean } | undefined;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: typeof capturedAdapterFailure })
          .adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        // Simulate a wall-clock timeout: empty output + timedOut transport flag.
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        timedOut: true,
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("timeout-op"),
        "hello",
      );
    } catch (err) {
      thrown = err as { code?: string };
    }

    // Surface the synthesised failure: empty + timedOut → fail-timeout
    expect(capturedAdapterFailure).toBeDefined();
    expect(capturedAdapterFailure?.outcome).toBe("fail-timeout");
    expect(capturedAdapterFailure?.category).toBe("quality");
    expect(capturedAdapterFailure?.retriable).toBe(true);
    // No output → CALL_OP_NO_OUTPUT path
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("untimed empty turn still synthesises fail-stale (preserves legacy behavior)", async () => {
    let capturedAdapterFailure: { outcome?: string; category?: string; reason?: string } | undefined;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: typeof capturedAdapterFailure })
          .adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        // No timedOut flag — empty output without timeout stays fail-stale.
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("empty-op"),
        "hello",
      );
    } catch {
      // expected: CALL_OP_NO_OUTPUT
    }

    expect(capturedAdapterFailure?.outcome).toBe("fail-stale");
    expect(capturedAdapterFailure?.category).toBe("availability");
    expect(capturedAdapterFailure?.reason).toBe("empty-output");
  });
});
