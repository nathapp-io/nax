import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, AcpSessionHandleImpl, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { NO_OP_INTERACTION_HANDLER } from "../../../../src/agents/interaction-handler";
import { SessionTurnError } from "@/agents";
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

  test("returns SessionHandle with correct id, agentName, and ACP-internal fields", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-aabbccdd-feat-story", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;

    expect(handle.id).toBe("nax-aabbccdd-feat-story");
    expect(handle.agentName).toBe("claude");
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

  test("pre-aborted signal rejects before spawning a client", async () => {
    let createClientCalls = 0;
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => {
      createClientCalls += 1;
      return client as any;
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.openSession(
        "nax-aborted",
        makeOpenSessionOpts({
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow(/aborted|shutdown in progress/i);
    expect(createClientCalls).toBe(0);
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
  });

  test("timeout: output is empty and single round-trip recorded", async () => {
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

    expect(result.output).toBe("");
    expect(result.internalRoundTrips).toBe(1);
    expect(result.timedOut).toBe(true);
  });

  test("pre-aborted signal: skips prompt and returns zero round-trips", async () => {
    let promptCalls = 0;
    const session = makeSession({
      promptFn: async () => {
        promptCalls++;
        return {
          messages: [{ role: "assistant", content: "should not run" }],
          stopReason: "end_turn",
        };
      },
    });
    const handle = await openHandle(session);
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      signal: controller.signal,
    });

    expect(result.internalRoundTrips).toBe(0);
    expect(promptCalls).toBe(0);
  });

  test("mid-turn abort: returns after abort with at least one round-trip", async () => {
    const session = makeSession({
      promptFn: () => new Promise(() => {}),
      cancelFn: async () => {},
    });
    const handle = await openHandle(session);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      signal: controller.signal,
    });

    expect(result.internalRoundTrips).toBeGreaterThanOrEqual(1);
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

  test("context-tool handler throws: sendTurn resolves and breaks loop", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: '<nax_tool_call name="get_context">\n{}\n</nax_tool_call>' }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 50, output_tokens: 20 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: {
        async onInteraction() {
          throw new Error("handler failed");
        },
      },
    });

    // Handler throw is swallowed; sendTurn resolves after breaking the loop
    expect(result.internalRoundTrips).toBe(1);
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

  test("question interaction: captures exchange (question + verbatim reply + turnIndex) in result.interactions", async () => {
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

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions?.[0]).toEqual({
      turnIndex: 1,
      question: "Should I proceed with approach A or B?",
      reply: "Use approach A.",
    });
  });

  test("context-tool interaction: produces no interactions (only human Q&A is captured)", async () => {
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

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: {
        async onInteraction() {
          return {
            answer:
              '<nax_tool_result name="get_context" status="ok">\ncontext data\n</nax_tool_result>\n\nContinue the task.',
          };
        },
      },
    });

    expect(result.interactions).toBeUndefined();
  });

  test("no-interaction single turn: interactions is undefined", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "All done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.interactions).toBeUndefined();
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
  });

  test("session-broken stopReason: throws error", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "" }],
        stopReason: "error",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 0 },
      }),
    });
    const handle = await openHandle(session);

    await expect(
      adapter.sendTurn(handle, "prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER }),
    ).rejects.toThrow("stop reason: error");
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

  test("max turns exhausted: internalRoundTrips equals maxTurns", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: '<nax_tool_call name="t">\n{}\n</nax_tool_call>' }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      maxTurns: 3,
      interactionHandler: {
        async onInteraction() {
          return { answer: "tool result" };
        },
      },
    });

    expect(result.internalRoundTrips).toBe(3);
  });

  test("exactCostUsd accumulates into cost.total", async () => {
    let turn = 0;
    const session = makeSession({
      promptFn: async () => {
        turn++;
        if (turn === 1) {
          return {
            messages: [{ role: "assistant", content: '<nax_tool_call name="t">\n{}\n</nax_tool_call>' }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
            exactCostUsd: 0.001,
          };
        }
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
          exactCostUsd: 0.002,
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

    expect(result.estimatedCostUsd).toBeCloseTo(0.003);
  });

  test("drift smoke test: exact and estimated costs are within 50% (AC-B8)", async () => {
    // Model: claude-sonnet-4-5 at $3/1M input, $15/1M output
    // 1000 input + 500 output tokens → estimated = 0.003 + 0.0075 = $0.0105
    // Wire reports exact cost of $0.012 → drift = |0.012 - 0.0105| / 0.0105 ≈ 14%
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn" as const,
        cumulative_token_usage: { input_tokens: 1000, output_tokens: 500 },
        exactCostUsd: 0.012,
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.exactCostUsd).toBeDefined();
    const drift = Math.abs(result.exactCostUsd! - result.estimatedCostUsd) / result.estimatedCostUsd;
    expect(drift).toBeLessThan(0.5);
  });

  test("re-establishes session and retries once on NO_SESSION (exitCode 4)", async () => {
    let sessionCreateCount = 0;
    let promptCallCount = 0;

    const deadPromptFn = async () => {
      promptCallCount++;
      return { messages: [{ role: "assistant", content: "NO_SESSION" }], stopReason: "error", exitCode: 4 };
    };
    const livePromptFn = async () => {
      promptCallCount++;
      return { messages: [{ role: "assistant", content: "Fixed output" }], stopReason: "end_turn" };
    };

    let isFirstSession = true;
    const createSessionFn = async (_opts: any) => {
      sessionCreateCount++;
      const fn = isFirstSession ? deadPromptFn : livePromptFn;
      isFirstSession = false;
      return makeSession({ promptFn: fn });
    };
    const loadSessionFn = async (_name: string, _agent: string, _perm: string) => {
      sessionCreateCount++;
      const fn = isFirstSession ? deadPromptFn : livePromptFn;
      isFirstSession = false;
      return makeSession({ promptFn: fn });
    };

    const handle = await openHandle(makeSession({ promptFn: deadPromptFn }), { createSessionFn, loadSessionFn });

    const result = await adapter.sendTurn(handle, "do the work", {
      interactionHandler: { onInteraction: async () => null },
    });

    expect(result.output).toBe("Fixed output");
    expect(promptCallCount).toBe(2);
  });

  test("throws on error when NO_SESSION occurs twice (no infinite retry)", async () => {
    const alwaysDeadPromptFn = async () => ({
      messages: [{ role: "assistant", content: "NO_SESSION" }],
      stopReason: "error",
      exitCode: 4,
    });

    const handle = await openHandle(makeSession({ promptFn: alwaysDeadPromptFn }), {
      createSessionFn: async () => makeSession({ promptFn: alwaysDeadPromptFn }),
      loadSessionFn: async () => makeSession({ promptFn: alwaysDeadPromptFn }),
    });

    await expect(
      adapter.sendTurn(handle, "do the work", {
        interactionHandler: { onInteraction: async () => null },
      }),
    ).rejects.toThrow();
  });

  // BUG-57: a turn that ends with stopReason:"error" (e.g. cancelled) must not
  // drop tokens already burned on that same turn — SessionTurnError now
  // carries the accumulated tokenUsage/estimatedCostUsd/exactCostUsd so
  // downstream catch sites (build-hop-callback.ts, session-run-hop.ts) can
  // record real spend instead of hardcoding zero.
  test("SessionTurnError carries accumulated token usage/cost from the failed turn (BUG-57)", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [],
        stopReason: "error",
        cancelled: true,
        cumulative_token_usage: { input_tokens: 300, output_tokens: 150 },
      }),
    });
    const handle = await openHandle(session);

    let caught: unknown;
    try {
      await adapter.sendTurn(handle, "prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(SessionTurnError);
    const turnError = caught as InstanceType<typeof SessionTurnError>;
    expect(turnError.cancelled).toBe(true);
    expect(turnError.tokenUsage?.inputTokens).toBe(300);
    expect(turnError.tokenUsage?.outputTokens).toBe(150);
    expect(turnError.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("SessionTurnError carries zero usage when no tokens were ever reported (not a regression)", async () => {
    const session = makeSession({
      promptFn: async () => ({ messages: [], stopReason: "error" }),
    });
    const handle = await openHandle(session);

    let caught: unknown;
    try {
      await adapter.sendTurn(handle, "prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SessionTurnError);
    const turnError = caught as InstanceType<typeof SessionTurnError>;
    expect(turnError.tokenUsage?.inputTokens).toBe(0);
    expect(turnError.estimatedCostUsd).toBe(0);
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

  test("calls session.close() and client.close(); swallows client errors; session error does not prevent client.close()", async () => {
    // Scenario 1: both close calls execute
    const closedSessions: string[] = [];
    const closedClients: string[] = [];
    const session1 = makeSession({ closeFn: async () => { closedSessions.push("session"); } });
    const client1 = { ...makeClient(session1), close: async () => { closedClients.push("client"); } };
    _acpAdapterDeps.createClient = mock(() => client1 as any);
    const handle1 = await adapter.openSession("nax-close-test", makeOpenSessionOpts());
    await adapter.closeSession(handle1);
    expect(closedSessions).toEqual(["session"]);
    expect(closedClients).toEqual(["client"]);

    // Scenario 2: client.close() throws → resolves anyway (best-effort)
    const session2 = makeSession();
    const client2 = { ...makeClient(session2), close: async () => { throw new Error("client close failed"); } };
    _acpAdapterDeps.createClient = mock(() => client2 as any);
    const handle2 = await adapter.openSession("nax-close-err", makeOpenSessionOpts());
    await expect(adapter.closeSession(handle2)).resolves.toBeUndefined();

    // Scenario 3: session.close() throws → client.close() still runs
    const closedClients3: string[] = [];
    const session3 = makeSession({ closeFn: async () => { throw new Error("session close failed"); } });
    const client3 = { ...makeClient(session3), close: async () => { closedClients3.push("client"); } };
    _acpAdapterDeps.createClient = mock(() => client3 as any);
    const handle3 = await adapter.openSession("nax-close-session-err", makeOpenSessionOpts());
    await expect(adapter.closeSession(handle3)).resolves.toBeUndefined();
    expect(closedClients3).toEqual(["client"]);
  });
});
