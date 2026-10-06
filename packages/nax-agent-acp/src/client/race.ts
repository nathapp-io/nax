/**
 * Settles a promise against an optional deadline and an optional abort signal,
 * and reports which came first instead of throwing. The ACP backend bounds every
 * open step, the cancel grace and the close with it. The raced promise's own
 * rejection is always observed, so a late failure is never unhandled.
 */
export type Raced<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export interface RaceOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function race<T>(promise: Promise<T>, opts: RaceOptions): Promise<Raced<T>> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => finish({ kind: "aborted" });
    function finish(result: Raced<T>): void {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    }
    promise.then(
      (value) => finish({ kind: "ok", value }),
      (error: unknown) => finish({ kind: "failed", error }),
    );
    if (opts.signal?.aborted === true) {
      finish({ kind: "aborted" });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), opts.timeoutMs);
  });
}
