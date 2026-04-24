import { describe, test, expect, mock } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { CompleteOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeTestRuntime } from "../../helpers/runtime";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { IAgentManager } from "../../../src/agents/manager-types";
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
    const mockCompleteAs = mock(async () => completeResult);

    const runtime = makeTestRuntime({
      agentManager: {
        completeAs: mockCompleteAs,
        runAs: mock(async () => ({ success: true, output: "", durationMs: 0, exitCode: 0, protocolIds: { recordId: "", sessionId: "" } })),
        run: mock(async () => ({ success: true, output: "", durationMs: 0, exitCode: 0, protocolIds: { recordId: "", sessionId: "" } })),
        runWithFallback: mock(async () => ({ primary: { success: true, output: "", durationMs: 0, exitCode: 0, protocolIds: { recordId: "", sessionId: "" } }, fallbacks: [] })),
        completeWithFallback: mock(async () => ({ result: completeResult, fallbacks: [] })),
        complete: mock(async () => completeResult),
        getDefault: () => "claude",
        getAgent: () => undefined,
        isUnavailable: () => false,
        markUnavailable: () => {},
        reset: () => {},
        validateCredentials: async () => {},
        planAs: mock(async () => ({ specContent: "" })),
        decomposeAs: mock(async () => ({ stories: [] })),
      } as unknown as IAgentManager,
    });

    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
    };

    const result = await callOp(ctx, echoOp, { text: "hello world" });

    expect(mockCompleteAs).toHaveBeenCalledTimes(1);
    expect(result).toBe("echoed");
  });
});
