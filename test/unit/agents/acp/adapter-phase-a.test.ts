import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, AcpSessionHandleImpl, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { NO_OP_INTERACTION_HANDLER } from "../../../../src/agents/interaction-handler";
import type { OpenSessionOpts } from "../../../../src/agents/types";
import { makeClient, makeSession } from "./adapter.test";

const ACP_WORKDIR = "/tmp/nax-phase-a-test";

function makeOpenSessionOpts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: ACP_WORKDIR,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// openSession
// ─────────────────────────────────────────────────────────────────────────────

describe("openSession()", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    adapter = new AcpAgentAdapter("claude");
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("returns a SessionHandle with id = session name", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-aabbccdd-feat-story", makeOpenSessionOpts());

    expect(handle.id).toBe("nax-aabbccdd-feat-story");
    expect(handle.agentName).toBe("claude");
  });

  test("handle is AcpSessionHandleImpl with ACP-internal fields", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-test", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;

    expect(impl._session).toBe(session);
    expect(impl._timeoutSeconds).toBe(30);
    expect(impl._modelDef.model).toBe("claude-sonnet-4-5");
  });

  test("fires onSessionEstablished callback before returning", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const calls: Array<{ protocolIds: unknown; sessionName: string }> = [];
    const opts = makeOpenSessionOpts({
      onSessionEstablished: (protocolIds, sessionName) => {
        calls.push({ protocolIds, sessionName });
      },
    });

    await adapter.openSession("nax-test-session", opts);

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionName).toBe("nax-test-session");
  });

  test("tolerates onSessionEstablished throwing without failing openSession", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const opts = makeOpenSessionOpts({
      onSessionEstablished: () => {
        throw new Error("callback error");
      },
    });

    const handle = await adapter.openSession("nax-test", opts);
    expect(handle.id).toBe("nax-test");
  });

  test("marks handle resumed=false for a new session", async () => {
    const session = makeSession();
    const client = makeClient(session, { loadSessionFn: undefined });
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-test", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;
    expect(impl._resumed).toBe(false);
  });

  test("marks handle resumed=true when loadSession returns an existing session", async () => {
    const session = makeSession();
    const client = makeClient(session, {
      loadSessionFn: async () => session,
    });
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-existing", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;
    expect(impl._resumed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendTurn
// ─────────────────────────────────────────────────────────────────────────────

describe("sendTurn()", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    adapter = new AcpAgentAdapter("claude");
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  async function openHandle(session = makeSession(), clientOverrides = {}) {
    const client = makeClient(session, clientOverrides);
    _acpAdapterDeps.createClient = mock(() => client as any);
    return adapter.openSession("nax-sendturn-test", makeOpenSessionOpts());
  }

  test("single-turn success: returns output and token usage", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "All done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 200, output_tokens: 80 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "Do the thing.", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.output).toBe("All done.");
    expect(result.tokenUsage.inputTokens).toBe(200);
    expect(result.tokenUsage.outputTokens).toBe(80);
    expect(result.internalRoundTrips).toBe(1);
    expect(result._lastStopReason).toBe("end_turn");
    expect(result._timedOut).toBeFalsy();
  });

  test("timeout: sets _timedOut=true and output is empty", async () => {
    const session = makeSession({
      promptFn: () => new Promise(() => {}),
      cancelFn: async () => {},
    });
    const handle = await openHandle(session);
    const impl = handle as AcpSessionHandleImpl;
    (impl as any)._timeoutSeconds = 0.001; // 1ms

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result._timedOut).toBe(true);
    expect(result.output).toBe("");
    expect(result.internalRoundTrips).toBe(1);
  });

  test("context-tool interaction: calls handler and continues with answer", async () => {
    let turnIndex = 0;
    const session = makeSession({
      promptFn: async () => {
        turnIndex++;
        if (turnIndex === 1) {
          return {
            messages: [{ role: "assistant", content: '<nax_tool_call name="get_context">\n{}\n</nax_tool_call>' }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 50, output_tokens: 20 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "Used context, done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    });
    const handle = await openHandle(session);

    const interactionCalls: unknown[] = [];
    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: {
        async onInteraction(req) {
          interactionCalls.push(req);
          return {
            answer:
              '<nax_tool_result name="get_context" status="ok">\ncontext data\n</nax_tool_result>\n\nContinue the task.',
          };
        },
      },
    });

    expect(interactionCalls).toHaveLength(1);
    expect((interactionCalls[0] as any).kind).toBe("context-tool");
    expect((interactionCalls[0] as any).name).toBe("get_context");
    expect(result.output).toBe("Used context, done.");
    expect(result.internalRoundTrips).toBe(2);
  });

  test("question interaction: calls handler and continues with answer", async () => {
    let turnIndex = 0;
    const session = makeSession({
      promptFn: async () => {
        turnIndex++;
        if (turnIndex === 1) {
          return {
            messages: [{ role: "assistant", content: "Should I proceed with approach A or B?" }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 60, output_tokens: 25 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "OK, using approach A." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 80, output_tokens: 15 },
        };
      },
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: {
        async onInteraction(req) {
          if (req.kind === "question") return { answer: "Use approach A." };
          return null;
        },
      },
    });

    expect(result.output).toBe("OK, using approach A.");
    expect(result.internalRoundTrips).toBe(2);
  });

  test("NO_OP_INTERACTION_HANDLER breaks loop on question", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "Should I proceed?" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 50, output_tokens: 10 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.internalRoundTrips).toBe(1);
    expect(result._lastStopReason).toBe("end_turn");
  });

  test("session-broken stopReason sets _lastStopReason=error", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "" }],
        stopReason: "error",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 0 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result._lastStopReason).toBe("error");
  });

  test("accumulates token usage across multiple turns", async () => {
    let turn = 0;
    const session = makeSession({
      promptFn: async () => {
        turn++;
        if (turn === 1) {
          return {
            messages: [{ role: "assistant", content: '<nax_tool_call name="t">\n{}\n</nax_tool_call>' }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 40 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 150, output_tokens: 60 },
        };
      },
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: {
        async onInteraction() {
          return { answer: "tool result" };
        },
      },
    });

    expect(result.tokenUsage.inputTokens).toBe(250);
    expect(result.tokenUsage.outputTokens).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closeSession(handle)
// ─────────────────────────────────────────────────────────────────────────────

describe("closeSession(handle)", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    adapter = new AcpAgentAdapter("claude");
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("calls session.close() and client.close()", async () => {
    const closedSessions: string[] = [];
    const closedClients: string[] = [];

    const session = makeSession({ closeFn: async () => { closedSessions.push("session"); } });
    const client = {
      ...makeClient(session),
      close: async () => { closedClients.push("client"); },
    };
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-close-test", makeOpenSessionOpts());
    await adapter.closeSession(handle);

    expect(closedSessions).toEqual(["session"]);
    expect(closedClients).toEqual(["client"]);
  });

  test("swallows client.close() errors (best-effort)", async () => {
    const session = makeSession();
    const client = {
      ...makeClient(session),
      close: async () => { throw new Error("client close failed"); },
    };
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-close-err", makeOpenSessionOpts());

    await expect(adapter.closeSession(handle)).resolves.toBeUndefined();
  });
});
