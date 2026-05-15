import { NaxError } from "../errors";

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
