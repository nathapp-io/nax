/**
 * S3-4: the channel behind send()'s iterator (spec 4.4). The turn pushes and
 * one consumer pulls. While the consumer lags, adjacent deltas of one type and
 * round merge. Control events are never merged; past the cap the channel
 * reports a stall once. return() is the consumer leaving.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { createSessionEventChannel, type SessionEventChannelOptions } from "#src/session/session-event-channel";

function ev(body: SessionEventBody): SessionEvent {
  return { sessionId: "s", turnId: "t", at: "2026-10-04T00:00:00.000Z", metadata: {}, ...body };
}

const text = (t: string, round = 1): SessionEvent => ev({ type: "text_delta", round, text: t });
const thinking = (t: string, round = 1): SessionEvent => ev({ type: "thinking_delta", round, text: t });
const result = (callId: string): SessionEvent => ev({ type: "tool_result", callId, isError: false, preview: "ok" });

function channel(extra: Partial<SessionEventChannelOptions> = {}) {
  const calls = { firstPull: 0, returned: 0, stalled: 0 };
  const ch = createSessionEventChannel({
    controlCap: 1000,
    onFirstPull: () => {
      calls.firstPull += 1;
    },
    onReturn: () => {
      calls.returned += 1;
    },
    onStall: () => {
      calls.stalled += 1;
    },
    ...extra,
  });
  return { ch, calls };
}

async function drain(ch: { iterator: AsyncIterator<SessionEvent> }): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const next = await ch.iterator.next();
    if (next.done === true) return out;
    out.push(next.value);
  }
}

describe("createSessionEventChannel", () => {
  test("the first next() fires onFirstPull once, before reading", async () => {
    const { ch, calls } = channel({});
    const pending = ch.iterator.next();
    expect(calls.firstPull).toBe(1);
    ch.push(result("c1"));
    expect((await pending).value).toEqual(result("c1"));
    ch.end();
    await ch.iterator.next();
    expect(calls.firstPull).toBe(1);
  });

  test("onFirstPull may push synchronously; that event is returned first", async () => {
    const box: { ch?: ReturnType<typeof createSessionEventChannel> } = {};
    const ch = createSessionEventChannel({
      controlCap: 10,
      onFirstPull: () => box.ch?.push(ev({ type: "turn_start" })),
      onReturn: () => {},
      onStall: () => {},
    });
    box.ch = ch;
    expect((await ch.iterator.next()).value).toEqual(ev({ type: "turn_start" }));
  });

  test("buffered adjacent deltas of one type and round merge; types and rounds do not", async () => {
    const { ch } = channel();
    ch.push(text("a"));
    ch.push(text("b"));
    ch.push(thinking("x"));
    ch.push(thinking("y"));
    ch.push(text("c", 2));
    ch.push(text("d", 2));
    ch.push(text("e", 3));
    ch.end();
    expect(await drain(ch)).toEqual([text("ab"), thinking("xy"), text("cd", 2), text("e", 3)]);
  });

  test("a waiting consumer receives each delta as it is pushed", async () => {
    const { ch } = channel();
    const first = ch.iterator.next();
    ch.push(text("a"));
    expect((await first).value).toEqual(text("a"));
    ch.push(text("b"));
    ch.push(text("c"));
    ch.end();
    expect(await drain(ch)).toEqual([text("bc")]);
  });

  test("control events are never merged", async () => {
    const { ch } = channel();
    ch.push(result("c1"));
    ch.push(result("c1"));
    ch.end();
    expect(await drain(ch)).toEqual([result("c1"), result("c1")]);
  });

  test("past the cap of undelivered control events, onStall fires once; deltas do not count", async () => {
    const { ch, calls } = channel({ controlCap: 2 });
    ch.push(result("a"));
    ch.push(text("t"));
    ch.push(result("b"));
    expect(calls.stalled).toBe(0);
    ch.push(result("c"));
    expect(calls.stalled).toBe(1);
    ch.push(result("d"));
    expect(calls.stalled).toBe(1);
    ch.end();
    expect(await drain(ch)).toHaveLength(5);
  });

  test("delivered control events stop counting toward the cap", async () => {
    const { ch, calls } = channel({ controlCap: 2 });
    ch.push(result("a"));
    ch.push(result("b"));
    await ch.iterator.next();
    await ch.iterator.next();
    ch.push(result("c"));
    ch.push(result("d"));
    expect(calls.stalled).toBe(0);
  });

  test("end() completes the iterator after the buffer drains, and wakes a waiting consumer", async () => {
    const { ch } = channel();
    const waiting = ch.iterator.next();
    ch.end();
    expect((await waiting).done).toBe(true);
    ch.push(result("late"));
    expect((await ch.iterator.next()).done).toBe(true);
  });

  test("return() before end() fires onReturn once and discards later pushes", async () => {
    const { ch, calls } = channel();
    ch.push(result("a"));
    expect((await ch.iterator.return?.())?.done).toBe(true);
    expect((await ch.iterator.return?.())?.done).toBe(true);
    expect(calls.returned).toBe(1);
    ch.push(result("b"));
    expect((await ch.iterator.next()).done).toBe(true);
  });

  test("return() after end() does not fire onReturn", async () => {
    const { ch, calls } = channel();
    ch.end();
    await ch.iterator.return?.();
    expect(calls.returned).toBe(0);
  });

  test("return() before the first next() fires onReturn and never fires onFirstPull", async () => {
    const { ch, calls } = channel();
    await ch.iterator.return?.();
    expect(calls.returned).toBe(1);
    expect((await ch.iterator.next()).done).toBe(true);
    expect(calls.firstPull).toBe(0);
  });

  test("a second next() while one is pending rejects with AGENT_SESSION_BUSY", async () => {
    const { ch } = channel();
    const first = ch.iterator.next();
    let caught: unknown;
    try {
      await ch.iterator.next();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("AGENT_SESSION_BUSY");
    ch.end();
    expect((await first).done).toBe(true);
  });

  test("return() wakes a waiting consumer with done", async () => {
    const { ch } = channel();
    const waiting = ch.iterator.next();
    await ch.iterator.return?.();
    expect((await waiting).done).toBe(true);
  });
});
