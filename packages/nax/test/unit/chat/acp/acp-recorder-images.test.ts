/**
 * Images through the ACP recorder.
 *
 * `recordAcpTurns` wraps a session's `send`, so an image the chat screen attached
 * must survive the wrapper: the wrapped send receives the images as its second
 * argument, the recorded native turn keeps them on the user message, and the
 * wrapper answers the capability question the chat screen asks before it sends.
 * A text-only send stays single-argument, because an ACP backend distinguishes
 * "no input" from "an input with no images".
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentSession,
  AnswerStatus,
  ImageAttachment,
  SendInput,
  SessionEvent,
  TranscriptStore,
} from "@nathapp/nax-agent";
import type { ChatAcpModel } from "@/chat/acp/acp-model";
import { _acpRecorderDeps, recordAcpTurns } from "@/chat/acp/acp-recorder";

const ACP: ChatAcpModel = { agent: "codex", model: "gpt-5.5" };
const BACKEND: AgentSession["backend"] = { kind: "acp", capabilities: { offeredModels: ["m"] } };
const base = { sessionId: "s1", turnId: "t1", at: "2026-10-01T00:00:00.000Z", metadata: {} };

const text = (value: string): SessionEvent => ({ ...base, type: "text_delta", round: 1, text: value });
const TURN_END: SessionEvent = {
  ...base,
  type: "turn_end",
  status: "completed",
  output: "",
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
};

const IMAGE: ImageAttachment = {
  mimeType: "image/png",
  data: "AAAA",
  width: 1280,
  height: 720,
  source: "clipboard",
};

const STORE: TranscriptStore = {
  load: async () => null,
  save: async () => {},
  retainFailed: async () => {},
  delete: async () => {},
  markTurn: async () => {},
};

async function* yielding(events: readonly SessionEvent[]): AsyncGenerator<SessionEvent> {
  for (const event of events) yield event;
}

function stub(events: readonly SessionEvent[] = [], extra: Partial<AgentSession> = {}) {
  const send = mock((_message: string, _input?: SendInput): AsyncIterable<SessionEvent> => yielding(events));
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
  for await (const event of iterable) out.push(event);
  return out;
}

function wrap(session: AgentSession, handoff?: string): AgentSession {
  return recordAcpTurns(session, {
    store: STORE,
    sessionId: "chat-1",
    acp: ACP,
    ...(handoff !== undefined ? { handoff } : {}),
  });
}

describe("recordAcpTurns send input", () => {
  test("AC-1: send calls the wrapped send with the message and an input carrying that same images array", () => {
    const images = [IMAGE];
    const { session, send } = stub();
    wrap(session).send("look", { images });
    expect(send.mock.calls).toHaveLength(1);
    const [message, input] = send.mock.calls[0] ?? [];
    expect(message).toBe("look");
    expect(input?.images).toBe(images);
  });

  test("AC-2: with a pending handoff the wrapped send gets the prefixed text and the images", () => {
    const images = [IMAGE];
    const { session, send } = stub();
    wrap(session, "H").send("look", { images });
    const [message, input] = send.mock.calls[0] ?? [];
    expect(message).toBe("H\n\nlook");
    expect(input?.images).toBe(images);
  });

  test("AC-3: send without images calls the wrapped send with one argument", () => {
    const { session, send } = stub();
    wrap(session).send("look");
    expect(send.mock.calls[0]).toEqual(["look"]);
    expect(send.mock.calls[0]).toHaveLength(1);
  });

  test.each([
    ["an empty images array", { images: [] }],
    ["an input with no images", {}],
  ])("%s is not forwarded as a second argument", (_label, input) => {
    const { session, send } = stub();
    wrap(session).send("look", input);
    expect(send.mock.calls[0]).toHaveLength(1);
  });

  test("AC-14: a synchronous throw from the wrapped send propagates as the same error", () => {
    const boom = new Error("boom");
    const send = mock((_message: string, _input?: SendInput): AsyncIterable<SessionEvent> => {
      throw boom;
    });
    const wrapper = wrap({ ...stub().session, send });
    let caught: unknown;
    try {
      wrapper.send("look", { images: [IMAGE] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });
});

describe("recordAcpTurns acceptsImages", () => {
  test.each([true, false])("AC-6: acceptsImages resolves %p as the wrapped session's does", async (answer) => {
    const wrapper = wrap(stub([], { acceptsImages: async () => answer }).session);
    expect(await wrapper.acceptsImages?.()).toBe(answer);
  });

  test("acceptsImages runs with the wrapped session as its receiver", async () => {
    const receivers: unknown[] = [];
    const inner: AgentSession = {
      ...stub().session,
      acceptsImages() {
        receivers.push(this);
        return Promise.resolve(true);
      },
    };
    await wrap(inner).acceptsImages?.();
    expect(receivers).toEqual([inner]);
  });

  test("AC-7: acceptsImages is undefined when the wrapped session has none", () => {
    expect(stub().session.acceptsImages).toBeUndefined();
    expect(wrap(stub().session).acceptsImages).toBeUndefined();
  });
});

describe("recordAcpTurns recording images", () => {
  const original = _acpRecorderDeps.appendNativeTurn;
  let append: ReturnType<typeof mock<typeof original>>;

  beforeEach(() => {
    append = mock(async () => {});
    _acpRecorderDeps.appendNativeTurn = append;
  });

  afterEach(() => {
    _acpRecorderDeps.appendNativeTurn = original;
  });

  test("AC-4: a turn sent with images records a user message carrying them", async () => {
    const images = [IMAGE];
    const { session } = stub([text("ok"), TURN_END]);
    await drain(wrap(session).send("look", { images }));
    expect(append).toHaveBeenCalledTimes(1);
    const recorded = append.mock.calls[0]?.[2];
    expect(recorded?.[0]).toEqual({ role: "user", content: "look", images });
  });

  test("a handoff-prefixed turn still records the message as typed, with its images", async () => {
    const images = [IMAGE];
    const { session, send } = stub([text("ok"), TURN_END]);
    const wrapper = wrap(session, "H");
    await drain(wrapper.send("look", { images }));
    expect(send.mock.calls[0]?.[0]).toBe("H\n\nlook");
    expect(append.mock.calls[0]?.[2]?.[0]).toEqual({ role: "user", content: "look", images });
  });

  test("AC-5: a turn sent without images records a user message with no images key", async () => {
    const { session } = stub([text("ok"), TURN_END]);
    await drain(wrap(session).send("look"));
    const recorded = append.mock.calls[0]?.[2];
    expect(recorded?.[0]?.role).toBe("user");
    expect(recorded?.[0]?.content).toBe("look");
    expect(Object.hasOwn(recorded?.[0] ?? {}, "images")).toBe(false);
  });

  test("a turn sent with an empty images array records no images key", async () => {
    const { session } = stub([text("ok"), TURN_END]);
    await drain(wrap(session).send("look", { images: [] }));
    expect(Object.hasOwn(append.mock.calls[0]?.[2]?.[0] ?? {}, "images")).toBe(false);
  });
});
