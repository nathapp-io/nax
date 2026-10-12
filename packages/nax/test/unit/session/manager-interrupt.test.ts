import { describe, expect, mock, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined, makeAgentAdapter } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionFailureError } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const TURN: TurnResult = {
  output: "ok",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};
const REQUEST: OpenSessionRequest = {
  agentName: "claude",
  workdir: "/tmp/nax-interrupt-test",
  pipelineStage: "run",
  modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
  timeoutSeconds: 30,
};

/** An adapter whose first turn blocks until its registered cancel runs, then throws an AbortError like native does. */
function blockingAdapter() {
  let onActiveCall: OpenSessionOpts["onActiveCall"];
  let turns = 0;
  let started: () => void = () => {};
  const startedP = new Promise<void>((r) => {
    started = r;
  });
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts) => {
      onActiveCall = opts.onActiveCall;
      return { id: name, agentName: "claude" } as SessionHandle;
    }),
    sendTurn: mock(async () => {
      turns += 1;
      if (turns > 1) return TURN;
      return new Promise<TurnResult>((_resolve, reject) => {
        const register = onActiveCall;
        assertDefined(register, "onActiveCall");
        register("call-1", async () => {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
        started();
      });
    }),
  });
  return { adapter, startedP };
}

describe("SessionManager.interruptTurn (finish A)", () => {
  test("ends the running turn as fail-stale 'interrupted' and keeps the session usable", async () => {
    const { adapter, startedP } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    const handle = await sm.openSession("nax-interrupt", REQUEST);
    const first = sm.sendPrompt(handle, "work");
    await startedP;
    expect(await sm.interruptTurn("nax-interrupt")).toBe(true);
    let caught: unknown;
    try {
      await first;
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, SessionFailureError, "interrupted turn");
    expect(caught.adapterFailure.outcome).toBe("fail-stale");
    expect(caught.adapterFailure.reason).toBe("interrupted");
    expect(sm.isCancelled("nax-interrupt")).toBe(false);
    expect((await sm.sendPrompt(handle, "handoff")).output).toBe("ok");
  });

  test("returns false when the session has no active call", async () => {
    const { adapter } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    await sm.openSession("nax-idle", REQUEST);
    expect(await sm.interruptTurn("nax-idle")).toBe(false);
  });

  test("returns false without a watchdog registry", async () => {
    const { adapter } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    await sm.openSession("nax-noreg", REQUEST);
    expect(await sm.interruptTurn("nax-noreg")).toBe(false);
  });
});
