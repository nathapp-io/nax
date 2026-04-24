import { describe, test, expect } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { CompleteOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeTestRuntime, makeMockAgentManager } from "../../helpers";
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
