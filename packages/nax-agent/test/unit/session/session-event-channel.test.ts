/**
 * S3-4: the channel behind send()'s iterator (spec 4.4). The turn pushes and
 * one consumer pulls. While the consumer lags, adjacent deltas of one type and
 * round merge. Control events are never merged; past the cap the channel
 * reports a stall once. return() is the consumer leaving.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import {
  createSessionEventChannel,
  inspectSessionEventChannel,
  type SessionEventChannel,
  type SessionEventChannelOptions,
  type SessionEventChannelStorage,
} from "#src/session/session-event-channel";

function ev(body: SessionEventBody): SessionEvent {
  return { sessionId: "s", turnId: "t", at: "2026-10-04T00:00:00.000Z", metadata: {}, ...body };
}

const text = (t: string, round = 1): SessionEvent => ev({ type: "text_delta", round, text: t });
const thinking = (t: string, round = 1): SessionEvent => ev({ type: "thinking_delta", round, text: t });
const input = (callId: string, chars: number, round = 1): SessionEvent =>
  ev({ type: "tool_input_delta", round, callId, name: "Write", chars });
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

/** The delivered tool_input_delta events as `[callId, chars]`, in delivery order. */
function toolInputPairs(events: readonly SessionEvent[]): [string, number][] {
  const pairs: [string, number][] = [];
  for (const event of events) {
    if (event.type === "tool_input_delta") pairs.push([event.callId, event.chars]);
  }
  return pairs;
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

  test("tool_input_delta events with the same round and callId merge, summing chars", async () => {
    const { ch } = channel();
    ch.push(input("c1", 5));
    ch.push(input("c1", 7));
    ch.end();
    expect(await drain(ch)).toEqual([input("c1", 12)]);
  });

  test("tool_input_delta events with different callId stay separate", async () => {
    const { ch } = channel();
    ch.push(input("c1", 5));
    ch.push(input("c2", 7));
    ch.end();
    expect(await drain(ch)).toEqual([input("c1", 5), input("c2", 7)]);
  });

  test("a tool_input_delta then a text_delta stay two ordered events", async () => {
    const { ch } = channel();
    ch.push(input("c1", 5));
    ch.push(text("a"));
    ch.end();
    expect(await drain(ch)).toEqual([input("c1", 5), text("a")]);
  });

  test("10,000 tool_input_delta events for one call do not stall the channel", async () => {
    const { ch, calls } = channel({ controlCap: 2 });
    for (let i = 0; i < 10_000; i += 1) ch.push(input("c1", 1));
    ch.end();
    expect(calls.stalled).toBe(0);
    expect(await drain(ch)).toEqual([input("c1", 10_000)]);
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

/**
 * US-001: the channel releases a delivered reference as it is delivered and
 * reclaims consumed slots, so its backing storage stays proportional to the
 * recent backlog instead of to everything ever delivered. These cases read the
 * real storage — retained references, used span and slots actually relocated —
 * through the channel's package-private inspection, never `length - head`.
 */

/**
 * The span slack the implementation states for a bounded backlog: a reclaim
 * pass runs as soon as the consumed prefix reaches the pending suffix, so the
 * span stays below twice the pending backlog. Over this fixture's fixed
 * two-event backlog that allows one spare slot; two is asserted so a boundary
 * tweak in the rule does not fail the case for no reason.
 */
const STATED_SPAN_SLACK = 2;

/** AC-8's budget: draining N buffered events may relocate at most 4N pending slots. */
const RELOCATION_BUDGET_FACTOR = 4;

interface SustainedBacklogResult {
  readonly ch: SessionEventChannel;
  /** Every event pushed, in push order. */
  readonly pushed: SessionEvent[];
  /** Every event pulled, in delivery order. */
  readonly delivered: SessionEvent[];
  /** The storage as it stood after the final pull. */
  readonly storage: SessionEventChannelStorage;
}

/**
 * US-001's sustained-backlog fixture: two events pending to start, then every
 * iteration pushes the next alternating delta before pulling one, so the
 * channel never drains. Alternating text/thinking deltas cannot merge, so
 * delivery order is push order and each pushed event is identifiable.
 */
async function sustainedBacklog(options: {
  readonly iterations: number;
  readonly onPush?: (event: SessionEvent, index: number) => void;
  readonly onPull?: (storage: SessionEventChannelStorage, pulled: number) => void;
}): Promise<SustainedBacklogResult> {
  const { ch } = channel();
  const pushed: SessionEvent[] = [];
  const delivered: SessionEvent[] = [];
  const push = (event: SessionEvent): void => {
    options.onPush?.(event, pushed.length);
    pushed.push(event);
    ch.push(event);
  };
  // Seed two pending: one FIFO slot and the mergeable tail.
  push(text("seed-0"));
  push(thinking("seed-1"));
  for (let i = 0; i < options.iterations; i += 1) {
    push(i % 2 === 0 ? text(`t${i}`) : thinking(`k${i}`));
    const pulled = await ch.iterator.next();
    if (pulled.done !== true) delivered.push(pulled.value);
    options.onPull?.(inspectSessionEventChannel(ch), delivered.length);
  }
  return { ch, pushed, delivered, storage: inspectSessionEventChannel(ch) };
}

describe("createSessionEventChannel storage reclamation (US-001)", () => {
  test("AC-1: after every pull the storage references only the two undelivered events", async () => {
    const pushIndex = new Map<SessionEvent, number>();
    let checked = 0;
    const run = await sustainedBacklog({
      iterations: 10_000,
      onPush: (event, index) => pushIndex.set(event, index),
      onPull: (storage, pulled) => {
        // The FIFO holds one undelivered event and the tail the other.
        expect(storage.referenced).toHaveLength(2);
        expect(storage.pending).toHaveLength(2);
        expect(storage.referenced).toEqual(storage.pending);
        for (const event of storage.referenced) {
          // Only undelivered pushes may still be referenced: a delivered one
          // would have an index below the number already pulled.
          expect(pushIndex.get(event) ?? -1).toBeGreaterThanOrEqual(pulled);
        }
        checked += 1;
      },
    });
    expect(checked).toBe(10_000);
    // Both undelivered events survive to the drain, in push order.
    expect(run.storage.pending).toEqual([run.pushed[run.pushed.length - 2], run.pushed[run.pushed.length - 1]]);
    expect(run.delivered).toHaveLength(10_000);
  });

  test("AC-2: the span stays within the backlog plus the stated slack across reclamation cycles", async () => {
    const iterations = 10_000;
    let maxSpan = 0;
    let maxSlack = 0;
    let startSpan = 0;
    let endSpan = 0;
    let passes = 0;
    let relocated = 0;
    await sustainedBacklog({
      iterations,
      onPull: (storage, pulled) => {
        maxSpan = Math.max(maxSpan, storage.span);
        maxSlack = Math.max(maxSlack, storage.span - storage.pending.length);
        if (pulled <= 200) startSpan = Math.max(startSpan, storage.span);
        if (pulled > iterations - 200) endSpan = Math.max(endSpan, storage.span);
        if (storage.relocatedSlots !== relocated) {
          passes += 1;
          relocated = storage.relocatedSlots;
        }
      },
    });
    // Consumed slots are gone: the span is the backlog plus a fixed allowance,
    // not the 10,002 slots a clear-the-reference-only fix leaves behind.
    expect(maxSlack).toBeLessThanOrEqual(STATED_SPAN_SLACK);
    expect(maxSpan).toBeLessThanOrEqual(2 + STATED_SPAN_SLACK);
    // Many reclamation cycles ran, not one lucky reset at the end.
    expect(passes).toBeGreaterThan(100);
    // It does not grow with the number delivered.
    expect(endSpan).toBe(startSpan);
  });

  test("AC-3: end() then a full drain returns the whole sustained sequence in order", async () => {
    const run = await sustainedBacklog({ iterations: 10_000 });
    run.ch.end();
    const rest = await drain(run.ch);
    expect(run.delivered.length + rest.length).toBe(run.pushed.length);
    expect([...run.delivered, ...rest]).toEqual(run.pushed);
    // The drain spanned reclamation passes, so order is preserved across them.
    expect(run.storage.relocatedSlots).toBeGreaterThan(0);
  });

  test("AC-4: same-round same-call tool_input_delta events still merge across reclamation", async () => {
    const { ch } = channel();
    // Controls fill the FIFO and never merge, so they drive the reclamation.
    for (let i = 0; i < 20; i += 1) ch.push(result(`c${i}`));
    ch.push(input("c1", 5));
    // The 10th pull takes the consumed prefix level with the pending suffix, so
    // a reclaim pass runs while the tool delta is still the tail.
    for (let i = 0; i < 11; i += 1) await ch.iterator.next();
    expect(inspectSessionEventChannel(ch).relocatedSlots).toBeGreaterThan(0);
    ch.push(input("c1", 7));
    ch.push(input("c1", 3));
    ch.end();
    const sent = await drain(ch);
    expect(toolInputPairs(sent)).toEqual([["c1", 15]]);
  });

  test("AC-5: different callId tool_input_delta events stay distinct across reclamation", async () => {
    const { ch } = channel();
    for (let i = 0; i < 20; i += 1) ch.push(result(`c${i}`));
    ch.push(input("c1", 5));
    for (let i = 0; i < 11; i += 1) await ch.iterator.next();
    expect(inspectSessionEventChannel(ch).relocatedSlots).toBeGreaterThan(0);
    ch.push(input("c2", 7));
    ch.push(input("c3", 2));
    ch.end();
    const sent = await drain(ch);
    expect(toolInputPairs(sent)).toEqual([
      ["c1", 5],
      ["c2", 7],
      ["c3", 2],
    ]);
  });

  test("AC-6: controls delivered across reclamation no longer count toward controlCap", async () => {
    const { ch, calls } = channel({ controlCap: 30 });
    for (let i = 0; i < 20; i += 1) ch.push(result(`a${i}`));
    expect(calls.stalled).toBe(0);
    // The pulls cross a reclaim pass at the 10th; those 11 must stop counting.
    for (let i = 0; i < 11; i += 1) await ch.iterator.next();
    expect(inspectSessionEventChannel(ch).relocatedSlots).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) ch.push(result(`b${i}`));
    expect(calls.stalled).toBe(0);
    ch.push(result("b20"));
    expect(calls.stalled).toBe(0);
    ch.push(result("b21"));
    expect(calls.stalled).toBe(1);
  });

  test("AC-7: onStall still fires only once when undelivered controls exceed the cap across reclamation", async () => {
    const { ch, calls } = channel({ controlCap: 5 });
    for (let i = 0; i < 20; i += 1) ch.push(result(`a${i}`));
    expect(calls.stalled).toBe(1);
    for (let i = 0; i < 11; i += 1) await ch.iterator.next();
    expect(inspectSessionEventChannel(ch).relocatedSlots).toBeGreaterThan(0);
    // 9 undelivered + 20 more: past the cap again, but the stall already fired.
    for (let i = 0; i < 20; i += 1) ch.push(result(`b${i}`));
    expect(calls.stalled).toBe(1);
  });

  test("AC-8: draining 8,192 buffered deltas relocates at most a small constant times N", async () => {
    const total = 8_192;
    const { ch } = channel();
    const pushed: SessionEvent[] = [];
    for (let i = 0; i < total; i += 1) {
      const event = i % 2 === 0 ? text(`t${i}`) : thinking(`k${i}`);
      pushed.push(event);
      ch.push(event);
    }
    ch.end();
    const drained = await drain(ch);
    expect(drained).toEqual(pushed);
    const { relocatedSlots } = inspectSessionEventChannel(ch);
    // Reclamation ran, so this is not a vacuous zero: shifting the whole
    // pending queue on every pull would relocate ~N²/2 slots and blow the cap.
    expect(relocatedSlots).toBeGreaterThan(0);
    expect(relocatedSlots).toBeLessThanOrEqual(RELOCATION_BUDGET_FACTOR * total);
  });

  test("inspectSessionEventChannel rejects a channel it did not create", () => {
    const foreign: SessionEventChannel = {
      push: () => {},
      end: () => {},
      iterator: { next: async () => ({ done: true, value: undefined }) },
    };
    let caught: unknown;
    try {
      inspectSessionEventChannel(foreign);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("AGENT_SESSION_INVALID_INPUT");
  });
});
