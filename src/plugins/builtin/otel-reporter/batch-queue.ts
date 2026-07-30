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

  // Dispatch is fire-and-forget: flushNow() resolves once the current batch has
  // been dequeued and handed to `send`, not once the network call (plus its
  // retry) settles. This lets an in-flight send that never resolves (e.g. a
  // hung connection) never block a caller awaiting flushNow().
  const doFlush = (): Promise<void> => {
    if (tornDown || queue.length === 0) return Promise.resolve();
    const batch = queue;
    queue = [];
    void sendWithRetry(batch);
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
    flushNow: () => doFlush(),
    teardown: () => {
      tornDown = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    getMetrics: () => ({ size: queue.length, dropCount }),
  };
}
