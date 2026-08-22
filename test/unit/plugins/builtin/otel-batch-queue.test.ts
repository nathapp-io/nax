import { afterEach, describe, expect, test } from "bun:test";
import { type BatchQueue, createBatchQueue } from "@/plugins/builtin/otel-reporter/batch-queue";
import { waitForCondition, withTimerSpy, withWarnSpy } from "@test/helpers";

interface Span {
  id: string;
}

function makeSpans(count: number, offset = 0): Span[] {
  return Array.from({ length: count }, (_, i) => ({ id: `span-${offset + i}` }));
}

/** Send stub that records every batch it receives and resolves per `outcome`. */
function capturingSend(outcome: boolean | ((batch: Span[]) => boolean) = true) {
  const calls: Span[][] = [];
  const send = async (batch: Span[]): Promise<boolean> => {
    calls.push(batch);
    return typeof outcome === "function" ? outcome(batch) : outcome;
  };
  return { calls, send };
}

/** Send stub whose first `failCount` calls resolve false; subsequent calls resolve true. */
function flakySend(failCount: number) {
  const calls: Span[][] = [];
  const send = async (batch: Span[]): Promise<boolean> => {
    calls.push(batch);
    return calls.length > failCount;
  };
  return { calls, send };
}

/** Send stub whose promises stay pending until manually resolved via `pending[n].resolve`. */
function deferredSend() {
  const calls: Span[][] = [];
  const pending: Array<(ok: boolean) => void> = [];
  const send = (batch: Span[]): Promise<boolean> => {
    calls.push(batch);
    return new Promise<boolean>((resolve) => {
      pending.push(resolve);
    });
  };
  return { calls, pending, send };
}

const liveQueues: BatchQueue<Span>[] = [];

function track(queue: BatchQueue<Span>): BatchQueue<Span> {
  liveQueues.push(queue);
  return queue;
}

afterEach(() => {
  for (const q of liveQueues.splice(0)) q.teardown();
});

describe("createBatchQueue", () => {
  test("AC2: enqueuing maxBatchSize spans issues exactly one export request carrying every span", async () => {
    const { calls, send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(63)) queue.enqueue(s);
    // boundary: one below maxBatchSize must not trigger an export on its own
    expect(calls.length).toBe(0);

    queue.enqueue({ id: "span-63" });
    await waitForCondition(() => calls.length === 1, 1_000, 10);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(64);
    expect(new Set(calls[0].map((s) => s.id)).size).toBe(64);
  });

  test("AC3: enqueuing fewer than maxBatchSize spans issues an export once flushIntervalMs elapses", async () => {
    const { calls, send } = capturingSend(true);
    const queue = track(createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 100, maxQueueSize: 2048, send }));

    for (const s of makeSpans(10)) queue.enqueue(s);
    // boundary: nothing exported before the interval elapses
    expect(calls.length).toBe(0);

    await waitForCondition(() => calls.length === 1, 1_000, 10);
    expect(calls[0]).toHaveLength(10);
  });

  test("AC4: flushNow exports pending spans before flushIntervalMs has elapsed", async () => {
    const { calls, send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(5)) queue.enqueue(s);
    await queue.flushNow();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(5);
  });

  test("AC4 boundary: flushNow on an empty queue issues no export", async () => {
    const { calls, send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    await queue.flushNow();
    expect(calls).toHaveLength(0);
  });

  test("AC5: enqueuing beyond maxQueueSize discards the oldest entries", async () => {
    const { calls, send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 1_000, flushIntervalMs: 60_000, maxQueueSize: 5, send }),
    );

    for (const s of makeSpans(6)) queue.enqueue(s); // span-0..span-5, capacity 5 -> span-0 dropped
    await queue.flushNow();

    expect(calls).toHaveLength(1);
    const ids = calls[0].map((s) => s.id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("span-0");
    expect(ids).toEqual(["span-1", "span-2", "span-3", "span-4", "span-5"]);
  });

  test("AC6: after an overflow the queue reports an accurate drop count", () => {
    const { send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 1_000, flushIntervalMs: 60_000, maxQueueSize: 5, send }),
    );

    for (const s of makeSpans(6)) queue.enqueue(s); // 1 overflow drop
    expect(queue.getMetrics().dropCount).toBe(1);

    for (const s of makeSpans(10, 100)) queue.enqueue(s); // 10 more overflow drops
    expect(queue.getMetrics().dropCount).toBe(11);
  });

  test("AC7: an overflow logs exactly one warning per threshold crossing", async () => {
    await withWarnSpy(async (warnSpy) => {
      const { send } = capturingSend(true);
      const queue = track(
        createBatchQueue<Span>({ maxBatchSize: 1_000, flushIntervalMs: 60_000, maxQueueSize: 3, send }),
      );

      for (const s of makeSpans(5)) queue.enqueue(s); // 2 drops while crossing the threshold once
      const overflowCalls = () => warnSpy.mock.calls.filter((c) => c[0] === "otel-batch-queue");
      expect(overflowCalls()).toHaveLength(1);

      // drain back under capacity, then cross the threshold again
      await queue.flushNow();
      for (const s of makeSpans(5, 200)) queue.enqueue(s); // 2 more drops, a second crossing
      expect(overflowCalls()).toHaveLength(2);
    });
  });

  test("AC8: a failed export request is retried exactly once and delivered if the retry succeeds", async () => {
    const { calls, send } = flakySend(1);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(5)) queue.enqueue(s);
    await queue.flushNow();

    expect(calls).toHaveLength(2); // initial attempt + exactly one retry
    expect(calls[0]).toEqual(calls[1]);
  });

  test("AC8 boundary: a batch failing both the initial attempt and the retry is not attempted a third time", async () => {
    const { calls, send } = flakySend(Number.POSITIVE_INFINITY);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(5)) queue.enqueue(s);
    await queue.flushNow();

    expect(calls).toHaveLength(2);
  });

  test("AC9: flushNow completes without throwing once the retry budget is exhausted", async () => {
    const send = async (): Promise<boolean> => {
      throw new Error("simulated export failure");
    };
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(5)) queue.enqueue(s);
    await expect(queue.flushNow()).resolves.toBeUndefined();
  });

  test("AC10: a span enqueued while an export is in flight is included in a subsequent export", async () => {
    const { calls, pending, send } = deferredSend();
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(5)) queue.enqueue(s);
    const firstFlush = queue.flushNow();
    await waitForCondition(() => calls.length === 1, 1_000, 10);
    expect(calls[0]).toHaveLength(5);

    // enqueued while the first export's promise is still unresolved
    queue.enqueue({ id: "span-in-flight" });

    pending[0]?.(true);
    await firstFlush;

    // not silently folded into the in-flight batch
    expect(calls).toHaveLength(1);

    // OTLP-1: flushNow() now awaits the in-flight send, so the second send
    // must be resolved concurrently or this await never settles.
    const secondFlush = queue.flushNow();
    await waitForCondition(() => calls.length === 2, 1_000, 10);
    pending[1]?.(true);
    await secondFlush;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([{ id: "span-in-flight" }]);
  });

  test("AC11: after teardown no export is issued even once flushIntervalMs has elapsed", async () => {
    const { calls, send } = capturingSend(true);

    const { result: queue, leaked } = await withTimerSpy(async () => {
      const q = createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 100, maxQueueSize: 2048, send });
      for (const s of makeSpans(3)) q.enqueue(s);
      q.teardown();
      return q;
    });
    void queue;

    expect(leaked).toHaveLength(0); // teardown clears the re-armed flush timer

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toHaveLength(0);
  });

  test("getMetrics reports the current queue size before a flush drains it", async () => {
    const { send } = capturingSend(true);
    const queue = track(
      createBatchQueue<Span>({ maxBatchSize: 64, flushIntervalMs: 60_000, maxQueueSize: 2048, send }),
    );

    for (const s of makeSpans(3)) queue.enqueue(s);
    expect(queue.getMetrics().size).toBe(3);

    await queue.flushNow();
    expect(queue.getMetrics().size).toBe(0);
  });
});
