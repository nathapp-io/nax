import { getSafeLogger } from "@/logger";

const STAGE = "otel-batch-queue";
const RETRY_ATTEMPTS = 2;

export interface BatchQueueOptions<T> {
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  send: (batch: T[]) => Promise<boolean>;
}

export interface BatchQueueMetrics {
  size: number;
  dropCount: number;
}

export interface BatchQueue<T> {
  enqueue(item: T): void;
  flushNow(): Promise<void>;
  teardown(): void;
  getMetrics(): BatchQueueMetrics;
}

/**
 * Bounded FIFO queue that batches items for export. Flushes on
 * `maxBatchSize`, on a re-armed `flushIntervalMs` timer, or on explicit
 * `flushNow()`. Overflow past `maxQueueSize` drops the oldest entries and
 * logs one warning per threshold crossing. A failed batch is retried once,
 * then dropped.
 */
export function createBatchQueue<T>(opts: BatchQueueOptions<T>): BatchQueue<T> {
  const { maxBatchSize, flushIntervalMs, maxQueueSize, send } = opts;
  let queue: T[] = [];
  let dropCount = 0;
  let overflowing = false;
  let tornDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // OTLP-1: doFlush() is deliberately fire-and-forget for the periodic timer
  // and the maxBatchSize auto-flush (a hung send must never block those), but
  // flushNow()/teardown() need to know when the network call actually
  // settles — track every detached send so they can wait on it, bounded by
  // send()'s own retry/timeout budget.
  const inFlightSends = new Set<Promise<void>>();

  const armTimer = (): void => {
    // forbidden-patterns.md: setInterval is banned; setTimeout is permitted here
    // because the handle is cancelled mid-flight via clearTimeout in teardown().
    timer = setTimeout(() => {
      void doFlush();
      if (!tornDown) armTimer();
    }, flushIntervalMs);
  };

  const sendWithRetry = async (batch: T[]): Promise<void> => {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const ok = await send(batch);
        if (ok) return;
      } catch (err) {
        getSafeLogger()?.warn(STAGE, "Batch export threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  // Dequeue is synchronous/immediate; the network send is dispatched
  // detached (tracked in inFlightSends) so periodic/auto-flush callers never
  // block on it. flushNow() awaits the tracked set explicitly instead.
  const doFlush = (): Promise<void> => {
    if (tornDown || queue.length === 0) return Promise.resolve();
    const batch = queue;
    queue = [];
    const sendPromise = sendWithRetry(batch).finally(() => inFlightSends.delete(sendPromise));
    inFlightSends.add(sendPromise);
    return Promise.resolve();
  };

  const enqueue = (item: T): void => {
    queue.push(item);
    if (queue.length > maxQueueSize) {
      queue.shift();
      dropCount++;
      if (!overflowing) {
        overflowing = true;
        getSafeLogger()?.warn(STAGE, "Batch queue overflow — dropping oldest entries", { maxQueueSize });
      }
    } else {
      overflowing = false;
    }
    if (queue.length >= maxBatchSize) {
      void doFlush();
    }
  };

  armTimer();

  return {
    enqueue,
    flushNow: async () => {
      await doFlush();
      // OTLP-1: wait for every in-flight send (this one plus any still
      // settling from an earlier auto-flush), not just the dequeue.
      await Promise.all(inFlightSends);
    },
    teardown: () => {
      tornDown = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    getMetrics: () => ({ size: queue.length, dropCount }),
  };
}
