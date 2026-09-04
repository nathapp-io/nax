/**
 * nax-ai's typed error kinds mapped to nax's failure taxonomy.
 *
 * nax-ai returns a discriminated kind, so nothing here parses a message. The
 * acpx path has to (parseAgentError); this one must not start.
 *
 * The category split is load-bearing: shouldSwap's fallback branch only accepts
 * "availability", so a kind filed under "quality" is terminal for the op.
 *
 * Reached from `complete()` only. `sendTurn` rethrows nax-ai's error, and the
 * run path reclassifies it generically in build-hop-callback -- so this table
 * does not govern a session turn. See nax#1832.
 */

import type { AdapterFailure } from "@/context/engine";
import { NaxError } from "@/errors";

const FAILURES: Readonly<Record<string, AdapterFailure>> = Object.freeze({
  "rate-limit": {
    message: "nax-ai rate limit exceeded",
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
  },
  auth: {
    message: "nax-ai authentication failed",
    category: "availability",
    outcome: "fail-auth",
    retriable: false,
  },
  overloaded: {
    message: "nax-ai service overloaded",
    category: "availability",
    outcome: "fail-service-down",
    retriable: true,
  },
  // nax-ai already retried transport faults before the first event. Reaching
  // here means the retries were exhausted, so the service is unreachable.
  transport: {
    message: "nax-ai transport retries exhausted; service unreachable",
    category: "availability",
    outcome: "fail-service-down",
    retriable: true,
  },
  // Our request is malformed. A different agent would build the same one.
  "bad-request": {
    message: "request malformed; another agent would build the same one",
    category: "quality",
    outcome: "fail-adapter-error",
    retriable: false,
  },
  // The prompt outgrew the model's window. Filed as "availability" on purpose,
  // even though nothing is down: the request was well-formed, and the thing
  // that could not serve it is this model's window. Another agent's window may
  // be larger, so the swap is worth attempting -- which "quality" would refuse.
  // Not retriable: the same agent would rebuild the same oversized request.
  // Until the native turn loop can compact (nax#1832), the swap is the only
  // recovery there is.
  "context-overflow": {
    message: "prompt exceeded the model's context window; another agent's window may be larger",
    category: "availability",
    outcome: "fail-adapter-error",
    retriable: false,
  },
  unknown: {
    message: "unrecognised nax-ai error kind",
    category: "quality",
    outcome: "fail-unknown",
    retriable: false,
  },
});

const UNKNOWN: AdapterFailure = FAILURES.unknown as AdapterFailure;

/**
 * An unrecognised kind degrades to unknown rather than throwing: a new nax-ai
 * kind should downgrade one call, not crash the run.
 */
export function toAdapterFailure(kind: string): AdapterFailure {
  return FAILURES[kind] ?? UNKNOWN;
}

export class NativeSessionUnsupportedError extends NaxError {
  constructor(method: string) {
    super(
      `The native agent cannot ${method}: it is one-shot until Phase B adds session support. Use an acpx agent for session work.`,
      "NATIVE_SESSION_UNSUPPORTED",
      { stage: "session", method },
    );
    this.name = "NativeSessionUnsupportedError";
  }
}
