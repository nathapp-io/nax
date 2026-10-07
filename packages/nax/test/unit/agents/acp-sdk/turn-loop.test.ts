// test/unit/agents/acp-sdk/turn-loop.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AdapterInteraction,
  AgentSessionError,
  type AgentStreamEvent,
  createMemoryTranscriptStore,
  type InteractionHandler,
  NaxError,
  type OpenedBackend,
  type OpenSessionOpts,
  type SendTurnOpts,
  SessionTurnError,
} from "@nathapp/nax-agent";
import { waitForCondition } from "@test/helpers";
import { failTurn, hangTurn, replyTurn, type ScriptedTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import { _acpSdkDeps, type AcpSdkSession } from "@/agents/acp-sdk/session";
import { runTurnLoop } from "@/agents/acp-sdk/turn-loop";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
});

interface Built {
  readonly session: AcpSdkSession;
  readonly events: AgentStreamEvent[];
  readonly cancels: Array<() => Promise<void>>;
}

function build(opened: OpenedBackend, overrides: Partial<OpenSessionOpts> = {}): Built {
  const events: AgentStreamEvent[] = [];
  const cancels: Array<() => Promise<void>> = [];
  const slot = createTurnSlot();
  const opts: OpenSessionOpts = {
    agentName: "claude",
    workdir: "/repo",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    onActiveCall: (_callId, cancel) => {
      cancels.push(cancel);
    },
    ...overrides,
  };
  const session: AcpSdkSession = {
    name: "nax-loop",
    agent: "claude",
    opts,
    handle: { id: "nax-loop", agentName: "claude" },
    store: createMemoryTranscriptStore(),
    slot,
    asks: createAskPort(slot),
    closer: new AbortController(),
    rateCard: { rates: FALLBACK_RATES, source: "fallback-rates" },
    stream: {
      emit: (e) => {
        events.push(e);
      },
      agentName: "claude",
      sessionName: "nax-loop",
      runId: "r",
      storyId: undefined,
      model: "sonnet",
      timeoutSeconds: 60,
      pid: () => undefined,
    },
    process: { pid: undefined },
    opened,
    running: undefined,
    unlinkRun: () => {},
  };
  return { session, events, cancels };
}

function answering(...answers: string[]): InteractionHandler & { readonly asked: AdapterInteraction[] } {
  const asked: AdapterInteraction[] = [];
  return {
    asked,
    onInteraction: async (interaction) => {
      asked.push(interaction);
      const answer = answers.shift();
      return answer === undefined ? null : { answer };
    },
  };
}

const NONE = answering();

describe("runTurnLoop: success paths (spec §6.2)", () => {
  test("one prompt: output, tokens, reported cost, card-priced estimate", async () => {
    const script = scriptedOpened([replyTurn("done")]);
    const { session, events } = build(script.opened);
    const result = await runTurnLoop(session, "do it", { interactionHandler: NONE });
    expect(result).toMatchObject({
      output: "done",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      exactCostUsd: 0.01,
      internalRoundTrips: 1,
      timedOut: false,
      pricingSource: "fallback-rates",
    });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(script.prompts).toEqual(["do it"]);
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.call_ended"]);
    expect(events[1]).toMatchObject({ status: "success" });
  });

  test("the backend gets the slot's signal, a turn id and the bridge sink", async () => {
    const script = scriptedOpened([replyTurn("ok")]);
    const { session } = build(script.opened);
    await runTurnLoop(session, "p", { interactionHandler: NONE, turnId: "turn-9" });
    expect(script.sent[0]).toMatchObject({ turnId: "turn-9" });
    expect(script.sent[0]?.signal).toBeDefined();
    expect(script.sent[0]?.onTurnEvent).toBeDefined();
    expect(session.slot.current()).toBeUndefined();
  });

  test("a <nax_tool_call> is answered through the handler and sent back; spend sums", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="query_rag">{"q":"x"}</nax_tool_call>'),
      replyTurn("final"),
    ]);
    const handler = answering("<nax_tool_result>found</nax_tool_result>");
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "start", { interactionHandler: handler });
    expect(handler.asked).toEqual([{ kind: "context-tool", name: "query_rag", input: { q: "x" } }]);
    expect(script.prompts).toEqual(["start", "<nax_tool_result>found</nax_tool_result>"]);
    expect(result).toMatchObject({ output: "final", internalRoundTrips: 2, tokenUsage: { inputTokens: 20 } });
    expect(result.exactCostUsd).toBeCloseTo(0.02);
  });

  test("a trailing question is answered and recorded in interactions", async () => {
    const script = scriptedOpened([
      replyTurn("I made a plan.\n\nShould I proceed with the refactor?"),
      replyTurn("ok"),
    ]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", { interactionHandler: answering("yes") });
    expect(result.interactions).toEqual([
      { turnIndex: 1, question: "I made a plan.\n\nShould I proceed with the refactor?", reply: "yes" },
    ]);
    expect(script.prompts[1]).toBe("yes");
  });

  test("no reply ends the loop with the question as output", async () => {
    const script = scriptedOpened([replyTurn("Should I proceed with the refactor?")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "Should I proceed with the refactor?", internalRoundTrips: 1 });
  });

  test("the shared budget bounds the loop", async () => {
    const script = scriptedOpened([replyTurn("Should I proceed with the refactor?")]);
    const { session } = build(script.opened);
    const result = await runTurnLoop(session, "go", {
      interactionHandler: answering("a", "b", "c", "d"),
      maxInteractions: 2,
    });
    expect(script.prompts).toHaveLength(2);
    expect(result.internalRoundTrips).toBe(2);
  });
});

describe("runTurnLoop: deadline, cancel and abort (spec §6.2, §7.1)", () => {
  test("the deadline returns timedOut with empty output and the spend so far", async () => {
    const script = scriptedOpened([hangTurn({ inputTokens: 7, outputTokens: 1, costUsd: 0.003 })]);
    const { session } = build(script.opened, { timeoutSeconds: 0.05 });
    const result = await runTurnLoop(session, "slow", { interactionHandler: NONE });
    expect(result).toMatchObject({ timedOut: true, output: "", tokenUsage: { inputTokens: 7 } });
    expect(result.exactCostUsd).toBeCloseTo(0.003);
  });

  test("the watchdog's cancel throws fail-stale, cancelled, retryable, with spend", async () => {
    const script = scriptedOpened([hangTurn()]);
    const built = build(script.opened);
    const pending = runTurnLoop(built.session, "p", { interactionHandler: NONE });
    await waitForCondition(() => built.cancels.length > 0);
    await built.cancels[0]?.();
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err).toMatchObject({ cancelled: true, retryable: true, tokenUsage: { inputTokens: 10 } });
    expect(err.adapterFailure?.outcome).toBe("fail-stale");
    expect(built.events.at(-1)).toMatchObject({ kind: "agent.call_ended", status: "error" });
  });

  test("a run abort mid-prompt throws fail-aborted, not retryable (D2-c)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const run = new AbortController();
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal });
    await waitForCondition(() => script.prompts.length === 1);
    run.abort("shutdown");
    await expect(pending).rejects.toMatchObject({ cancelled: true, retryable: false });
  });

  test("the session closing mid-prompt aborts the prompt (Review Focus 1)", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened);
    const pending = runTurnLoop(session, "p", { interactionHandler: NONE });
    await waitForCondition(() => script.prompts.length === 1);
    session.closer.abort();
    const err = await pending.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
  });

  test("an already-aborted run signal sends nothing", async () => {
    const script = scriptedOpened([replyTurn("never")]);
    const { session } = build(script.opened);
    await expect(
      runTurnLoop(session, "p", { interactionHandler: NONE, signal: AbortSignal.abort("gone") }),
    ).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual([]);
  });
});

describe("runTurnLoop: failures", () => {
  test("AGENT_SESSION_NOT_FOUND re-opens fresh once and resends; the dead attempt is not counted", async () => {
    const first = scriptedOpened([failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"))]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "recovered", internalRoundTrips: 1 });
    expect(first.closeCount()).toBe(1);
    expect(second.prompts).toEqual(["p"]);
    expect(session.opened).toBe(second.opened);
    expect(result.tokenUsage.inputTokens).toBe(20);
  });

  test("a second NOT_FOUND is not recovered again", async () => {
    const notFound = () => failTurn(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"));
    const first = scriptedOpened([notFound()]);
    const second = scriptedOpened([notFound()]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
  });

  test("a prompt-time not-found (TURN_FAILED, rpcCode -32002) re-opens fresh once (D3-f, acpx exit code 4)", async () => {
    const gone = new NaxError("The ACP prompt failed: Resource not found", "AGENT_SESSION_TURN_FAILED", {
      stage: "acp",
      rpcCode: -32002,
    });
    const first = scriptedOpened([failTurn(gone)]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened);
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "recovered", internalRoundTrips: 1 });
    expect(second.prompts).toEqual(["p"]);
  });

  test("any other failure throws SessionTurnError with the summed spend (fail-unknown for a plain Error, D3-e)", async () => {
    const script = scriptedOpened([
      replyTurn('<nax_tool_call name="t">{}</nax_tool_call>'),
      failTurn(new Error("agent exploded")),
    ]);
    const { session } = build(script.opened);
    const err = await runTurnLoop(session, "p", { interactionHandler: answering("r") }).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err).toMatchObject({ cancelled: false, retryable: false, message: "agent exploded" });
    expect(err.tokenUsage?.inputTokens).toBe(20);
    expect(err.adapterFailure?.outcome).toBe("fail-unknown");
  });

  test("a second concurrent turn on the session is refused", async () => {
    const script = scriptedOpened([hangTurn()]);
    const { session } = build(script.opened, { timeoutSeconds: 0.2 });
    const first = runTurnLoop(session, "a", { interactionHandler: NONE });
    await expect(runTurnLoop(session, "b", { interactionHandler: NONE })).rejects.toMatchObject({
      code: "ACP_SDK_TURN_IN_FLIGHT",
    });
    await first;
  });
});

describe("runTurnLoop: promptRetries (spec §7.2, T1-1)", () => {
  const transient = () =>
    new NaxError("The ACP prompt failed: internal", "AGENT_SESSION_TURN_FAILED", { stage: "acp", rpcCode: -32603 });

  function recordDelays(): number[] {
    const waits: number[] = [];
    _acpSdkDeps.delay = async (ms) => {
      waits.push(ms);
    };
    return waits;
  }

  /** Emits one turn event through the bridge sink, then fails like failTurn. */
  function eventThenFail(event: Parameters<NonNullable<SendTurnOpts["onTurnEvent"]>>[0], err: Error): ScriptedTurn {
    return async (prompt, opts) => {
      opts.onTurnEvent?.(event);
      return failTurn(err)(prompt, opts);
    };
  }

  test("a transient failure before any event is resent on the same call, up to promptRetries", async () => {
    const waits = recordDelays();
    const script = scriptedOpened([failTurn(transient()), failTurn(transient()), replyTurn("ok")]);
    const { session, events } = build(script.opened, { promptRetries: 2 });
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result).toMatchObject({ output: "ok", internalRoundTrips: 1 });
    expect(script.prompts).toEqual(["p", "p", "p"]);
    expect(waits).toEqual([1_000, 2_000]);
    expect(result.tokenUsage.inputTokens).toBe(30);
    expect(events.filter((e) => e.kind === "agent.call_started")).toHaveLength(1);
  });

  test("promptRetries 0 (the default) never resends", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(transient()), replyTurn("never")]);
    const { session } = build(script.opened);
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual(["p"]);
  });

  test("retries run out: the last failure is thrown with every attempt's spend", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(transient())]);
    const { session } = build(script.opened, { promptRetries: 1 });
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE }).catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) throw err;
    expect(script.prompts).toHaveLength(2);
    expect(err.tokenUsage?.inputTokens).toBe(20);
    expect(err.adapterFailure?.outcome).toBe("fail-adapter-error");
  });

  test("a thinking-only attempt is not retried (Review Focus 1)", async () => {
    recordDelays();
    const script = scriptedOpened([
      eventThenFail({ type: "thinking_delta", text: "hm", round: 1 }, transient()),
      replyTurn("x"),
    ]);
    const { session } = build(script.opened, { promptRetries: 3 });
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toBeInstanceOf(SessionTurnError);
    expect(script.prompts).toEqual(["p"]);
  });

  test("a non-retryable code is not retried", async () => {
    recordDelays();
    const script = scriptedOpened([failTurn(new NaxError("t", "ACP_STOP_MAX_TOKENS")), replyTurn("x")]);
    const { session } = build(script.opened, { promptRetries: 3 });
    await expect(runTurnLoop(session, "p", { interactionHandler: NONE })).rejects.toMatchObject({
      adapterFailure: { outcome: "fail-incomplete" },
    });
    expect(script.prompts).toEqual(["p"]);
  });

  test("an abort during the backoff ends the turn, no resend (Review Focus 2)", async () => {
    const run = new AbortController();
    _acpSdkDeps.delay = (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        run.abort("shutdown");
      });
    const script = scriptedOpened([failTurn(transient()), replyTurn("never")]);
    const { session } = build(script.opened, { promptRetries: 3 });
    const err = await runTurnLoop(session, "p", { interactionHandler: NONE, signal: run.signal }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof SessionTurnError)) throw err;
    expect(err.adapterFailure?.outcome).toBe("fail-aborted");
    expect(script.prompts).toEqual(["p"]);
  });

  test("a session-gone -32603 is recovered, not retried (Review Focus 5)", async () => {
    const waits = recordDelays();
    const gone = new NaxError("Session not found", "AGENT_SESSION_TURN_FAILED", { stage: "acp", rpcCode: -32603 });
    const first = scriptedOpened([failTurn(gone)]);
    const second = scriptedOpened([replyTurn("recovered")]);
    _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => second.opened });
    const { session } = build(first.opened, { promptRetries: 3 });
    const result = await runTurnLoop(session, "p", { interactionHandler: NONE });
    expect(result.output).toBe("recovered");
    expect(first.prompts).toEqual(["p"]);
    expect(waits).toEqual([]);
  });
});
