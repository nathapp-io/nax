import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import { errorMessage } from "../utils/errors";
import { parseAgentError } from "./acp";

/**
 * Classify an exception thrown out of `adapter.complete()` into an
 * `AdapterFailure` for `AgentManager.completeWithFallback`'s catch site.
 *
 * Prior behaviour mapped every thrown exception to a blanket
 * `{ category: "quality", outcome: "fail-unknown", retriable: false }` —
 * discarding the classification `parseAgentError` already provides for
 * structured errors (auth, rate-limit, model-not-available) and treating a
 * wall-clock `AGENT_TIMEOUT` the same as a genuinely unknown failure. That
 * blanket classification always failed `shouldSwap`'s availability branch
 * (`category: "quality"` never qualifies unless `fallback.onQualityFailure`
 * is enabled), making one transient failure terminal for complete-kind ops
 * (routing, decompose, debate, acceptance-refine) even when a fallback agent
 * was configured and available.
 *
 * Note: `completeWithFallback` has no rate-limit backoff path — `_retryStrategy`
 * is only consulted from `runWithFallback`. A `fail-rate-limit` classification
 * here still helps (it unlocks agent swap via `shouldSwap`'s availability
 * branch) but does not itself trigger a same-agent backoff-and-retry; without
 * a swap candidate, a rate-limited complete-kind op is still terminal.
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
      return { category: "quality", outcome: "fail-unknown", retriable: false, message };
  }
}
