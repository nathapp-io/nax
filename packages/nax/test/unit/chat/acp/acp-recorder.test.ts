import { describe, expect, mock, test } from "bun:test";
import type {
  AgentSession,
  AnswerReply,
  AnswerStatus,
  CommandRunResult,
  SessionEvent,
  TranscriptStore,
} from "@nathapp/nax-agent";
import { recordAcpTurns } from "@/chat/acp/acp-recorder";

const STORE: TranscriptStore = {
  load: async () => null,
  save: async () => {},
  retainFailed: async () => {},
  delete: async () => {},
  markTurn: async () => {},
};
const BACKEND: AgentSession["backend"] = { kind: "acp", capabilities: { offeredModels: ["m"] } };
const base = { sessionId: "s1", turnId: "t1", at: "2026-10-01T00:00:00.000Z", metadata: {} };

const text = (value: string): SessionEvent => ({ ...base, type: "text_delta", round: 1, text: value });
const thinking = (value: string): SessionEvent => ({ ...base, type: "thinking_delta", round: 1, text: value });
const toolCall = (): SessionEvent => ({ ...base, type: "tool_call", callId: "c1", name: "Read", input: {} });
const usage = (): SessionEvent => ({
  ...base,
  type: "usage",
  round: 1,
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
});
const turnStart: SessionEvent = { ...base, type: "turn_start" };
const turnEnd = (status: "completed" | "errored" = "completed"): SessionEvent => ({
  ...base,
  type: "turn_end",
  status,
  output: "",
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
});

async function* yielding(events: readonly SessionEvent[], failure?: Error): AsyncGenerator<SessionEvent> {
  for (const e of events) yield e;
  if (failure) throw failure;
}

interface Script {
  readonly events: readonly SessionEvent[];
  readonly throws?: Error;
}

function stub(scripts: readonly Script[], extra: Partial<AgentSession> = {}) {
  let call = 0;
  const send = mock((_message: string): AsyncIterable<SessionEvent> => {
    const script = scripts[Math.min(call, scripts.length - 1)] ?? { events: [] };
    call += 1;
    return yielding(script.events, script.throws);
  });
  const session: AgentSession = {
    id: "wrapped-id",
    backend: BACKEND,
    lastTurn: undefined,
    send,
    answer: (): AnswerStatus => "accepted",
    cancel: () => {},
    close: async () => {},
    ...extra,
  };
  return { session, send };
}

async function drain(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

function wrap(session: AgentSession, handoff?: string): AgentSession {
  return recordAcpTurns(session, {
    store: STORE,
    sessionId: "chat-1",
    acp: { agent: "codex", model: "gpt-5.5" },
    ...(handoff !== undefined ? { handoff } : {}),
  });
}

function sent(send: { mock: { calls: unknown[][] } }): unknown[] {
  return send.mock.calls.map((c) => c[0]);
}

describe("recordAcpTurns forwarding", () => {
  test("AC-1: id equals the wrapped session's id", () => {
    expect(wrap(stub([{ events: [] }]).session).id).toBe("wrapped-id");
  });

  test("AC-2: backend equals the wrapped session's backend", () => {
    expect(wrap(stub([{ events: [] }]).session).backend).toBe(BACKEND);
  });

  test("AC-3: lastTurn is read again from the wrapped session on each access", () => {
    let current: AgentSession["lastTurn"];
    const { session } = stub([{ events: [] }]);
    const live: AgentSession = {
      ...session,
      get lastTurn() {
        return current;
      },
    };
    const wrapper = wrap(live);
    expect(wrapper.lastTurn).toBeUndefined();
    current = { turnId: "t9", status: "completed" };
    expect(wrapper.lastTurn).toEqual({ turnId: "t9", status: "completed" });
    current = { turnId: "t10", status: "cancelled" };
    expect(wrapper.lastTurn).toEqual({ turnId: "t10", status: "cancelled" });
  });

  test("AC-4: answer forwards its arguments and returns the wrapped result", () => {
    const answer = mock((_id: string, _reply: AnswerReply): AnswerStatus => "expired");
    const wrapper = wrap(stub([{ events: [] }], { answer }).session);
    expect(wrapper.answer("r1", { decision: "allow" })).toBe("expired");
    expect(answer).toHaveBeenCalledWith("r1", { decision: "allow" });
  });

  test("AC-5: cancel forwards its reason", () => {
    const cancel = mock((_reason?: string) => {});
    wrap(stub([{ events: [] }], { cancel }).session).cancel("why");
    expect(cancel).toHaveBeenCalledWith("why");
  });

  test("AC-6: close calls the wrapped close and resolves when it does", async () => {
    let release: () => void = () => {};
    const close = mock(() => new Promise<void>((resolve) => (release = resolve)));
    const pending = wrap(stub([{ events: [] }], { close }).session).close();
    let settled = false;
    const tracked = pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release();
    await tracked;
    expect(settled).toBe(true);
  });

  test("AC-7: runCommand forwards its arguments and returns the wrapped result, bound to the session", async () => {
    const result: CommandRunResult = { content: "out", isError: false };
    const onEvent = () => {};
    const seen: unknown[] = [];
    const inner: AgentSession = {
      ...stub([{ events: [] }]).session,
      runCommand(command, cb) {
        seen.push(this, command, cb);
        return Promise.resolve(result);
      },
    };
    expect(await wrap(inner).runCommand?.("ls", onEvent)).toBe(result);
    expect(seen).toEqual([inner, "ls", onEvent]);
  });

  test("AC-8: runCommand is undefined when the wrapped session has none", () => {
    expect(wrap(stub([{ events: [] }]).session).runCommand).toBeUndefined();
  });

  test("AC-9: send yields every wrapped event unchanged and in order", async () => {
    const events = [turnStart, text("a"), thinking("b"), toolCall(), usage(), turnEnd()];
    const got = await drain(wrap(stub([{ events }]).session).send("hi"));
    expect(got).toHaveLength(events.length);
    got.forEach((e, i) => {
      expect(e).toBe(events[i]);
    });
  });
});

describe("recordAcpTurns handoff", () => {
  test("AC-10: the first send is prefixed with the handoff", async () => {
    const { session, send } = stub([{ events: [text("ok"), turnEnd()] }]);
    await drain(wrap(session, "H").send("hi"));
    expect(sent(send)).toEqual(["H\n\nhi"]);
  });

  test("AC-11: after a worked turn_end the handoff is cleared", async () => {
    const { session, send } = stub([{ events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("next"));
    expect(sent(send)).toEqual(["H\n\nhi", "next"]);
  });

  test.each([
    ["thinking_delta", thinking("hmm")],
    ["tool_call", toolCall()],
  ])("a %s counts as agent work and clears the handoff", async (_name, work) => {
    const { session, send } = stub([{ events: [work, turnEnd()] }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("next"));
    expect(sent(send)).toEqual(["H\n\nhi", "next"]);
  });

  test.each([
    ["no work before an errored turn_end", [turnEnd("errored")]],
    ["only an empty text_delta", [text(""), turnEnd()]],
    ["only an empty thinking_delta", [thinking(""), turnEnd()]],
    ["only usage", [usage(), turnEnd()]],
    ["work but no turn_end", [text("ok")]],
  ])("a turn with %s keeps the handoff pending", async (_name, events) => {
    const { session, send } = stub([{ events }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("again"));
    expect(sent(send)).toEqual(["H\n\nhi", "H\n\nagain"]);
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
  ])("AC-12: with a handoff %s the message is sent as typed", async (_name, handoff) => {
    const { session, send } = stub([{ events: [text("ok"), turnEnd()] }]);
    await drain(wrap(session, handoff).send("hi"));
    expect(sent(send)).toEqual(["hi"]);
  });

  test("AC-13: a throw before turn_end reaches the caller and keeps the handoff pending", async () => {
    const boom = new Error("boom");
    const { session, send } = stub([{ events: [text("partial")], throws: boom }, { events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session, "H");
    await expect(drain(wrapper.send("hi"))).rejects.toBe(boom);
    await drain(wrapper.send("again"));
    expect(sent(send)).toEqual(["H\n\nhi", "H\n\nagain"]);
  });

  test("AC-14: two unconsumed sends call the wrapped send twice, synchronously", () => {
    const { session, send } = stub([{ events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session, "H");
    wrapper.send("one");
    expect(send).toHaveBeenCalledTimes(1);
    wrapper.send("two");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("AC-15: a busy error from the wrapped send is thrown by the wrapper's send call", () => {
    const busy = new Error("busy");
    const send = mock((_m: string): AsyncIterable<SessionEvent> => {
      if (send.mock.calls.length > 1) throw busy;
      return yielding([]);
    });
    const wrapper = wrap(stub([{ events: [] }], { send }).session);
    wrapper.send("one");
    expect(() => wrapper.send("two")).toThrow(busy);
  });

  test("the wrapped send is called with the wrapped session as receiver", () => {
    const receivers: unknown[] = [];
    const inner: AgentSession = {
      ...stub([{ events: [] }]).session,
      send(_message) {
        receivers.push(this);
        return yielding([]);
      },
    };
    wrap(inner).send("hi");
    expect(receivers).toEqual([inner]);
  });
});
