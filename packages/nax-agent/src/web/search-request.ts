/**
 * The transport every search adapter shares: one request under one deadline, the statuses it
 * classifies, and the result mapping every backend's answer goes through.
 *
 * A search is one request with no retry. Three failures are the same failure here -- a status
 * that is not 2xx, a request that outlives its budget, and a body that is not the shape the
 * adapter expects -- so they all surface as `WEB_SEARCH_FAILED`, and the only thing the caller
 * can act on is the message. Two statuses get a message of their own because they mean the
 * operator's configuration rather than a transient fault: 401 and 403 are a key the backend
 * refused, and 429 is a key being rate-limited.
 *
 * The body is read as JSON and nowhere else: a search answer is a search answer even from a
 * server that labelled it something else, so the parse is the check rather than the media type.
 *
 * The deadline covers the request and the body together, the same way a page fetch's does, and
 * the caller's signal is connected to it so a cancelled turn stops the request it started. The
 * clock is injectable because "a server that never answers" is otherwise only observable by
 * waiting the whole budget out.
 */

import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/index";
import { normalizeWebUrl } from "./content.ts";
import type { WebSearchBackendId, WebSearchResult } from "./types.ts";

/** The `stage` on every error this module raises. */
const STAGE = "web-search";

/** The code a failed search raises, whatever the reason. */
export const SEARCH_FAILED = "WEB_SEARCH_FAILED";

/** How long one search may take, from the request to the last byte of its answer. */
export const SEARCH_TIMEOUT_MS = 15_000;

/** How many characters of a result's snippet a call keeps. */
export const SNIPPET_MAX_CHARS = 500;

/** An HTML tag inside a snippet: markup rather than the text it describes. */
const HTML_TAG = /<[^>]*>/g;

/** The lowest status that is a success. */
const OK_MIN = 200;

/** One past the highest status that is a success. */
const OK_MAX = 300;

/** One request an adapter makes: where it goes, and what it sends. */
export interface SearchRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** One result as a backend answered it, before this subsystem's spelling is applied. */
export interface RawSearchResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly snippet?: unknown;
}

/** How one adapter reads a result of its own answer into the fields above. */
export type RawResultReader = (record: Record<string, unknown>) => RawSearchResult;

/**
 * What a result its answer gave no title for is titled. `"url"` repeats the result's normalised
 * URL: an answer that omits a title it could not produce still has to name the result, and a
 * title that is empty reads to a model as a result with nothing in it. An adapter opts in, so
 * a backend whose answers always carry a title keeps an empty one empty.
 */
export type MissingTitle = "url";

/**
 * Test seam: the fetch a search is sent through, and the timer pair its deadline runs on. The
 * fetch defaults to the global one; a test answers with a `Response` it built, so no search in a
 * test reaches the network. The timers are injectable so the deadline can be driven from a
 * virtual clock rather than waited out, and the handle is opaque for the same reason it is in
 * `_webFetchDeps`: one budget has to be cleareable mid-flight, which is what rules out a sleep.
 */
export const _webSearchDeps: {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
} = {
  fetch: (input, init) => fetch(input, init),
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)) as (
    handle: unknown,
  ) => void,
};

/**
 * Send one search request and answer its JSON body.
 *
 * The request and the body are waited on under one deadline: whichever fails first -- the
 * transport, the budget, the caller's cancellation, the status, the parse -- is the failure the
 * caller sees, and the timer is released however the call ends.
 */
export async function fetchSearchJson(p: {
  readonly backend: WebSearchBackendId;
  readonly request: SearchRequest;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const deadline = startDeadline({ backend: p.backend, signal: p.signal });
  try {
    const response = await untilAborted(send(p.request, p.backend, deadline), deadline);
    return await untilAborted(readJson(response, p.backend), deadline);
  } finally {
    deadline.release();
  }
}

/**
 * The failure a search raises, naming the backend and, when the answer arrived, its status.
 * Every failure this module and its adapters raise is built here, so one search's errors read
 * the same wherever they came from.
 */
export function searchFailure(
  message: string,
  p: { readonly backend: WebSearchBackendId; readonly status?: number },
): NaxError {
  return new NaxError(message, SEARCH_FAILED, {
    stage: STAGE,
    backend: p.backend,
    ...(p.status !== undefined ? { status: p.status } : {}),
  });
}

/**
 * The failure an answer of the wrong shape raises. `detail` says what was missing, because a
 * model reading the message cannot inspect the body it came from.
 */
export function malformedAnswer(backend: WebSearchBackendId, detail: string): NaxError {
  return searchFailure(`${backend} answered with ${detail}`, { backend });
}

/**
 * The base URL a search is sent to: the configured one with its trailing slashes dropped, so a
 * path can be appended, or the backend's own default when the caller configured none.
 */
export function searchBaseUrl(configured: string | undefined, fallback: string): string {
  return (configured ?? fallback).replace(/\/+$/, "");
}

/** One value as a JSON object, or `undefined` when it is anything else. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The results one adapter's answer names, mapped to this subsystem's spelling.
 *
 * An entry that is not an object is an answer of the wrong shape and fails the search. A result
 * whose URL does not normalise is dropped instead: one unreachable link is a bad result, not a
 * bad answer, and the model is better served by the results around it.
 */
export function toSearchResults(p: {
  readonly backend: WebSearchBackendId;
  readonly items: readonly unknown[];
  readonly read: RawResultReader;
  readonly missingTitle?: MissingTitle;
}): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const item of p.items) {
    const record = recordOf(item);
    if (record === undefined) throw malformedAnswer(p.backend, "a result that is not an object");
    const mapped = toSearchResult(p.read(record), p.missingTitle);
    if (mapped !== null) results.push(mapped);
  }
  return results;
}

/** One result in this subsystem's spelling, or `null` when its URL is not one nax records. */
function toSearchResult(raw: RawSearchResult, missingTitle: MissingTitle | undefined): WebSearchResult | null {
  const url = typeof raw.url === "string" ? normalizeWebUrl(raw.url) : null;
  if (url === null) return null;
  const title = text(raw.title);
  return { title: title === "" && missingTitle === "url" ? url : title, url, snippet: snippet(raw.snippet) };
}

/** A result's title as written, with no markup removed: these APIs send plain text here. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A result's snippet: its tags stripped, its surrounding space trimmed, then cut to the cap. */
function snippet(value: unknown): string {
  const plain = typeof value === "string" ? value.replace(HTML_TAG, "").trim() : "";
  return plain.slice(0, SNIPPET_MAX_CHARS);
}

/**
 * One search's deadline: the signal the request carries, the failure to report when it fires,
 * and the way to stop the clock. Exactly one failure is recorded -- the first -- so a caller
 * that cancels a request already out of budget hears about the budget.
 */
interface Deadline {
  readonly signal: AbortSignal;
  /** The failure this deadline reports, which is only meaningful once the signal aborted. */
  failure(): NaxError;
  /** Stop the clock and let go of the caller's listener. */
  release(): void;
}

/** Start the deadline one search runs under: its own budget, and its caller's cancellation. */
function startDeadline(p: { readonly backend: WebSearchBackendId; readonly signal?: AbortSignal }): Deadline {
  const controller = new AbortController();
  const caller = p.signal;
  let failure: NaxError | undefined;
  const stop = (interruption: NaxError): void => {
    if (failure !== undefined) return;
    failure = interruption;
    controller.abort(interruption);
  };
  const timer = _webSearchDeps.setTimeout(
    () => stop(searchFailure(`${p.backend} did not answer within ${SEARCH_TIMEOUT_MS} ms`, { backend: p.backend })),
    SEARCH_TIMEOUT_MS,
  );
  const onCallerAbort = (): void => stop(searchFailure("the search was aborted", { backend: p.backend }));
  if (caller?.aborted === true) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort);
  return {
    signal: controller.signal,
    // Only an aborted signal reads this, and every abort records its failure first; the
    // fallback keeps the accessor total rather than describing a state this module can enter.
    failure: () => failure ?? searchFailure("the search was aborted", { backend: p.backend }),
    release: () => {
      _webSearchDeps.clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Await `work` unless the deadline fires first. A request the server never answers raises
 * nothing of its own -- no error, no body, no close -- so the deadline is the only way out.
 */
async function untilAborted<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  const { signal } = deadline;
  // Whichever side loses the race may still settle later, and nothing is left to receive a
  // rejection from it: this attaches the handler now so it cannot surface as an unhandled one.
  void work.catch(() => {});
  if (signal.aborted) throw deadline.failure();
  let listener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(deadline.failure());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/**
 * Send one request and hand back its response, or raise the failure it answered with.
 *
 * The request carries the deadline's signal, so a cancelled turn or an expired budget aborts the
 * socket the search is waiting on rather than only rejecting the promise wrapped around it: a
 * request nobody is waiting for any more must not keep reading its answer.
 */
async function send(request: SearchRequest, backend: WebSearchBackendId, deadline: Deadline): Promise<Response> {
  let response: Response;
  try {
    response = await _webSearchDeps.fetch(request.url, { ...request.init, signal: deadline.signal });
  } catch (error) {
    throw searchFailure(`${backend} search failed: ${errorMessage(error)}`, { backend });
  }
  assertStatus(response.status, backend);
  return response;
}

/** The failure a status means, or nothing when it means the answer is there to read. */
function assertStatus(status: number, backend: WebSearchBackendId): void {
  if (status >= OK_MIN && status < OK_MAX) return;
  if (status === 401 || status === 403) {
    throw searchFailure(`${backend} rejected the search key`, { backend, status });
  }
  if (status === 429) throw searchFailure(`${backend} rate-limited the search`, { backend, status });
  throw searchFailure(`${backend} search failed with status ${status}`, { backend, status });
}

/**
 * The body of a successful answer as JSON. The parse is the shape check: a search answer that
 * is not JSON is a body this backend cannot read, whatever its content type said.
 */
async function readJson(response: Response, backend: WebSearchBackendId): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw searchFailure(`${backend} answered with a body that is not JSON`, { backend });
  }
}
