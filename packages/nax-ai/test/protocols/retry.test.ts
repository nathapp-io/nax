import { describe, expect, it } from "vitest";
import { retryTransportFaults } from "../../src/protocols/retry.ts";
import type { ProtocolEvent } from "../../src/protocols/types.ts";

async function* emit(...events: ProtocolEvent[]): AsyncIterable<ProtocolEvent> {
  for (const event of events) yield event;
}

/** An attempt that throws before yielding anything, without an unreachable
 * `yield` (biome flags a generator with none). */
function throwingStream(cause: unknown): AsyncIterable<ProtocolEvent> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(cause) };
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 1 };

const DONE: ProtocolEvent = { type: "done", stopReason: "stop" };
const TEXT: ProtocolEvent = { type: "text-delta", text: "hi" };
const USAGE: ProtocolEvent = { type: "usage", usage };

function transportError(message = "boom"): ProtocolEvent {
  return { type: "error", error: { kind: "transport", message } };
}

function errorOf(kind: "rate-limit" | "auth" | "bad-request" | "overloaded", message = "boom"): ProtocolEvent {
  return { type: "error", error: { kind, message } };
}

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function noopSleep() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

describe("retryTransportFaults", () => {
  it("retries when an attempt throws, and succeeds on a later attempt", async () => {
    let calls = 0;
    const { sleep, calls: delays } = noopSleep();
    const events = await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          if (calls === 1) {
            return throwingStream(new Error("connection reset"));
          }
          return emit(TEXT, USAGE, DONE);
        },
        { retries: 2, sleep },
      ),
    );
    expect(calls).toBe(2);
    expect(events).toEqual([TEXT, USAGE, DONE]);
    expect(delays).toEqual([250]);
  });

  it("retries when an attempt yields a transport error event", async () => {
    let calls = 0;
    const { sleep } = noopSleep();
    const events = await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          return calls === 1 ? emit(transportError()) : emit(TEXT, DONE);
        },
        { retries: 2, sleep },
      ),
    );
    expect(calls).toBe(2);
    expect(events).toEqual([TEXT, DONE]);
  });

  it("does not retry once any event has been emitted, even a usage event before a transport error", async () => {
    let calls = 0;
    const { sleep } = noopSleep();
    const events = await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          return emit(USAGE, transportError("mid-stream drop"));
        },
        { retries: 2, sleep },
      ),
    );
    expect(calls).toBe(1);
    expect(events).toEqual([USAGE, transportError("mid-stream drop")]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  it.each(["rate-limit", "auth", "bad-request", "overloaded"] as const)(
    "does not retry a %s error event",
    async (kind) => {
      let calls = 0;
      const { sleep } = noopSleep();
      const fault = errorOf(kind);
      const events = await collect(
        retryTransportFaults(
          () => {
            calls += 1;
            return emit(fault);
          },
          { retries: 2, sleep },
        ),
      );
      expect(calls).toBe(1);
      expect(events).toEqual([fault]);
    },
  );

  it("surfaces the last fault as a throw when exhaustion happens on a thrown attempt", async () => {
    let calls = 0;
    const { sleep } = noopSleep();
    const iterable = retryTransportFaults(
      () => {
        calls += 1;
        return throwingStream(new Error(`attempt ${calls}`));
      },
      { retries: 1, sleep },
    );
    await expect(collect(iterable)).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
  });

  it("surfaces the last fault as an error event when exhaustion happens on a transport error event", async () => {
    let calls = 0;
    const { sleep } = noopSleep();
    const events = await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          return emit(transportError(`attempt ${calls}`));
        },
        { retries: 1, sleep },
      ),
    );
    expect(calls).toBe(2);
    expect(events).toEqual([transportError("attempt 2")]);
  });

  it("makes exactly one attempt when retries is 0", async () => {
    let calls = 0;
    const { sleep } = noopSleep();
    const events = await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          return emit(transportError());
        },
        { retries: 0, sleep },
      ),
    );
    expect(calls).toBe(1);
    expect(events).toEqual([transportError()]);
  });

  it("sends the injected sleep exactly 250 then 500", async () => {
    let calls = 0;
    const { sleep, calls: delays } = noopSleep();
    await collect(
      retryTransportFaults(
        () => {
          calls += 1;
          return calls <= 2 ? emit(transportError()) : emit(DONE);
        },
        { retries: 2, sleep },
      ),
    );
    expect(delays).toEqual([250, 500]);
  });

  it("aborting during backoff prevents any further attempt", async () => {
    let calls = 0;
    const controller = new AbortController();
    const sleep = (_ms: number) => new Promise<void>(() => {}); // never resolves on its own
    const iterable = retryTransportFaults(
      () => {
        calls += 1;
        return emit(transportError());
      },
      { retries: 2, sleep, signal: controller.signal },
    );

    const pending = collect(iterable);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
