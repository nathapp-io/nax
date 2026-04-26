import { describe, expect, mock, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "../../../src/agents";
import type { SendTurnOpts, SessionHandle, TurnResult } from "../../../src/agents/types";
import { SessionManager } from "../../../src/session/manager";
import type { OpenSessionRequest, RunInSessionOpts } from "../../../src/session/types";
import { makeAgentAdapter } from "../../helpers/mock-agent-adapter";

const WORKDIR = "/tmp/nax-phase-b-test";

const MOCK_TURN: TurnResult = {
  output: "hello world",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  internalRoundTrips: 1,
};

function makeOpenRequest(overrides: Partial<OpenSessionRequest> = {}): OpenSessionRequest {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeRunOpts(overrides: Partial<RunInSessionOpts> = {}): RunInSessionOpts {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─── sendPrompt() ─────────────────────────────────────────────────────────────

describe("sendPrompt()", () => {
  test("delegates to adapter.sendTurn and returns result", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-send-test", makeOpenRequest());

    const result = await sm.sendPrompt(handle, "write a function");
    expect(result.output).toBe("hello world");
  });

  test("forwards NO_OP_INTERACTION_HANDLER when opts omitted", async () => {
    let capturedHandler: unknown;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedHandler = opts.interactionHandler;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-handler-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test");
    expect(capturedHandler).toBe(NO_OP_INTERACTION_HANDLER);
  });

  test("throws SESSION_BUSY on concurrent sendPrompt for same handle", async () => {
    let resolveFirst!: () => void;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-busy-test", makeOpenRequest());

    const first = sm.sendPrompt(handle, "first");
    await expect(sm.sendPrompt(handle, "second")).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    resolveFirst();
    await first;
  });

  test("throws SESSION_CANCELLED after signal abort during turn", async () => {
    const controller = new AbortController();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-cancel-test", makeOpenRequest());

    await expect(sm.sendPrompt(handle, "cancelled", { signal: controller.signal })).rejects.toThrow();
    await expect(sm.sendPrompt(handle, "after cancel")).rejects.toMatchObject({
      code: "SESSION_CANCELLED",
    });
  });

  test("throws ADAPTER_NOT_FOUND when sendPrompt called without adapter", async () => {
    const sm = new SessionManager();
    const fakeHandle: SessionHandle = { id: "nax-noadapter", agentName: "claude" };
    await expect(sm.sendPrompt(fakeHandle, "test")).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
  });

  test("forwards maxTurns to adapter.sendTurn", async () => {
    let capturedMaxTurns: number | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedMaxTurns = opts.maxTurns;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-maxturn-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test", { maxTurns: 5 });
    expect(capturedMaxTurns).toBe(5);
  });
});

// ─── runInSession() — prompt form ─────────────────────────────────────────────

describe("runInSession() — prompt form", () => {
  test("opens, sends prompt, and closes session (try/finally)", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession("nax-prompt-form", "write a test", makeRunOpts());
    expect(result.output).toBe("hello world");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when sendPrompt throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        throw new Error("turn failed");
      }),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(sm.runInSession("nax-throw-form", "bad prompt", makeRunOpts())).rejects.toThrow("turn failed");
    expect(closeCalled).toBe(true);
  });
});

// ─── runInSession() — callback form ───────────────────────────────────────────

describe("runInSession() — callback form", () => {
  test("opens, runs callback with live handle, closes session (try/finally)", async () => {
    let closeCalled = false;
    let capturedHandle: SessionHandle | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession(
      "nax-callback-form",
      async (handle) => {
        capturedHandle = handle;
        return 42;
      },
      makeRunOpts(),
    );

    expect(result).toBe(42);
    expect(capturedHandle?.id).toBe("nax-callback-form");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when callback throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(
      sm.runInSession(
        "nax-callback-throw",
        async () => {
          throw new Error("callback failed");
        },
        makeRunOpts(),
      ),
    ).rejects.toThrow("callback failed");
    expect(closeCalled).toBe(true);
  });
});
