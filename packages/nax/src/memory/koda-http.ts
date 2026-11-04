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
  post(path: string, body: unknown): Promise<KodaResponse>;
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

/** `text` with every configured header value replaced, so a key cannot travel in an error. */
function redact(text: string, headers: CreateKodaClientInput["headers"]): string {
  let result = text;
  for (const value of Object.values(headers)) {
    if (value.length > 0) result = result.replaceAll(value, REDACTED);
  }
  return result;
}

/** The configured headers plus `accept`; a post adds `content-type` and the JSON-encoded body. */
function buildInit(req: KodaRequest, headers: CreateKodaClientInput["headers"], signal: AbortSignal): RequestInit {
  const sent: Record<string, string> = { ...headers, [ACCEPT_HEADER]: JSON_MEDIA_TYPE };
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

function unreachable(req: KodaRequest, cause: unknown, headers: CreateKodaClientInput["headers"]): NaxError {
  return new NaxError(
    `[memory] koda ${req.method} ${req.path} unreachable: ${redact(errorMessage(cause), headers)}`,
    "MEMORY_KODA_UNREACHABLE",
    { stage: STAGE, method: req.method, path: req.path, cause },
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

/** Issue one request, bounded by a deadline that rejects even when the fetch ignores its signal. */
async function request(input: CreateKodaClientInput, req: KodaRequest): Promise<KodaResponse> {
  const url = buildUrl(input.url, req.path, req.query);
  const cancel = new AbortController();
  const init = buildInit(req, input.headers, cancel.signal);
  // `cancellableDelay` rejects when cancelled; only the expiry branch throws the timeout.
  const expired = cancellableDelay(input.timeoutMs, cancel.signal).then(() => {
    throw timedOut(req, input.timeoutMs);
  });
  expired.catch(() => {});
  try {
    const answer = await Promise.race([_kodaClientDeps.fetch(url, init), expired]);
    return await readAnswer(req, answer, input.headers);
  } catch (error) {
    // A status failure and a bad envelope are already classified; only a transport rejection is unreachable.
    if (error instanceof NaxError) throw error;
    throw unreachable(req, error, input.headers);
  } finally {
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
    post: (path, body) => request(input, { method: "POST", path, body }),
  };
}

/** The HTTP status of a `MEMORY_KODA_HTTP` failure, or `undefined` for any other error. */
export function kodaStatusOf(error: unknown): number | undefined {
  if (!(error instanceof NaxError) || error.code !== "MEMORY_KODA_HTTP") return undefined;
  const status = error.context?.status;
  return typeof status === "number" ? status : undefined;
}
