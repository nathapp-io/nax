import { describe, test, expect, mock } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { CompleteOperation, RunOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "../../helpers";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { CompleteResult } from "../../../src/agents/types";

const testSel = pickSelector("routing-op-test", "routing");

const echoOp: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "complete",
  name: "echo-test",
  stage: "run",
  config: testSel,
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-test",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

describe("callOp — kind:complete", () => {
  test("calls agentManager.completeAs with composed prompt", async () => {
    const completeResult: CompleteResult = { output: "echoed", costUsd: 0, source: "exact" };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    const runtime = makeTestRuntime({ agentManager });

    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
    };

    const result = await callOp(ctx, echoOp, { text: "hello world" });

    expect(agentManager.completeAs).toHaveBeenCalledTimes(1);
    expect(result).toBe("echoed");
  });
});

describe("callOp — kind:run (ADR-019 §5)", () => {
  test("dispatches via agentManager.runWithFallback with executeHop callback", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: true, exitCode: 0, output: "ran via fallback", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "opencode",
        storyId: "US-001",
      },
      runEchoOp,
      { text: "hello world" },
    );

    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { executeHop?: unknown; runOptions: { storyId?: string } };
    expect(reqArg.executeHop).toBeTypeOf("function");
    expect(reqArg.runOptions.storyId).toBe("US-001");
    expect(result).toBe("ran via fallback");
  });

  test("noFallback ops still dispatch via real runWithFallback with noFallback:true flag", async () => {
    // Post-C1 fix: noFallback no longer routes through wrapAdapterAsManager.
    // It calls the real agentManager.runWithFallback with `noFallback: true`,
    // which short-circuits the swap branch (manager.ts) but preserves the
    // middleware envelope. This test pins the dispatch path.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => ({
        result: { success: true, exitCode: 0, output: "single-agent output", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] },
        fallbacks: [],
        // Surface req fields for assertion via the mock's call records below.
        ...({ _req: req } as Record<string, unknown>),
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const noFallbackOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      noFallback: true,
    };

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      noFallbackOp,
      { text: "hello" },
    );

    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { noFallback?: boolean };
    expect(reqArg.noFallback).toBe(true);
    expect(result).toBe("single-agent output");
  });

  test("throws CALL_OP_NO_OUTPUT when run returns no output", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    let thrown: Error | null = null;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "opencode",
          storyId: "US-001",
        },
        runEchoOp,
        { text: "hello world" },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("agent returned no output");
  });
});
