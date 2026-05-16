import { NaxError } from "../errors";

export interface DebateTurnSemaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createTurnSemaphore(limit: number): DebateTurnSemaphore {
  const concurrency = Math.max(1, limit);
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    next?.();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= concurrency) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }

      active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

export async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  storyId: string | undefined,
): Promise<T> {
  if (signal.aborted) {
    throw new NaxError("[debate] Stateful debate aborted", "CALL_OP_ABORTED", { storyId });
  }

  let abortHandler: (() => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      reject(new NaxError("[debate] Stateful debate aborted", "CALL_OP_ABORTED", { storyId }));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
