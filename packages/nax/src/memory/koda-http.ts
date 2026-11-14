/**
 * koda-http.ts — the injectable, bounded, header-safe HTTP client for koda's
 * response envelope.
 *
 * Every path is relative to the configured API root (`memory.koda.url`, which
 * includes koda's global prefix) and every answer is an envelope: `{ ret: 0,
 * data }` on success, `{ ret: <code>, message }` on failure. Application `ret`
 * is never reinterpreted as an HTTP status; only the transport status decides
 * whether a request succeeded.
 *
 * The deadline is a cancellable race rather than only an `AbortSignal`, so a
 * fetch that ignores its signal still rejects inside `timeoutMs`, and the timer
 * is cancelled whichever side wins so nothing stays armed. Header values are
 * never copied into a message, an error context or a log line: a failure is
 * described by its method, path and status, and any configured header value a
 * transport or a koda message happens to echo back is redacted.
 *
 * Internal to `src/memory/`: the host composes it, the barrel re-exports it.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { cancellableDelay } from "@/utils/bun-deps";

const STAGE = "memory";
const ACCEPT_HEADER = "accept";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_MEDIA_TYPE = "application/json";
/** Stands in for a configured header value a transport or an answer echoes back. */
const REDACTED = "[redacted]";
/**
 * A configured header value is split on whitespace so a credential is redacted
 * even when the message omits its scheme (`invalid key <token>`): everything
 * after the scheme word is treated as the secret. A value with no whitespace is
 * its own secret, so an answer echoing it alone is still covered.
 */
const SECRET_TOKEN_SEPARATOR = /\s+/;
/** Characters of a rejection's text kept in the redacted stand-in. */
const MAX_CAUSE_TEXT_CHARS = 500;

/** The deadline every host builds its client with: 4 s, well under sync's 10 s per-operation race. */
export const MEMORY_KODA_REQUEST_TIMEOUT_MS = 4000;

/** One koda answer: the transport status and the envelope's `data`. */
export interface KodaResponse {
  readonly status: number;
  readonly data: unknown;
}

/** The two calls the provider makes; both throw `NaxError` on any failure. */
export interface KodaClient {
  get(path: string, query?: Readonly<Record<string, string | number | undefined>>): Promise<KodaResponse>;
  /**
   * A post, optionally cancelled by the caller's own signal — the turn's, in the
   * flow create. Without one the deadline is the only bound.
   */
  post(path: string, body: unknown, opts?: { readonly signal?: AbortSignal }): Promise<KodaResponse>;
}

/** What the host passes to `createKodaClient`. */
export interface CreateKodaClientInput {
  /** The API root including koda's global prefix, e.g. `https://koda.example/api`. */
  readonly url: string;
  /** Headers sent with every request — never logged, never included in an error. */
  readonly headers: Readonly<Record<string, string>>;
  /** Ceiling on one request, until the whole call rejects. */
  readonly timeoutMs: number;
}

/**
 * The transport seam. `fetch` is the only external call this module makes, and
 * a test needs to drive a rejection, a never-settling promise and a status the
 * network will not produce on demand.
 */
export const _kodaClientDeps: { fetch: (input: string, init: RequestInit) => Promise<Response> } = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** One request to issue: its verb, its path relative to the API root, and its payload. */
interface KodaRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `base` without its trailing slashes, then `/`, then `path`, then the defined query keys. */
function buildUrl(base: string, path: string, query?: KodaRequest["query"]): string {
  const url = `${base.replace(/\/+$/, "")}/${path}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  return search === "" ? url : `${url}?${search}`;
}

/**
 * The configured headers with HTTP's case-insensitive names folded to lowercase,
 * so a configured `Accept` cannot survive beside the required `accept` and make
 * fetch send two conflicting values.
 */
function normalizedHeaders(headers: CreateKodaClientInput["headers"]): Record<string, string> {
  const folded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) folded[name.toLowerCase()] = value;
  return folded;
}

/**
 * Every string no message may repeat: each header value whole, and — for a
 * scheme-prefixed credential such as `Bearer <key>` — each token after the
 * scheme, so an answer that names only the key is still covered.
 */
function secretsOf(headers: CreateKodaClientInput["headers"]): readonly string[] {
  const secrets: string[] = [];
  for (const value of Object.values(headers)) {
    if (value.length === 0) continue;
    secrets.push(value);
    const tokens = value.split(SECRET_TOKEN_SEPARATOR).filter((token) => token.length > 0);
    for (const token of tokens.slice(1)) {
      if (token !== value) secrets.push(token);
    }
  }
  return secrets;
}

/** True when `text` repeats a configured header value, whole or as the credential part of one. */
function carriesSecret(text: string, headers: CreateKodaClientInput["headers"]): boolean {
  return secretsOf(headers).some((secret) => text.includes(secret));
}

/** `text` with every configured header value — and the credential part of each — replaced. */
function redact(text: string, headers: CreateKodaClientInput["headers"]): string {
  let result = text;
  for (const secret of secretsOf(headers)) result = result.replaceAll(secret, REDACTED);
  return result;
}

function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // A circular or otherwise unserialisable value has no JSON form; the caller falls back to String().
    return undefined;
  }
}

/** A bounded text form of a rejection, used only to decide whether it carries a header value. */
function causeText(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) {
    // JSON.stringify sees an Error's enumerable own properties only — the ones a transport attaches.
    const own = jsonText(cause);
    const extras = own === undefined || own === "{}" ? "" : ` ${own}`;
    return `${cause.name}: ${cause.message}${extras}`;
  }
  return jsonText(cause) ?? String(cause);
}

/**
 * The rejection itself, or a redacted stand-in when it repeats a configured
 * header value. Context stays useful for a safe cause — a caller can still tell
 * a dropped socket from a DNS failure by identity — while a transport that
 * quotes the key cannot smuggle it into a log line through `context.cause`.
 *
 * Every string the stand-in carries is redacted, `type` included: an `Error`'s
 * name is transport-supplied text like its message, so a transport that names
 * itself after the credential must not reappear there either.
 */
function safeCause(cause: unknown, headers: CreateKodaClientInput["headers"]): unknown {
  const text = causeText(cause);
  if (!carriesSecret(text, headers)) return cause;
  const kind = cause instanceof Error ? cause.name : typeof cause;
  return {
    redacted: true,
    type: redact(kind, headers),
    detail: redact(text.slice(0, MAX_CAUSE_TEXT_CHARS), headers),
  };
}

/** The configured headers plus `accept`; a post adds `content-type` and the JSON-encoded body. */
function buildInit(req: KodaRequest, headers: CreateKodaClientInput["headers"], signal: AbortSignal): RequestInit {
  const sent: Record<string, string> = { ...normalizedHeaders(headers), [ACCEPT_HEADER]: JSON_MEDIA_TYPE };
  if (req.method !== "POST") return { method: req.method, headers: sent, signal };
  return {
    method: req.method,
    headers: { ...sent, [CONTENT_TYPE_HEADER]: JSON_MEDIA_TYPE },
    signal,
    body: JSON.stringify(req.body),
  };
}

function timedOut(req: KodaRequest, timeoutMs: number): NaxError {
  return new NaxError(`[memory] koda ${req.method} ${req.path} timed out after ${timeoutMs}ms`, "MEMORY_KODA_TIMEOUT", {
    stage: STAGE,
    method: req.method,
    path: req.path,
    timeoutMs,
  });
}

/** The caller's own cancellation ended the call before koda answered it. */
function aborted(req: KodaRequest): NaxError {
  return new NaxError(
    `[memory] koda ${req.method} ${req.path} was cancelled before it answered`,
    "MEMORY_KODA_ABORTED",
    { stage: STAGE, method: req.method, path: req.path },
  );
}

/**
 * A promise that rejects the moment the caller's signal aborts, so a fetch that
 * ignores its own signal still cannot outlive the cancellation. The race it joins
 * holds a handler on it for good, so an abort after the call settled is silent.
 */
function cancelledByCaller(req: KodaRequest, signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(aborted(req)), { once: true });
  });
}

/** Whether the caller cancelled. Read through a call so an earlier check cannot narrow a later one. */
function cancelledBy(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Every promise the call races: its own exchange, its deadline, and the caller's cancellation. */
function racingOn(
  req: KodaRequest,
  signal: AbortSignal | undefined,
  exchange: Promise<KodaResponse>,
  expired: Promise<never>,
): Promise<KodaResponse>[] {
  return signal === undefined ? [exchange, expired] : [exchange, expired, cancelledByCaller(req, signal)];
}

function unreachable(req: KodaRequest, cause: unknown, headers: CreateKodaClientInput["headers"]): NaxError {
  return new NaxError(
    `[memory] koda ${req.method} ${req.path} unreachable: ${redact(errorMessage(cause), headers)}`,
    "MEMORY_KODA_UNREACHABLE",
    { stage: STAGE, method: req.method, path: req.path, cause: safeCause(cause, headers) },
  );
}

function badResponse(req: KodaRequest, status: number): NaxError {
  return new NaxError(
    `[memory] koda ${req.method} ${req.path} answered ${status} with a body that is not JSON`,
    "MEMORY_KODA_BAD_RESPONSE",
    { stage: STAGE, method: req.method, path: req.path, status },
  );
}

/** The body's `message` when it is a string, else the response's status text. */
function failureMessage(answer: Response, parsed: unknown, headers: CreateKodaClientInput["headers"]): string {
  const kodaMessage = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : undefined;
  const tail = kodaMessage ?? (answer.statusText.length > 0 ? answer.statusText : `status ${answer.status}`);
  return redact(tail, headers);
}

/** A body that parsed, or the fact that it did not — the two arms a caller must tell apart. */
type ParsedBody = { readonly parsed: true; readonly value: unknown } | { readonly parsed: false };

function parseBody(text: string): ParsedBody {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    // A non-2xx answer is described by its status text; only a 2xx one is a bad response.
    return { parsed: false };
  }
}

function httpFailure(
  req: KodaRequest,
  answer: Response,
  parsed: unknown,
  headers: CreateKodaClientInput["headers"],
): NaxError {
  return new NaxError(
    `[memory] koda ${req.method} ${req.path} answered ${answer.status}: ${failureMessage(answer, parsed, headers)}`,
    "MEMORY_KODA_HTTP",
    { stage: STAGE, method: req.method, path: req.path, status: answer.status },
  );
}

/** Read one answer: a non-2xx status fails, and so does a 2xx body that is not JSON. */
async function readAnswer(
  req: KodaRequest,
  answer: Response,
  headers: CreateKodaClientInput["headers"],
): Promise<KodaResponse> {
  const body = parseBody(await answer.text());
  if (!answer.ok) throw httpFailure(req, answer, body.parsed ? body.value : undefined, headers);
  if (!body.parsed) throw badResponse(req, answer.status);
  return { status: answer.status, data: isRecord(body.value) ? body.value.data : undefined };
}

/** Issue the request and read its answer whole, so the deadline covers receiving the body too. */
async function perform(
  req: KodaRequest,
  url: string,
  init: RequestInit,
  headers: CreateKodaClientInput["headers"],
): Promise<KodaResponse> {
  const answer = await _kodaClientDeps.fetch(url, init);
  return await readAnswer(req, answer, headers);
}

/** Issue one request, bounded by a deadline that rejects even when the fetch ignores its signal. */
async function request(input: CreateKodaClientInput, req: KodaRequest, signal?: AbortSignal): Promise<KodaResponse> {
  // A call whose turn is already cancelled never reaches the network at all.
  if (cancelledBy(signal)) throw aborted(req);
  const url = buildUrl(input.url, req.path, req.query);
  const cancel = new AbortController();
  const init = buildInit(req, input.headers, cancel.signal);
  // `cancellableDelay` rejects when cancelled; only the expiry branch throws the timeout.
  const expired = cancellableDelay(input.timeoutMs, cancel.signal).then(() => {
    throw timedOut(req, input.timeoutMs);
  });
  expired.catch(() => {});
  // The caller's cancellation aborts the exchange through the same controller the
  // deadline uses, so the fetch and its body read are released rather than left running.
  const cancelOn = () => cancel.abort();
  signal?.addEventListener("abort", cancelOn, { once: true });
  try {
    // The whole exchange is raced, not just the header receipt: a body that never
    // finishes arriving must end the call too, and the abort below is what releases it.
    return await Promise.race(racingOn(req, signal, perform(req, url, init, input.headers), expired));
  } catch (error) {
    // A transport that reported the abort is still the cancellation, not an unreachable host.
    if (cancelledBy(signal)) throw aborted(req);
    // A status failure and a bad envelope are already classified; only a transport rejection is unreachable.
    if (error instanceof NaxError) throw error;
    throw unreachable(req, error, input.headers);
  } finally {
    signal?.removeEventListener("abort", cancelOn);
    cancel.abort();
  }
}

/**
 * Create the client for one koda API root.
 *
 * @param input - The API root, the headers sent with every request and the per-request ceiling
 */
export function createKodaClient(input: CreateKodaClientInput): KodaClient {
  return {
    get: (path, query) => request(input, { method: "GET", path, query }),
    post: (path, body, opts) => request(input, { method: "POST", path, body }, opts?.signal),
  };
}

/** The HTTP status of a `MEMORY_KODA_HTTP` failure, or `undefined` for any other error. */
export function kodaStatusOf(error: unknown): number | undefined {
  if (!(error instanceof NaxError) || error.code !== "MEMORY_KODA_HTTP") return undefined;
  const status = error.context?.status;
  return typeof status === "number" ? status : undefined;
}
