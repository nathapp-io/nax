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
 * blanket classification skipped `shouldSwap`'s availability branch and the
 * manager-tier rate-limit backoff, making one transient failure terminal for
 * complete-kind ops (routing, decompose, debate, acceptance-refine).
 */
export function classifyCompleteException(err: unknown): AdapterFailure {
  const message = errorMessage(err).slice(0, 500);

  if (err instanceof NaxError && err.code === "AGENT_TIMEOUT") {
    return { category: "quality", outcome: "fail-timeout", retriable: true, message };
  }

  const parsed = parseAgentError(message);
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
    default:
      return { category: "quality", outcome: "fail-unknown", retriable: false, message };
  }
}
