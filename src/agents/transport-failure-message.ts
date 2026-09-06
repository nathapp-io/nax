/**
 * Free-text recognition of transport faults, for the errors that arrive with
 * no machine-readable envelope (nax#1869).
 *
 * Deliberately NOT part of `parseAgentError`. That function classifies on
 * structured signals only, and says so: widening it would change the contract
 * every one of its callers reads it under. This is a separate, narrower
 * question asked only after it has already answered "unknown" — is this
 * leftover free text a transport fault, or a genuine unknown?
 *
 * The distinction is load-bearing rather than cosmetic. "Unknown" maps to
 * `quality`/`fail-unknown`, which `decideSwap` declines unless
 * `fallback.onQualityFailure` is set; a transport fault maps to
 * `availability`, which swaps. A real run lost all three of its
 * acceptance-generation calls to OpenRouter's `Upstream idle timeout exceeded`
 * with a healthy fallback model live and never tried.
 *
 * Matching is deliberately conservative, and phrase-shaped rather than
 * word-shaped: a bare "timeout" or "gateway" blocklist would take a model's
 * own prose about those concepts. Like the vendor tables in nax-ai's
 * errors.ts, these are upstream wire strings and will drift — they live in one
 * table with a test per phrasing, so a reworded message shows up as a failing
 * case rather than as a run that quietly gives up on a recoverable fault.
 *
 * A structured provider error never reaches here: parseAgentError classifies
 * it first. So does a typed nax-ai error kind on the native path, which
 * `toAdapterFailure` maps from a discriminated kind and never a message.
 */

/** Lowercased phrases that identify a transport fault. */
const TRANSPORT_FAULT_MARKERS: readonly string[] = [
  // Provider stalled mid-stream. OpenRouter's wording; the shape nax#1869 was filed on.
  "idle timeout exceeded",
  "stream idle timeout",
  "upstream timeout",
  // Gateway and capacity statuses arriving as text rather than as a status
  // field. Matched by their words, not their numbers: a bare "502" would also
  // match a cost, a token count or a line number.
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  // Socket-level faults from the runtime rather than the provider.
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "socket hang up",
  "premature close",
  "terminated: other side closed",
  "network error",
];

/**
 * True when `message` reports a transport fault — one a retry or a swap to a
 * healthy agent could recover.
 */
export function isTransportFailureMessage(message: string): boolean {
  if (!message) return false;
  const haystack = message.toLowerCase();
  return TRANSPORT_FAULT_MARKERS.some((marker) => haystack.includes(marker));
}
