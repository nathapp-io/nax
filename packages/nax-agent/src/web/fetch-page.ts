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
import {
  ADDRESS_BLOCKED,
  blockedAddressError,
  createCheckedLookup,
  isAllowedOrigin,
  isBlockedAddress,
} from "./address.ts";
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
  /** The most body bytes a page may contribute; the cap lands with the fetch's byte limit. */
  readonly maxBytes: number;
  /** The overall budget for the whole fetch, redirects included. */
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
}

/** What a page fetch needs from the request it opened. */
export interface WebRequestHandle {
  on(event: "error", listener: (error: Error) => void): void;
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
 * Test seam: the two request functions, and nothing else. The default opens a real socket
 * through `node:https`/`node:http`; a test answers with a response it built, so no page fetch
 * in a test reaches the network.
 */
export const _webFetchDeps: { request: WebRequestFn; httpRequest: WebRequestFn } = {
  request: (url, options, onResponse) => httpsRequest(url, options, (response) => onResponse(responseHandle(response))),
  httpRequest: (url, options, onResponse) =>
    httpRequest(url, options, (response) => onResponse(responseHandle(response))),
};

/**
 * Fetch one page: a single GET, the redirects it may follow, and the page it ends at.
 *
 * `maxBytes` and `timeoutMs` bound a fetch whose body cap, timeout and connection wrapping
 * land with the follow-up story; this one reads the body whole and reports `truncated: false`.
 */
export async function fetchWebPage(url: string, opts: WebFetchOptions): Promise<WebPage> {
  const start = startUrl(url);
  const { response, url: landed } = await followRedirects(start, opts);
  return readPage(response, landed);
}

/** The URL a fetch starts at, or a failed fetch when the text names no http(s) destination. */
function startUrl(raw: string): URL {
  const url = withoutCredentials(normalizeWebUrl(raw));
  if (url === null) throw failedFetch("not an http(s) URL", { url: raw });
  return url;
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
async function followRedirects(start: URL, opts: WebFetchOptions): Promise<Hop> {
  let url = start;
  // One iteration per request: the first, then one per redirect it may follow.
  for (let followed = 0; followed <= MAX_REDIRECTS; followed++) {
    assertAddressAllowed(url, opts.allowOrigins);
    const response = await sendGet(url, opts);
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

/** Open one GET and hand back its response, reporting a request failure as a failed fetch. */
function sendGet(url: URL, opts: WebFetchOptions): Promise<WebResponseHandle> {
  return new Promise<WebResponseHandle>((resolve, reject) => {
    const request = requestFn(url)(url, requestOptions(url, opts), resolve);
    request.on("error", (error) => reject(connectionFailure(error, url)));
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
 * A request-level failure as the fetch reports it. A destination the checked lookup refused
 * keeps the refusal it was given, so the caller still sees `WEB_ADDRESS_BLOCKED` and the host
 * that resolved to a private address, rather than a generic connection failure; anything else
 * is a failed fetch naming its cause.
 */
function connectionFailure(error: Error, url: URL): NaxError {
  if (error instanceof NaxError && error.code === ADDRESS_BLOCKED) return error;
  return failedFetch(errorMessage(error), { url: url.href, cause: error });
}

/**
 * The response as a page. Its media type decides whether the body is text nax can read: an
 * HTML page is converted, and anything else is reported as unread rather than passed through.
 */
async function readPage(response: WebResponseHandle, url: URL): Promise<WebPage> {
  const status = response.statusCode ?? 0;
  const contentType = mediaType(headerValue(response.headers, "content-type"));
  if (!HTML_TYPES.has(contentType)) {
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
  const { title, text, links } = htmlToText(await readBody(response), url.href);
  const page = { url: url.href, status, contentType, text, links, truncated: false, unsupported: false };
  return title === undefined ? page : { ...page, title };
}

/** The response body as text, decoded as UTF-8. */
async function readBody(response: WebResponseHandle): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body()) chunks.push(chunk);
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
  };
}

/** The failed fetch a refusal raises, naming what was refused and why. */
function failedFetch(message: string, context: Record<string, unknown>): NaxError {
  return new NaxError(message, FETCH_FAILED, { stage: STAGE, ...context });
}
