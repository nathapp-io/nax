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
  "context_length_exceeded",
  "context length exceeded",
  "maximum context length",
  "exceed context limit",
  "prompt is too long",
  "input is too long",
  "exceeds the maximum number of tokens",
  "reduce the length of the messages",
  "too many tokens",
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
 * A non-failing status is refined to `transport` (nax#1869). An error event
 * that arrives under a 200 means the response headers were fine and the stream
 * broke afterwards; that is a transport fault, not the "unknown" the bare
 * status table has to answer. It is the shape OpenRouter's "Upstream idle
 * timeout exceeded" takes, and reading it as unknown cost a real run both its
 * agent swap and nax-ai's own bounded retry, since both key on `transport`.
 * An absent status gets the same answer for consistency with `classifyThrown`,
 * the sibling path for the identical fault. Neither can become
 * `context-overflow`: an overflow always arrives on a failing status, so
 * declining to guess one here still costs nothing.
 */
export function classifyProviderError(status: number | undefined, message: string | undefined): ProtocolErrorKind {
  const kind = classifyHttpError(status);

  if (isNonFailingStatus(status)) {
    return classifyBrokenStream(message);
  }

  if (kind !== "bad-request" || message === undefined) return kind;

  const haystack = message.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => haystack.includes(marker)) ? "context-overflow" : kind;
}

/**
 * The kind for an error event whose status reported no failure: `transport`,
 * unless the message carries policy content nax-ai must not retry itself.
 */
function classifyBrokenStream(message: string | undefined): ProtocolErrorKind {
  if (message === undefined) return "transport";
  const haystack = message.toLowerCase();
  const policy = STREAM_POLICY_MARKERS.find(([marker]) => haystack.includes(marker));
  return policy ? policy[1] : "transport";
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
 * Normalises an arbitrary thrown value (connection reset, DNS failure, an
 * immediate socket error) into a `ProtocolError`.
 *
 * Always classified as "transport": `classifyHttpError(undefined)` would
 * return "unknown", but a throw with no HTTP response is exactly the class
 * of fault §10.1 assigns to nax-ai's own bounded retry, not the consumer's
 * rate-limit/overload policy. `cause` is preserved so the original value is
 * never lost.
 */
export function classifyThrown(cause: unknown): ProtocolError {
  return {
    kind: "transport",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  };
}
