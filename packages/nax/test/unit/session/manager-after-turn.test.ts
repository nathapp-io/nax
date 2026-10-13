import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const MOCK_TURN: TurnResult = {
  output: "hello world",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

const OPEN_REQUEST: OpenSessionRequest = {
  agentName: "claude",
  workdir: "/tmp/nax-after-turn-test",
  pipelineStage: "run",
  modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
  timeoutSeconds: 30,
};

describe("sendPrompt() afterTurn hook (#2497)", () => {
  test("afterTurn runs after a turn that throws; the turn's error reaches the caller", async () => {
    const turns: number[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      sendTurn: mock(async () => {
        throw new Error("turn failed");
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({
      afterTurn: async (_d, turn) => {
        turns.push(turn);
        throw new Error("repair failed");
      },
    });
    const handle = await sm.openSession("nax-after-turn-err", OPEN_REQUEST);
    await expect(sm.sendPrompt(handle, "go")).rejects.toThrow("turn failed");
    expect(turns).toEqual([1]);
  });

  test("afterTurn runs after a successful turn and the result is returned", async () => {
    const turns: number[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      sendTurn: mock(async () => MOCK_TURN),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({
      afterTurn: async (_d, turn) => {
        turns.push(turn);
      },
    });
    const handle = await sm.openSession("nax-after-turn-ok", OPEN_REQUEST);
    const result = await sm.sendPrompt(handle, "go");
    expect(result.output).toBe("hello world");
    expect(turns).toEqual([1]);
  });
});
