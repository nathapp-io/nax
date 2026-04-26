import { describe, test, expect, mock } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { CompleteOperation, RunOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeTestRuntime, makeMockAgentManager, makeSessionManager } from "../../helpers";
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

describe("callOp — kind:run", () => {
  test("calls sessionManager.runInSession (phase-B form) with session name and ctx.agentName", async () => {
    const runInSessionMock = mock(async () => ({
      output: "ran pinned",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }));
    // Object.assign mutates the base mock and overrides runInSession without
    // hitting the overloaded-type incompatibility at the Partial<ISessionManager> boundary.
    const sessionManager = Object.assign(makeSessionManager(), { runInSession: runInSessionMock });
    const agentManager = makeMockAgentManager();
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

    expect(runInSessionMock).toHaveBeenCalledTimes(1);
    expect(runInSessionMock).toHaveBeenCalledWith(
      "nax-00000000",
      expect.any(String),
      expect.objectContaining({ agentName: "opencode" }),
    );
    expect(result).toBe("ran pinned");
  });

  test("throws CALL_OP_NO_OUTPUT when session returns no output", async () => {
    // Default makeSessionManager() stub returns output: "" — the empty string
    // triggers callOp's no-output guard.
    const sessionManager = makeSessionManager();
    const agentManager = makeMockAgentManager();
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
