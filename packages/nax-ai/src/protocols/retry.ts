/**
 * Bounded transport-fault retry, ahead of the first event.
 *
 * Lives in its own module rather than inline in client.ts so it is
 * unit-testable with an injected clock, and so it survives a future
 * migration that deletes the pi-ai backend entirely: this file imports
 * nothing pi-ai-shaped, only the wire-protocol vocabulary in ./types.ts.
 *
 * Spec: docs/superpowers/specs/2026-08-31-nax-ai-protocol-architecture-design.md §10.1.
 * nax-ai retries transport faults only, and only before the first event of an
 * attempt is emitted. Rate limits and overload capacity are consumer policy
 * (concurrency, cost budget, failover) and must never be retried internally.
 * 4xx and auth failures are terminal — retrying cannot help either.
 */

import type { ProtocolEvent } from "./types.ts";

export interface RetryOptions {
  /** Retries beyond the first attempt. 0 makes exactly one attempt. */
  readonly retries: number;
  /** Injected so tests never actually wait; client.ts passes the real clock. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** 250ms then 500ms. No jitter: §10.1 hands concurrency policy to the
 * consumer, so de-synchronising a herd is their call, not ours — and a fixed
 * schedule keeps tests deterministic. */
const INITIAL_BACKOFF_MS = 250;

function backoffMs(retryIndex: number): number {
  return INITIAL_BACKOFF_MS * 2 ** retryIndex;
}

function isRetryableErrorEvent(event: ProtocolEvent): boolean {
  // 503/529 classify as "overloaded", not "transport" (see errors.ts and
  // its test) — deliberately excluded here, along with rate-limit, auth and
  // bad-request. Only a fault with no policy content is ours to retry.
  return event.type === "error" && event.error.kind === "transport";
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** A sleep that resolves early, and rejects, when `signal` fires — so a
 * pending backoff cannot outlive the caller's own cancellation and go on to
 * start a request nobody wants. */
function abortableSleep(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

/**
 * Wraps a protocol stream factory with bounded transport-fault retry.
 *
 * `makeStream` is called once per attempt so each retry is a fresh request.
 * The moment any event is yielded — including "usage" — everything from then
 * on passes straight through with no further retry for this call. "usage"
 * counts deliberately: pi-client.ts yields a usage event before an error
 * event when a failed request still consumed tokens ("A failed request that
 * consumed tokens still bills for them"). If usage did not gate the retry, a
 * retry would emit a second usage event, and collectStream's "last usage
 * wins" rule would silently discard the failed attempt's billed tokens. So
 * retry only ever covers attempts that produced literally nothing.
 */
export async function* retryTransportFaults(
  makeStream: () => AsyncIterable<ProtocolEvent>,
  { retries, sleep, signal }: RetryOptions,
): AsyncIterable<ProtocolEvent> {
  let retryIndex = 0;

  for (;;) {
    let emitted = false;
    let fault: ProtocolEvent | undefined;

    try {
      for await (const event of makeStream()) {
        if (!emitted && isRetryableErrorEvent(event)) {
          fault = event;
          break;
        }
        emitted = true;
        yield event;
      }
    } catch (cause) {
      // A throw is retryable whenever it precedes any emitted event and
      // attempts remain — unlike an error event, a throw carries no `kind`
      // to gate on, so any pre-first-event throw is presumed transport-shaped.
      if (emitted || retryIndex >= retries) throw cause;
      await abortableSleep(backoffMs(retryIndex), sleep, signal);
      retryIndex += 1;
      continue;
    }

    if (fault === undefined) return; // this attempt completed cleanly

    if (retryIndex >= retries) {
      yield fault;
      return;
    }

    await abortableSleep(backoffMs(retryIndex), sleep, signal);
    retryIndex += 1;
  }
}
