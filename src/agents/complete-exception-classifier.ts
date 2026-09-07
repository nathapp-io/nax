import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import { errorMessage } from "../utils/errors";
import { parseAgentError } from "./acp";
import { isTransportFailureMessage } from "./transport-failure-message";

/**
 * Classify an exception thrown out of `adapter.complete()` into an
 * `AdapterFailure` for `AgentManager.completeWithFallback`'s catch site.
 *
 * Prior behaviour mapped every thrown exception to a blanket
 * `{ category: "quality", outcome: "fail-unknown", retriable: false }` —
 * discarding the classification `parseAgentError` already provides for
 * structured errors (auth, rate-limit, model-not-available) and treating a
 * wall-clock `AGENT_TIMEOUT` the same as a genuinely unknown failure. That
 * blanket classification always declined the swap: `decideSwap` reads the
 * policy table by outcome (nax#1883), and `fail-unknown` is quality-gated, so
 * it never swapped unless `fallback.onQualityFailure` is enabled — making one
 * transient failure terminal for complete-kind ops (routing, decompose,
 * debate, acceptance-refine) even when a fallback agent was configured and
 * available.
 *
 * `completeWithFallback` and `runWithFallback` share one exhaustion routine
 * (`resolveExhaustion`): a terminal exit backs off per the failure's policy,
 * so a `fail-rate-limit` classification on the complete path sleeps on the
 * provider's delay exactly as it does on the run path.
 */
/** Mirrors the truncation length used by the ACP adapter's own classification (adapter.ts, parse-agent-error.ts). */
const MAX_FAILURE_MESSAGE_CHARS = 500;

export function classifyCompleteException(err: unknown): AdapterFailure {
  const fullMessage = errorMessage(err);
  const message = fullMessage.slice(0, MAX_FAILURE_MESSAGE_CHARS);

  if (err instanceof NaxError && err.code === "AGENT_TIMEOUT") {
    return { category: "quality", outcome: "fail-timeout", retriable: true, message };
  }

  // Classify on the full message, not the truncated one — parseAgentError relies on
  // JSON.parse of the whole string and a balanced-brace scan for embedded JSON, both
  // of which fail silently on a truncated payload. Structured vendor error envelopes
  // routinely exceed MAX_FAILURE_MESSAGE_CHARS.
  const parsed = parseAgentError(fullMessage);
  switch (parsed.type) {
    case "auth":
      return { category: "availability", outcome: "fail-auth", retriable: false, message };
    case "rate-limit":
      return {
        category: "availability",
        outcome: "fail-rate-limit",
        retriable: true,
        message,
        ...(parsed.retryAfterSeconds !== undefined ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}),
      };
    case "model-not-available":
      return { category: "quality", outcome: "fail-adapter-error", retriable: false, message };
    case "timeout":
      return { category: "quality", outcome: "fail-timeout", retriable: true, message };
    case "crash":
      return { category: "quality", outcome: "fail-adapter-error", retriable: false, message };
    default:
      // nax#1869: before falling back to "unknown", ask the one further
      // question parseAgentError will not — is this free text a transport
      // fault? "Unknown" is the verdict decideSwap declines; a transport fault
      // is availability, which swaps to a healthy agent. Asked last, so a
      // structured signal always wins over a phrase.
      //
      // fail-service-down, not fail-timeout: a spent-lane fail-timeout does swap
      // (its cooldown is "none", so the agent survives), and a terminal exit
      // backs off per the failure's policy (terminalBackoff) via
      // resolveExhaustion — neither is the "refused at its first gate" bug this
      // branch originally dodged, but fail-service-down still reads truer for a
      // transport fault and its policy treats it as immediately swappable.
      //
      // Read on the full message for the same reason parseAgentError is — a
      // marker can sit past the truncation point.
      return isTransportFailureMessage(fullMessage)
        ? { category: "availability", outcome: "fail-service-down", retriable: true, message }
        : { category: "quality", outcome: "fail-unknown", retriable: false, message };
  }
}
