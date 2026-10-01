/**
 * HTTP-shaped error classification.
 *
 * Kept as pure functions, separate from any call path, for the same reason
 * `usage.ts` is: a hand-written backend classifies the same statuses from a
 * different source and should not carry a second copy of this table.
 */

import type { ProtocolError, ProtocolErrorKind } from "./types.ts";

export function classifyHttpError(status: number | undefined): ProtocolErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  if (status >= 500) return "transport";
  return "unknown";
}

/**
 * Substrings that identify a context-window overflow, lowercased.
 *
 * Taken from provider documentation and error payloads, not from a live
 * capture: a passing test here proves the mapping, never that a given provider
 * still words its message this way. They are upstream wire strings and will
 * drift, which is why they live in one table with a test per phrasing — a
 * reworded message shows up as a failing case rather than as a run that
 * silently gives up on a recoverable fault.
 *
 * Matching is deliberately conservative. An unrecognised 4xx stays
 * `bad-request`: mistaking a genuinely malformed request for an overflow would
 * send a consumer into an endless shorten-and-retry loop.
 */
const CONTEXT_OVERFLOW_MARKERS: readonly string[] = [
  // Generic and OpenAI-compatible
  "context_length_exceeded",
  "context length exceeded",
  "token limit exceeded",
  "maximum context length",
  "exceed context limit",
  "exceeds the context window",
  "model_context_window_exceeded",
  // Anthropic (token overflow, and the 413 request byte-size form)
  "prompt is too long",
  "request_too_large",
  // Amazon Bedrock
  "input is too long",
  // Google Gemini
  "exceeds the maximum number of tokens",
  // Groq
  "reduce the length of the messages",
  // xAI Grok
  "maximum prompt length is",
  // OpenRouter / Poolside
  "maximum allowed input length",
  // Together AI
  "is longer than the model",
  // llama.cpp server
  "exceeds the available context size",
  // LM Studio
  "greater than the context length",
  // GitHub Copilot
  "prompt token count of",
  // MiniMax
  "context window exceeds limit",
  // Kimi For Coding
  "exceeded model token limit",
  // DS4 server
  "the configured context size is",
  // DashScope / Qwen Token Plan
  "range of input length should be",
  // Ollama
  "exceeded max context length",
  // Deliberately broad, and the reason NON_OVERFLOW_MARKERS exists: Bedrock
  // words a throttle as "ThrottlingException: Too many tokens, please wait".
  "too many tokens",
];

/**
 * Substrings that rule a message OUT of `context-overflow`, lowercased,
 * whatever the overflow table says.
 *
 * The overflow table is matched by substring, so a throttling message can
 * satisfy it by accident: Bedrock's "ThrottlingException: Too many tokens,
 * please wait before trying again" contains the `too many tokens` marker
 * verbatim. Classifying that as an overflow would send a consumer off to
 * compact and retry a conversation that was never too large, while the real
 * fault -- a throttle it should have waited out -- goes unreported.
 *
 * Checked before the overflow table, so an exclusion always wins. Status
 * precedence already protects the 429 case; this protects every other status,
 * including the aggregator-relayed 200 of nax#44 and a plain 400.
 */
const NON_OVERFLOW_MARKERS: readonly string[] = [
  "throttlingexception",
  "throttling error",
  "service unavailable",
  "rate limit",
  "rate_limit",
  "too many requests",
];

/**
 * Substrings that identify a mid-stream error carrying policy content,
 * lowercased. Read only for a stream that broke under a non-failing status —
 * see `classifyProviderError`.
 *
 * These exist because §10.1 hands rate-limit and overload capacity to the
 * consumer and forbids retrying them inside nax-ai. Without them, a provider
 * that reports a quota exhaustion mid-stream under a 200 would be filed as
 * `transport` and retried here, which is exactly the policy the spec reserves
 * for the caller. Same caveat as the overflow table above: upstream wire
 * strings, one test per phrasing, drift shows up as a failing case.
 */
const STREAM_POLICY_MARKERS: readonly (readonly [marker: string, kind: ProtocolErrorKind])[] = [
  ["rate limit", "rate-limit"],
  ["rate_limit", "rate-limit"],
  ["too many requests", "rate-limit"],
  ["quota", "rate-limit"],
  ["overloaded", "overloaded"],
];

/** A status that is not itself a report of failure: absent, or below 4xx. */
function isNonFailingStatus(status: number | undefined): boolean {
  return status === undefined || status < 400;
}

/**
 * Classifies a provider error from its status and its upstream message.
 *
 * Separate from `classifyHttpError` rather than folded into it: that function
 * is a pure status table, shared with hand-written backends that may have a
 * status and no message, and widening it with a second input would make every
 * caller supply one. This is the message-aware layer above it.
 *
 * Two refinements, and only these two.
 *
 * `bad-request` is refined to `context-overflow` by message. A status with a
 * verdict of its own keeps it — a 429 mentioning tokens is a rate limit, and
 * the caller should wait rather than compact.
 *
 * A non-failing status is refined to `transport` (nax#1869), unless the
 * message carries policy or overflow content, in which case that refinement
 * takes over — see `classifyBrokenStream`. That refinement, not the status
 * gate, is what decides `context-overflow`: OpenRouter (and other
 * OpenAI-compatible aggregators) answer HTTP 200 and relay an upstream
 * provider's 4xx as a stream `error` event, so a genuine overflow can arrive
 * on a status that is not itself a failure (nax#44). The status is a signal
 * about the envelope, not a gate on what the message is allowed to mean.
 */
export function classifyProviderError(status: number | undefined, message: string | undefined): ProtocolErrorKind {
  const kind = classifyHttpError(status);

  if (isNonFailingStatus(status)) {
    return classifyBrokenStream(message);
  }

  if (kind !== "bad-request" || message === undefined) return kind;

  return matchesContextOverflow(message) ? "context-overflow" : kind;
}

/**
 * Whether a message names a context-window overflow, case-insensitively.
 *
 * An exclusion wins over a marker: see `NON_OVERFLOW_MARKERS` for why the
 * overflow table alone cannot separate a throttle from an overflow.
 */
function matchesContextOverflow(message: string): boolean {
  const haystack = message.toLowerCase();
  if (NON_OVERFLOW_MARKERS.some((marker) => haystack.includes(marker))) return false;
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * The kind for an error event whose status reported no failure: `transport`,
 * unless the message carries policy content nax-ai must not retry itself
 * (checked first, so an established rate-limit/overload phrasing keeps its
 * kind), or names a context overflow (nax#44) — the aggregator-relay shape
 * described on `classifyProviderError`.
 */
function classifyBrokenStream(message: string | undefined): ProtocolErrorKind {
  if (message === undefined) return "transport";
  const haystack = message.toLowerCase();

  const policy = STREAM_POLICY_MARKERS.find(([marker]) => haystack.includes(marker));
  if (policy) return policy[1];

  return matchesContextOverflow(message) ? "context-overflow" : "transport";
}

/**
 * Reads `retry-after` as a delay in seconds.
 *
 * The header may also carry an HTTP-date. That form is deliberately not
 * converted: the conversion depends on clock skew between us and the provider,
 * and a wrong number here would be worse than an absent one, because the
 * consumer owns the retry loop and would sleep on it.
 */
export function parseRetryAfter(headers: Readonly<Record<string, string>> | undefined): number | undefined {
  if (headers === undefined) return undefined;

  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  if (entry === undefined) return undefined;

  const seconds = Number(entry[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}

/**
 * A status carried by a thrown value, when it has one.
 *
 * Provider SDKs are inconsistent about where they put it: some set `status`,
 * some `statusCode`, some hang a whole `response` off the error. Anything
 * else -- a bare Error, a string, undefined -- has no status, which is the
 * case classifyThrown was originally written for.
 */
function thrownStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const it = cause as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = it.status ?? it.statusCode ?? it.response?.status;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Headers carried by a thrown value, in the same two shapes as the status. */
function thrownHeaders(cause: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const it = cause as { headers?: unknown; response?: { headers?: unknown } };
  const raw = it.headers ?? it.response?.headers;
  return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : undefined;
}

/**
 * Normalises an arbitrary thrown value into a `ProtocolError`.
 *
 * A throw carrying an HTTP status is classified from it, exactly as an error
 * event would be, and keeps its `retry-after`. Section 10.1 assigns rate
 * limits and overload capacity to the consumer, and filing a thrown 429 as
 * `transport` handed it to this module's own retry instead -- against that
 * policy, and discarding the provider's recovery time on the way.
 *
 * A throw with NO status stays `transport`: that is the connection reset, DNS
 * failure and immediate socket error this function was written for, where
 * classifyHttpError(undefined) would return "unknown" and the fault genuinely
 * is ours to retry. `cause` is preserved either way.
 */
export function classifyThrown(cause: unknown): ProtocolError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = thrownStatus(cause);
  if (status === undefined) return { kind: "transport", message, cause };

  const retryAfter = parseRetryAfter(thrownHeaders(cause));
  return {
    kind: classifyProviderError(status, message),
    message,
    status,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    cause,
  };
}
