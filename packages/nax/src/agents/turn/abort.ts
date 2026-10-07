/**
 * Abort helpers shared by every agent transport's turn loop.
 *
 * Moved out of agents/acp/adapter-lifecycle.ts in S4b-1 (decision D1-c): the
 * interaction race in agents/interaction needs raceWithAbort, and nothing
 * here is acpx plumbing.
 */

export function createAbortError(signal?: AbortSignal, fallback = "Run aborted"): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(fallback);
}

export function throwIfAborted(signal?: AbortSignal, fallback?: string): void {
  if (signal?.aborted) {
    throw createAbortError(signal, fallback);
  }
}

export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, fallback?: string): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw createAbortError(signal, fallback);
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal, fallback));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
