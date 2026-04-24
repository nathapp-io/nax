import { describe, test, expect, mock } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { CompleteOperation, RunOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeAgentAdapter, makeTestRuntime, makeMockAgentManager } from "../../helpers";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { AgentResult, CompleteResult } from "../../../src/agents/types";

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
  test("pins the session run to ctx.agentName via agentManager.runAs", async () => {
    const runResult: AgentResult = {
      success: true,
      exitCode: 0,
      output: "ran pinned",
      rateLimited: false,
      durationMs: 1,
      estimatedCost: 0,
    };
    const agentManager = makeMockAgentManager({ runAsFn: async () => runResult });
    const runtime = makeTestRuntime({ agentManager });

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

    expect(agentManager.runAs).toHaveBeenCalledTimes(1);
    expect(agentManager.runAs).toHaveBeenCalledWith("opencode", expect.any(Object));
    expect(result).toBe("ran pinned");
  });

  test("noFallback runs the requested adapter directly instead of agentManager.runAs", async () => {
    const adapterRun = mock(async () => ({
      success: true,
      exitCode: 0,
      output: "direct adapter",
      rateLimited: false,
      durationMs: 1,
      estimatedCost: 0,
    }));
    const adapter = makeAgentAdapter({ name: "opencode", run: adapterRun });
    const agentManager = makeMockAgentManager({ getAgentFn: (name) => (name === "opencode" ? adapter : undefined) });
    const runtime = makeTestRuntime({ agentManager });

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "opencode",
        storyId: "US-001",
      },
      { ...runEchoOp, noFallback: true },
      { text: "hello world" },
    );

    expect(agentManager.runAs).not.toHaveBeenCalled();
    expect(adapterRun).toHaveBeenCalledTimes(1);
    expect(result).toBe("direct adapter");
  });
});
