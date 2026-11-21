/**
 * The fetch an HTTP error is visible in.
 *
 * pi-ai calls `onResponse` only for a response it went on to consume, so an
 * HTTP failure — a 429 with `Retry-After`, a 503 with a maintenance window —
 * never reaches it: the error surfaces as a message with a status embedded in
 * it and nothing else, and the consumer's retry policy (which M1 section 10.1
 * assigns to the consumer, not to this package) sleeps for its own default
 * instead of the delay the provider asked for (finding 8).
 *
 * This wrapper is passed to pi-ai as `options.fetch`, so it sees every HTTP
 * response the adapter's own fetch sees, including the failing one. It reports
 * the failing ones and then hands the response on untouched, which keeps the
 * adapter's own error handling — and pi-ai's internals — exactly as they were.
 *
 * Deliberately imports nothing from pi-ai (see scripts/check-pi-ai-imports.ts)
 * and uses no Bun API: it must run on Node, and the whole point of the seam is
 * that the backend underneath it can be replaced.
 */

import type { PiResponse } from "./pi-client.ts";

/** The signature of the global fetch this wraps. */
export type FetchFunction = typeof globalThis.fetch;

/** A response below this status is a success as far as reporting is concerned. */
const FIRST_ERROR_STATUS = 400;

/**
 * A response's headers as a plain record.
 *
 * `parseRetryAfter` reads header names with `Object.entries`, which a `Headers`
 * instance does not answer to, so the shape is flattened here rather than
 * pushed onto the classifier: this is the module that knows a `Response` was
 * the source. Names are lowercased by `Headers` itself, and a name repeated on
 * the wire is joined with ", ", which is what the classifier expects.
 */
function toHeadersRecord(headers: Headers): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/**
 * Wraps the global fetch so every HTTP error response is reported once, before
 * the caller (pi-ai) reads it.
 *
 * `globalThis.fetch` is read at CALL time, not captured here: a consumer — or a
 * test — that installs its own fetch after this wrapper was constructed must
 * still be the one the request goes to.
 *
 * Three behaviours, and the two non-error ones matter as much as the first:
 *
 * - A response with status 400 or above is reported with its status and
 *   headers, then returned as the same object.
 * - A response below 400 is returned without a report, so no success ever
 *   overwrites what a failure recorded.
 * - A rejected fetch rejects with the SAME reason and reports nothing: there
 *   was no response, and the rejection must reach pi-ai unchanged so its own
 *   transport classification is not second-guessed here.
 */
export function observeErrorResponses(onResponse: (response: PiResponse) => void): FetchFunction {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.status >= FIRST_ERROR_STATUS) {
      onResponse({ status: response.status, headers: toHeadersRecord(response.headers) });
    }
    return response;
  };
}
