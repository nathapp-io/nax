/**
 * nax-ai's typed error kinds mapped to nax's failure taxonomy.
 *
 * nax-ai returns a discriminated kind, so nothing here parses a message. The
 * acpx path has to (parseAgentError); this one must not start.
 *
 * `category` is an observability tag only: swap behaviour comes from
 * `failurePolicyFor(outcome)` in `src/agents/retry/failure-policy.ts`, which
 * keys on `outcome` and never reads `category`. A kind filed under "quality" is
 * not automatically terminal for the op — `decideSwap` consults the policy table.
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

/** The shape this module reads off a nax-ai protocol fault. Structural, never the class. */
export interface NativeProtocolError {
  readonly kind: string;
  /** Seconds, when the provider signalled one. */
  readonly retryAfter?: number;
}

/**
 * An unrecognised kind degrades to unknown rather than throwing: a new nax-ai
 * kind should downgrade one call, not crash the run.
 *
 * Takes the whole protocol error, not the bare kind: `retryAfter` is the
 * provider's own recovery time and the retry layers need it. FAILURES is a
 * frozen shared table, so the entry is copied rather than assigned onto.
 */
export function toAdapterFailure(protocolError: NativeProtocolError): AdapterFailure {
  const base = FAILURES[protocolError.kind] ?? UNKNOWN;
  return protocolError.retryAfter === undefined ? base : { ...base, retryAfterSeconds: protocolError.retryAfter };
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
