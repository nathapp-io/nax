import { describe, expect, mock, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined, makeAgentAdapter } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionFailureError, SessionTurnError } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

function handleFor(name: string): SessionHandle {
  return { id: name, agentName: "claude" };
}

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

const TOOL_ARGS_MESSAGE = 'Tool "Write" returned unparseable arguments.';

/** Native tool-args parse fault, as the native adapter wraps a protocol fault (bad-request). */
function toolArgsFault(): SessionTurnError {
  return new SessionTurnError(TOOL_ARGS_MESSAGE, false, false, undefined, undefined, undefined, undefined, {
    category: "quality",
    outcome: "fail-adapter-error",
    retriable: false,
    message: TOOL_ARGS_MESSAGE,
  });
}

/**
 * An adapter whose first turn blocks until its registered cancel runs, then throws what
 * `makeError` builds (default: an AbortError like native does). Records the session id of every turn.
 */
function blockingAdapter(
  makeError: () => Error = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
) {
  const turnHandles: string[] = [];
  let onActiveCall: OpenSessionOpts["onActiveCall"];
  let turns = 0;
  let started: () => void = () => {};
  const startedP = new Promise<void>((r) => {
    started = r;
  });
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts) => {
      onActiveCall = opts.onActiveCall;
      return handleFor(name);
    }),
    sendTurn: mock(async (handle: SessionHandle) => {
      turnHandles.push(handle.id);
      turns += 1;
      if (turns > 1) return TURN;
      return new Promise<TurnResult>((_resolve, reject) => {
        const register = onActiveCall;
        assertDefined(register, "onActiveCall");
        register("call-1", async () => {
          reject(makeError());
        });
        started();
      });
    }),
  });
  return { adapter, startedP, turnHandles };
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

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("SessionManager.interruptTurn: a non-abort failure after the interrupt (live-check defect 1)", () => {
  test.each([
    ["a plain Error", () => new Error(TOOL_ARGS_MESSAGE)],
    ["a native protocol fault (SessionTurnError, adapterFailure)", toolArgsFault],
  ])(
    "%s ending the interrupted turn is fail-stale 'interrupted' and the next turn runs in the SAME session",
    async (_label, makeError) => {
      const { adapter, startedP, turnHandles } = blockingAdapter(makeError);
      const sm = new SessionManager({ getAdapter: () => adapter });
      sm.configureRuntime({ watchdogControllerRegistry: new Map() });
      const handle = await sm.openSession("nax-interrupt-err", REQUEST);
      const first = sm.sendPrompt(handle, "work");
      await startedP;
      expect(await sm.interruptTurn("nax-interrupt-err")).toBe(true);
      const caught = await settle(first);
      assertCaughtInstanceOf(caught, SessionFailureError, "interrupted turn");
      expect(caught.adapterFailure.outcome).toBe("fail-stale");
      expect(caught.adapterFailure.reason).toBe("interrupted");
      expect(sm.isCancelled("nax-interrupt-err")).toBe(false);
      expect((await sm.sendPrompt(handle, "handoff")).output).toBe("ok");
      expect(turnHandles).toEqual(["nax-interrupt-err", "nax-interrupt-err"]);
    },
  );

  test("the same failure WITHOUT an interrupt is still the raw adapter error", async () => {
    let fail: (e: Error) => void = () => {};
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => handleFor(name)),
      sendTurn: mock(
        () =>
          new Promise<TurnResult>((_res, rej) => {
            fail = rej;
          }),
      ),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    const handle = await sm.openSession("nax-no-interrupt", REQUEST);
    const first = sm.sendPrompt(handle, "work");
    await Bun.sleep(0); // sendPrompt awaits the before-turn hook (nax#2500) before sendTurn starts
    fail(new Error(TOOL_ARGS_MESSAGE));
    const caught = await settle(first);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof SessionFailureError).toBe(false);
    expect(caught instanceof Error ? caught.message : "").toBe(TOOL_ARGS_MESSAGE);
  });

  test("an adapter error raised BEFORE the interrupt is not reclassified by a later interrupt", async () => {
    let fail: (e: Error) => void = () => {};
    let register: OpenSessionOpts["onActiveCall"];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        register = opts.onActiveCall;
        return handleFor(name);
      }),
      sendTurn: mock(
        () =>
          new Promise<TurnResult>((_res, rej) => {
            fail = rej;
            assertDefined(register, "onActiveCall");
            register("call-1", async () => {});
          }),
      ),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    const handle = await sm.openSession("nax-early-error", REQUEST);
    const first = sm.sendPrompt(handle, "work");
    await Bun.sleep(0); // sendPrompt awaits the before-turn hook (nax#2500) before sendTurn starts
    fail(new Error("provider 500"));
    const caught = await settle(first);
    expect(await sm.interruptTurn("nax-early-error")).toBe(false);
    expect(caught instanceof SessionFailureError).toBe(false);
    expect(caught instanceof Error ? caught.message : "").toBe("provider 500");
  });
});
