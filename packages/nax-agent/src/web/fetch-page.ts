/**
 * Page fetch: one HTTP(S) GET, the redirects it may follow, and the page it ends at.
 *
 * The fetch exists so a page a model asked for arrives as text nax shaped itself: the
 * destination is classified where the socket connects (`createCheckedLookup`), the scheme and
 * the address are re-checked at every hop, and the body is converted by this subsystem's own
 * converter rather than trusted as markup.
 *
 * Two checks guard the destination. A hostname is checked at connect time, because Node dials
 * the address the resolver hands back -- the check and the connection cannot disagree about a
 * DNS answer that changes between them. Node does not resolve an IP literal, so a literal host
 * (including a bracketed IPv6 one) is checked here, before the request exists.
 *
 * What a fetch never does: send credentials. There is no `authorization`, no `cookie`, and a
 * URL's own userinfo is dropped, since Node would otherwise turn it into an `authorization`
 * header. It also does not honour a proxy configured in the environment: it connects directly.
 *
 * One budget covers the whole fetch. The deadline is armed before the first socket exists and
 * it covers the redirect chain and the body together, because a page a model asked for is worth
 * one timeout rather than one per hop. The clock is released the moment the page is in hand, and
 * a cancelled fetch destroys the request it was waiting on and the response it was reading
 * instead of leaving either open.
 *
 * The body is capped on the bytes that arrived, before anything is decoded, and the media type
 * decides what those bytes become: HTML and XHTML are converted by `htmlToText`, the plain text
 * types and JSON are decoded as UTF-8 and passed through as written, and anything else is
 * reported as unread. Only UTF-8 is supported -- a body declaring another charset is decoded as
 * UTF-8 anyway.
 *
 * The response handle and the request handle below are this module's own narrow types rather
 * than `node:http`'s `ClientRequest`/`IncomingMessage`. They name the handful of members a page
 * fetch touches, which is what lets a test answer a request without a socket, and what keeps
 * the seam honest about how little of the client this module depends on.
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/index";
import { blockedAddressError, createCheckedLookup, isAllowedOrigin, isBlockedAddress } from "./address.ts";
import { normalizeWebUrl } from "./content.ts";
import { htmlToText } from "./html-text.ts";

/** The method every page fetch uses; a fetch never submits anything. */
const GET = "GET";

/** What a page fetch announces itself as. */
const USER_AGENT = "nax-web/1";

/** How many redirects one fetch follows before it refuses the chain. */
const MAX_REDIRECTS = 5;

/** The response statuses that move a fetch to another URL. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The media types this subsystem converts to text. */
const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

/** The media types whose body is decoded as UTF-8 and passed through as written. */
const PASS_THROUGH_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown", "application/json"]);

/** The media type reported for a response that named none. */
const UNKNOWN_MEDIA_TYPE = "unknown";

/** The `stage` on every error this module raises. */
const STAGE = "web-fetch";

/** The code a failed fetch raises. */
const FETCH_FAILED = "WEB_FETCH_FAILED";

/** The page a fetch ends at: where it landed, what it was, and the text nax can read. */
export interface WebPage {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly text: string;
  readonly links: readonly string[];
  readonly truncated: boolean;
  readonly unsupported: boolean;
}

/** What one page fetch may do: its bounds, its exemptions and its cancellation. */
export interface WebFetchOptions {
  /** The most body bytes a page may contribute; a longer body is cut here and reports it. */
  readonly maxBytes: number;
  /** The overall budget for the whole fetch, redirects and body included. */
  readonly timeoutMs: number;
  /** Origins whose addresses are not checked: the operator's own choices of destination. */
  readonly allowOrigins: readonly string[];
  /** Cancels the fetch. */
  readonly signal?: AbortSignal;
}

/** One response header set, as it arrived. */
export type WebHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** What a page fetch needs from the response it reads. */
export interface WebResponseHandle {
  readonly statusCode: number | undefined;
  readonly headers: WebHeaders;
  /** The body's chunks in arrival order; a stream failure surfaces as the iteration's error. */
  body(): AsyncIterable<Uint8Array>;
  /** Drain a body nothing will read, so the connection is not left half-open. */
  resume(): void;
  /** Terminate the stream: the body is over, whether or not all of it arrives. */
  destroy(): void;
}

/** What a page fetch needs from the request it opened. */
export interface WebRequestHandle {
  on(event: "error", listener: (error: Error) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  /** Give up on the request, and with it the socket behind it. */
  destroy(): void;
  end(): void;
}

/** The options one request carries: the method and headers nax sets, and the checking lookup. */
export interface WebRequestOptions extends RequestOptions {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly lookup: LookupFunction;
}

/** One request as the fetch makes it: the target, the options, and where the response goes. */
export type WebRequestFn = (
  url: URL,
  options: WebRequestOptions,
  onResponse: (response: WebResponseHandle) => void,
) => WebRequestHandle;

/**
 * Test seam: the two request functions and the timer pair, and nothing else. The request
 * defaults open a real socket through `node:https`/`node:http`; a test answers with a response
 * it built, so no page fetch in a test reaches the network. The timers are injectable so the
 * overall deadline can be driven from a virtual clock rather than waited out.
 */
export const _webFetchDeps: {
  request: WebRequestFn;
  httpRequest: WebRequestFn;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
} = {
  request: (url, options, onResponse) => httpsRequest(url, options, (response) => onResponse(responseHandle(response))),
  httpRequest: (url, options, onResponse) =>
    httpRequest(url, options, (response) => onResponse(responseHandle(response))),
  // The timer handle is opaque here, exactly as it is in the other `_deps` timer pairs: one
  // budget for the whole fetch has to be cleareable mid-flight, which is what rules out a sleep.
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)) as (
    handle: unknown,
  ) => void,
};

/**
 * Fetch one page: a single GET under one deadline, the redirects it may follow, and the page it
 * ends at with a body read no further than `opts.maxBytes`.
 */
export async function fetchWebPage(url: string, opts: WebFetchOptions): Promise<WebPage> {
  const start = startUrl(url);
  const deadline = startDeadline({ url: start.href, timeoutMs: opts.timeoutMs, signal: opts.signal });
  try {
    const { response, url: landed } = await followRedirects(start, opts, deadline);
    return await readPage(response, landed, opts, deadline);
  } finally {
    deadline.release();
  }
}

/** The URL a fetch starts at, or a failed fetch when the text names no http(s) destination. */
function startUrl(raw: string): URL {
  const url = withoutCredentials(normalizeWebUrl(raw));
  if (url === null) throw failedFetch("not an http(s) URL", { url: raw });
  return url;
}

/**
 * One overall budget for a fetch: its own deadline, and its caller's cancellation. The failure
 * to report is recorded before the signal aborts, so a reader that wakes up to an aborted signal
 * already has the reason in hand.
 */
interface Deadline {
  /** Aborted when the budget runs out or the caller cancels. */
  readonly signal: AbortSignal;
  /** The failure an interrupted fetch reports. */
  failure(): NaxError;
  /** Stop the clock and let go of the caller's listener. */
  release(): void;
}

/**
 * Start the fetch's one budget. A single timer covers the redirect chain and the body together;
 * it is armed here, before the first socket, and released in `fetchWebPage`'s `finally` whether
 * the fetch resolved, was refused or ran out. The caller's own signal is connected to the same
 * controller, so a cancel during a hop, a body read or a redirect all stop the fetch the same
 * way, and the listener it needed is detached on release.
 */
function startDeadline(p: {
  readonly url: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Deadline {
  const controller = new AbortController();
  const caller = p.signal;
  let failure: NaxError | undefined;
  const stop = (interruption: NaxError): void => {
    if (failure !== undefined) return;
    failure = interruption;
    controller.abort(interruption);
  };
  const timer = _webFetchDeps.setTimeout(() => stop(deadlineFailure(p.url, p.timeoutMs)), p.timeoutMs);
  const onCallerAbort = (): void => stop(cancelledFailure(p.url, caller?.reason));
  if (caller?.aborted === true) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort);
  return {
    signal: controller.signal,
    // Only an aborted signal reaches this, and every abort sets a failure first; the fallback
    // exists so the accessor is total rather than to describe a state this module can enter.
    failure: () => failure ?? cancelledFailure(p.url, undefined),
    release: () => {
      _webFetchDeps.clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Await `work` unless the fetch is cancelled first. A stalled response raises nothing the read
 * loop could notice -- no chunk, no error, no close -- so the deadline is the only way out of
 * one, and `onCancel` is what lets the stream go.
 */
async function untilCancelled<T>(work: Promise<T>, deadline: Deadline, onCancel: () => void): Promise<T> {
  const { signal } = deadline;
  // Whichever side loses the race may still settle later, and nothing is left to receive a
  // rejection from it: this attaches the handler now so it cannot surface as an unhandled one.
  void work.catch(() => {});
  if (signal.aborted) {
    onCancel();
    throw deadline.failure();
  }
  let listener = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => {
      onCancel();
      reject(deadline.failure());
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/**
 * The same destination with any userinfo dropped: a page fetch sends no credentials, and Node
 * would otherwise turn `user:pass@host` into an `authorization` header.
 */
function withoutCredentials(url: string | null): URL | null {
  if (url === null) return null;
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return parsed;
  const bare = new URL(parsed.origin);
  bare.pathname = parsed.pathname;
  bare.search = parsed.search;
  return bare;
}

/** One response and the URL it answered for. */
interface Hop {
  readonly response: WebResponseHandle;
  readonly url: URL;
}

/**
 * Issue the GET and follow at most `MAX_REDIRECTS` of them. Each hop's destination is resolved
 * against the hop before it, reduced to this subsystem's one URL spelling, and checked again --
 * a chain cannot lead a fetch somewhere the first URL was not allowed to go.
 */
async function followRedirects(start: URL, opts: WebFetchOptions, deadline: Deadline): Promise<Hop> {
  let url = start;
  // One iteration per request: the first, then one per redirect it may follow.
  for (let followed = 0; followed <= MAX_REDIRECTS; followed++) {
    assertAddressAllowed(url, opts.allowOrigins);
    const response = await sendGet(url, opts, deadline);
    const location = redirectLocation(response);
    if (location === null) return { response, url };
    // The redirect's own body is not read; drain it so the connection is not left hanging.
    response.resume();
    url = redirectUrl(location, url);
  }
  throw failedFetch("too many redirects", { url: url.href, redirects: MAX_REDIRECTS });
}

/**
 * Refuse a hop whose host is an IP literal in a blocked range, before its request exists.
 *
 * A hostname needs nothing here: Node resolves it through the lookup this module put on the
 * request, so the answer that is checked is the answer that is dialled. Node does not resolve an
 * IP literal at all, so it would connect on a literal this check never saw -- which is why the
 * literal is classified here. An allowed origin is exempt, the same way it is exempt inside the
 * lookup: the operator chose that destination, and a self-hosted backend is often on a private
 * network by design.
 */
function assertAddressAllowed(url: URL, allowOrigins: readonly string[]): void {
  if (isAllowedOrigin(url.origin, allowOrigins)) return;
  const literal = literalAddress(url.hostname);
  if (literal !== null && isBlockedAddress(literal)) throw blockedAddressError(literal, literal);
}

/** The address an IP-literal hostname names; `null` for a name that has to be resolved. */
function literalAddress(hostname: string): string | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 ? null : bare;
}

/** The `Location` of a response that redirects, or `null` when this response is the page. */
function redirectLocation(response: WebResponseHandle): string | null {
  if (!REDIRECT_STATUSES.has(response.statusCode ?? 0)) return null;
  const location = headerValue(response.headers, "location")?.trim() ?? "";
  // A redirect with no Location -- or an empty one -- names nowhere to go, so it is read as
  // the page it is rather than followed to the URL it already answered for.
  return location === "" ? null : location;
}

/** The destination a `Location` names, or a failed fetch when it names no http(s) URL. */
function redirectUrl(location: string, current: URL): URL {
  const url = withoutCredentials(resolvedAgainst(location, current));
  if (url === null) throw failedFetch("redirect to an unsupported URL", { location, from: current.href });
  return url;
}

/** `raw` resolved against `base` and reduced to this subsystem's one URL spelling. */
function resolvedAgainst(raw: string, base: URL): string | null {
  try {
    return normalizeWebUrl(new URL(raw, base).href);
  } catch {
    // A Location that will not resolve names no destination, which is a refusal rather than a
    // failure of this module: the caller hears "unsupported URL", not "unparseable".
    return null;
  }
}

/**
 * Open one GET and hand back its response, reporting a request failure as a failed fetch.
 *
 * The request is also where a cancelled fetch is stopped: a server that never answers raises no
 * error of its own, so the deadline listener destroys the request and rejects. Whatever ends the
 * request -- a response, an error, a cancel -- detaches the other two listeners, so a settled
 * hop leaves nothing registered behind it.
 */
function sendGet(url: URL, opts: WebFetchOptions, deadline: Deadline): Promise<WebResponseHandle> {
  if (deadline.signal.aborted) return Promise.reject(deadline.failure());
  return new Promise<WebResponseHandle>((resolve, reject) => {
    let request: WebRequestHandle | undefined;
    const detach = (): void => {
      // A stub -- the seam exists so one can answer without a socket -- may hand back its
      // response before this function's own return value exists, and there is then nothing to
      // detach from: no listener had been registered on a request yet.
      request?.off("error", onError);
      deadline.signal.removeEventListener("abort", onCancel);
    };
    const onError = (error: Error): void => {
      detach();
      reject(connectionFailure(error, url));
    };
    const onCancel = (): void => {
      detach();
      request?.destroy();
      reject(deadline.failure());
    };
    request = requestFn(url)(url, requestOptions(url, opts), (response) => {
      detach();
      resolve(response);
    });
    request.on("error", onError);
    deadline.signal.addEventListener("abort", onCancel, { once: true });
    // A stub -- or a caller's listener -- can abort between the check above and the listener
    // just added, and that abort is never replayed: check once more now that it is registered.
    if (deadline.signal.aborted) onCancel();
    request.end();
  });
}

/** The request function for a URL's scheme: only https gets a TLS request. */
function requestFn(url: URL): WebRequestFn {
  return url.protocol === "https:" ? _webFetchDeps.request : _webFetchDeps.httpRequest;
}

/**
 * The GET a page fetch makes: no credentials, no cookies, its own user agent, and the lookup
 * that classifies the address the socket will dial.
 */
function requestOptions(url: URL, opts: WebFetchOptions): WebRequestOptions {
  return {
    method: GET,
    headers: { "user-agent": USER_AGENT },
    lookup: createCheckedLookup({ allowOrigins: opts.allowOrigins, origin: url.origin }),
  };
}

/**
 * A transport failure as the fetch reports it. An error that is already a `NaxError` keeps its
 * identity: a destination the checked lookup refused stays `WEB_ADDRESS_BLOCKED` with the host
 * that resolved to a private address, and a deadline that has already passed stays the failure
 * it was recorded as. Anything else -- a socket error, a stream lost mid-read -- becomes a
 * failed fetch naming its cause.
 */
function connectionFailure(error: unknown, url: URL): NaxError {
  if (error instanceof NaxError) return error;
  return failedFetch(errorMessage(error), { url: url.href, cause: error });
}

/** The failure a fetch reports when its overall budget runs out. */
function deadlineFailure(url: string, timeoutMs: number): NaxError {
  return failedFetch(`timed out after ${timeoutMs} ms`, { url, timeoutMs });
}

/** The failure a fetch reports when its caller cancels it. */
function cancelledFailure(url: string, reason: unknown): NaxError {
  return failedFetch("the fetch was aborted", { url, cause: reason });
}

/**
 * The response as a page. Its media type decides what the body becomes: HTML and XHTML are
 * converted, the plain text types and JSON are decoded and passed through as written, and
 * anything else is reported as unread rather than passed through.
 */
async function readPage(
  response: WebResponseHandle,
  url: URL,
  opts: WebFetchOptions,
  deadline: Deadline,
): Promise<WebPage> {
  const status = response.statusCode ?? 0;
  const contentType = mediaType(headerValue(response.headers, "content-type"));
  if (!HTML_TYPES.has(contentType) && !PASS_THROUGH_TYPES.has(contentType)) {
    // Nothing of this body is wanted, so the connection is drained rather than read.
    response.resume();
    return {
      url: url.href,
      status,
      contentType,
      text: `Unsupported content type ${contentType}; nothing was read.`,
      links: [],
      truncated: false,
      unsupported: true,
    };
  }
  const body = await readBody(response, url, opts, deadline);
  if (PASS_THROUGH_TYPES.has(contentType)) {
    return {
      url: url.href,
      status,
      contentType,
      text: body.text,
      links: [],
      truncated: body.truncated,
      unsupported: false,
    };
  }
  const { title, text, links } = htmlToText(body.text, url.href);
  const page = { url: url.href, status, contentType, text, links, truncated: body.truncated, unsupported: false };
  return title === undefined ? page : { ...page, title };
}

/** A body read to its cap: the text it decodes to, and whether there was more of it. */
interface BodyText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The response body as UTF-8 text, read no further than `opts.maxBytes`.
 *
 * The cap applies to the bytes as they arrived, before anything is decoded, so a body of 2-byte
 * characters is cut at half as many characters as a body of ASCII. Once the cap is reached the
 * rest of the body is never read and the stream is destroyed rather than left draining; a cut
 * that lands inside a character decodes that character as U+FFFD, which is the only loss a
 * byte-capped read can report.
 */
async function readBody(
  response: WebResponseHandle,
  url: URL,
  opts: WebFetchOptions,
  deadline: Deadline,
): Promise<BodyText> {
  const body = response.body()[Symbol.asyncIterator]();
  const kept: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await untilCancelled(body.next(), deadline, () => response.destroy());
      if (next.done === true) return { text: decodeBody(kept), truncated: false };
      const chunk = next.value;
      const room = opts.maxBytes - size;
      if (chunk.byteLength <= room) {
        kept.push(chunk);
        size += chunk.byteLength;
        continue;
      }
      kept.push(chunk.subarray(0, Math.max(room, 0)));
      response.destroy();
      return { text: decodeBody(kept), truncated: true };
    }
  } catch (error) {
    throw connectionFailure(error, url);
  }
}

/** The bytes kept, decoded as UTF-8: the one decoding this subsystem supports. */
function decodeBody(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/** A content-type header as its media type alone: parameters dropped, case folded. A response
 * that named no content type at all reports `unknown`, which is also what a page shows when its
 * type is not one this subsystem reads. */
function mediaType(contentType: string | undefined): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return type === "" ? UNKNOWN_MEDIA_TYPE : type;
}

/** One header as the single value a page fetch reads; a repeated header contributes its first. */
function headerValue(headers: WebHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : value?.[0];
}

/** One `IncomingMessage` as the handle a page fetch reads. */
function responseHandle(response: IncomingMessage): WebResponseHandle {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: () => response,
    resume: () => response.resume(),
    destroy: () => response.destroy(),
  };
}

/** The failed fetch a refusal raises, naming what was refused and why. */
function failedFetch(message: string, context: Record<string, unknown>): NaxError {
  return new NaxError(message, FETCH_FAILED, { stage: STAGE, ...context });
}
