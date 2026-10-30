import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSession, AnswerStatus, SessionEvent, TranscriptStore } from "@nathapp/nax-agent";
import { acpTurnMessages } from "@/chat/acp/acp-history";
import type { ChatAcpModel } from "@/chat/acp/acp-model";
import { _acpRecorderDeps, recordAcpTurns } from "@/chat/acp/acp-recorder";
import { getLogger } from "@/logger";

const ACP: ChatAcpModel = { agent: "codex", model: "gpt-5.5" };
const BACKEND: AgentSession["backend"] = { kind: "acp", capabilities: { offeredModels: ["m"] } };
const base = { sessionId: "s1", turnId: "t1", at: "2026-10-01T00:00:00.000Z", metadata: {} };

const text = (value: string): SessionEvent => ({ ...base, type: "text_delta", round: 1, text: value });
const thinking = (value: string): SessionEvent => ({ ...base, type: "thinking_delta", round: 1, text: value });
const toolCall = (): SessionEvent => ({ ...base, type: "tool_call", callId: "c1", name: "Read", input: {} });
const usage = (): SessionEvent => ({ ...base, type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
type EndStatus = "completed" | "errored" | "cancelled" | "timed_out" | "interrupted";
const turnEnd = (status: EndStatus = "completed", output = ""): SessionEvent => ({
  ...base,
  type: "turn_end",
  status,
  output,
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

function stub(scripts: readonly Script[]) {
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
  };
  return { session, send };
}

function storeOf(overrides: Partial<TranscriptStore> = {}): TranscriptStore {
  return {
    load: async () => null,
    save: async () => {},
    retainFailed: async () => {},
    delete: async () => {},
    markTurn: async () => {},
    ...overrides,
  };
}

async function drain(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

function sent(send: { mock: { calls: unknown[][] } }): unknown[] {
  return send.mock.calls.map((c) => c[0]);
}

const original = _acpRecorderDeps.appendNativeTurn;
let append: ReturnType<typeof mock<typeof original>>;
const STORE = storeOf();

function wrap(session: AgentSession, handoff?: string, store: TranscriptStore = STORE): AgentSession {
  return recordAcpTurns(session, {
    store,
    sessionId: "chat-1",
    acp: ACP,
    ...(handoff !== undefined ? { handoff } : {}),
  });
}

beforeEach(() => {
  append = mock(async () => {});
  _acpRecorderDeps.appendNativeTurn = append;
});

afterEach(() => {
  _acpRecorderDeps.appendNativeTurn = original;
});

describe("recordAcpTurns recording", () => {
  test("AC-1: an iteration without turn_end records nothing and keeps the handoff pending", async () => {
    const { session, send } = stub([{ events: [text("ok")] }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("again"));
    expect(append).not.toHaveBeenCalled();
    expect(sent(send)).toEqual(["H\n\nhi", "H\n\nagain"]);
  });

  test("AC-2: an errored turn_end with no work records nothing and keeps the handoff pending", async () => {
    const { session, send } = stub([{ events: [turnEnd("errored", "")] }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("again"));
    expect(append).not.toHaveBeenCalled();
    expect(sent(send)).toEqual(["H\n\nhi", "H\n\nagain"]);
  });

  test("AC-3: a throw before turn_end records nothing", async () => {
    const boom = new Error("boom");
    const { session } = stub([{ events: [text("partial")], throws: boom }]);
    await expect(drain(wrap(session, "H").send("hi"))).rejects.toBe(boom);
    expect(append).not.toHaveBeenCalled();
  });

  test("AC-4: a worked turn is appended once with the store, session id and the typed message's turn messages", async () => {
    const events = [text("ok"), turnEnd()];
    const { session, send } = stub([{ events }]);
    const store = storeOf();
    await drain(wrap(session, "H", store).send("hi"));
    expect(sent(send)).toEqual(["H\n\nhi"]);
    expect(append).toHaveBeenCalledTimes(1);
    const [gotStore, gotId, gotMessages] = append.mock.calls[0] ?? [];
    expect(gotStore).toBe(store);
    expect(gotId).toBe("chat-1");
    expect(gotMessages).toEqual(acpTurnMessages({ message: "hi", events, acp: ACP }));
    expect(gotMessages?.[0]).toEqual({ role: "user", content: "hi" });
  });

  test("AC-4: the handoff is cleared once the turn is recorded", async () => {
    const { session, send } = stub([{ events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("next"));
    expect(sent(send)).toEqual(["H\n\nhi", "next"]);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[2]?.[0]).toEqual({ role: "user", content: "next" });
  });

  test("AC-5: a worked turn ending errored is recorded", async () => {
    const { session } = stub([{ events: [text("partial"), turnEnd("errored")] }]);
    await drain(wrap(session).send("hi"));
    expect(append).toHaveBeenCalledTimes(1);
  });

  test("AC-6: a turn whose only work is a thinking_delta is recorded", async () => {
    const { session } = stub([{ events: [thinking("hmm"), turnEnd()] }]);
    await drain(wrap(session).send("hi"));
    expect(append).toHaveBeenCalledTimes(1);
  });

  test("a turn whose only work is a tool_call is recorded", async () => {
    const { session } = stub([{ events: [toolCall(), turnEnd()] }]);
    await drain(wrap(session).send("hi"));
    expect(append).toHaveBeenCalledTimes(1);
  });

  test("AC-7: the consumer's iteration does not finish before the append resolves", async () => {
    let release: () => void = () => {};
    append.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { session } = stub([{ events: [text("ok"), turnEnd()] }]);
    let finished = false;
    const consumed = drain(wrap(session).send("hi")).then(() => {
      finished = true;
    });
    // Every yielded event has been delivered once the append is requested; the iteration must still be open.
    while (append.mock.calls.length === 0) await Promise.resolve();
    // One macrotask turn drains every pending microtask, so a send that did not await the append would be finished.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    await consumed;
    expect(finished).toBe(true);
  });

  test("close() waits for a delayed append before resolving", async () => {
    let release: () => void = () => {};
    append.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { session } = stub([{ events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session);
    const consumed = drain(wrapper.send("hi"));
    while (append.mock.calls.length === 0) await Promise.resolve();
    let closed = false;
    const closing = wrapper.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    await consumed;
    expect(closed).toBe(true);
  });

  test("close() resolves after the wrapped close even when the append rejected", async () => {
    append.mockImplementation(async () => {
      throw new Error("save failed");
    });
    const { session } = stub([{ events: [text("ok"), turnEnd()] }]);
    const wrapper = wrap(session);
    await expect(drain(wrapper.send("hi"))).rejects.toThrow("save failed");
    await wrapper.close();
  });

  const statuses: readonly EndStatus[] = ["cancelled", "timed_out", "interrupted", "errored"];
  const cases = statuses.flatMap((status) => [
    { status, events: [text("so far"), turnEnd(status)], reply: "so far" },
    { status, events: [thinking("hmm"), turnEnd(status)], reply: `(no reply; turn ${status})` },
  ]);

  test.each(cases)(
    "AC-8: a worked turn ending $status is recorded as acpTurnMessages produces it ($reply)",
    async ({ events, reply }) => {
      const { session } = stub([{ events }]);
      await drain(wrap(session).send("hi"));
      expect(append).toHaveBeenCalledTimes(1);
      const recorded = append.mock.calls[0]?.[2];
      expect(recorded).toEqual(acpTurnMessages({ message: "hi", events, acp: ACP }));
      expect(recorded?.[1]?.content).toBe(reply);
    },
  );

  test.each([
    ["an empty text_delta", [text(""), turnEnd()]],
    ["an empty thinking_delta", [thinking(""), turnEnd()]],
    ["usage updates", [usage(), turnEnd()]],
    ["empty deltas and usage", [text(""), thinking(""), usage(), turnEnd("cancelled")]],
  ])("AC-9: a terminal turn with only %s leaves the handoff pending and is not recorded", async (_name, events) => {
    const { session, send } = stub([{ events }]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("hi"));
    await drain(wrapper.send("again"));
    expect(append).not.toHaveBeenCalled();
    expect(sent(send)).toEqual(["H\n\nhi", "H\n\nagain"]);
  });
});

describe("recordAcpTurns when the native store fails", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _acpRecorderDeps.appendNativeTurn = original;
    warn = spyOn(getLogger(), "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test.each([
    ["load", { load: async () => Promise.reject(new Error("load failed")) }],
    ["save", { save: async () => Promise.reject(new Error("save failed")) }],
  ])("AC-10: a rejecting store.%s still delivers every event unchanged and in order", async (_which, overrides) => {
    const events = [text("a"), toolCall(), text("b"), turnEnd()];
    const { session } = stub([{ events }]);
    const got = await drain(wrap(session, "H", storeOf(overrides)).send("hi"));
    expect(got).toHaveLength(events.length);
    got.forEach((e, i) => {
      expect(e).toBe(events[i]);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("chat");
    expect(warn.mock.calls[0]?.[1]).toBe("could not record the ACP turn");
  });
});
