import type { AdapterFailure } from "@/context/engine";

/**
 * A provider capacity refusal returned as ordinary turn output rather than
 * raised as a transport error — e.g. "Selected model is at capacity. Please
 * try a different model." Measured over 4570 review-audit records (nax#1550
 * follow-up, "BUG-62"): 9 of 10 unparseable review give-ups attributed to
 * this exact literal, none were genuine review verdicts.
 */
const PROVIDER_REFUSAL_PATTERN = /model is at capacity/i;

/**
 * Classify a completed turn's output text as a provider refusal. Unlike
 * `parseAgentError`, which classifies structured transport errors, this
 * matches free text — the refusal never reaches the transport layer as an
 * error, it comes back as a normal successful turn. Scoped to the one
 * measured signature to avoid misclassifying genuine review content.
 */
export function classifyProviderRefusalFailure(output: string): AdapterFailure | null {
  const trimmed = output.trim();
  if (!trimmed || !PROVIDER_REFUSAL_PATTERN.test(trimmed)) return null;
  return {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: trimmed.slice(0, 500),
  };
}
