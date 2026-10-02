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

import { NaxError } from "#src/infra/index";
import type { AdapterFailure } from "#src/session/adapter-failure";

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
const CREDENTIAL_FAULT_CODES = new Set([
  "CREDENTIAL_HELPER_FAILED",
  "CREDENTIAL_HELPER_INVALID",
  "CREDENTIAL_CHANGED",
  "CREDENTIAL_FILE_UNREADABLE",
]);
const MAX_CREDENTIAL_CAUSE_LINKS = 8;

/** Finds a known credential-store fault without following an unbounded cause chain. */
export function credentialFaultCode(protocolError: NativeProtocolError): string | undefined {
  let current: unknown = protocolError.cause;
  const seen = new Set<object>();
  for (let link = 0; link < MAX_CREDENTIAL_CAUSE_LINKS; link += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return undefined;
    seen.add(current);
    if (current instanceof NaxError && CREDENTIAL_FAULT_CODES.has(current.code)) return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** The shape this module reads off a nax-ai protocol fault. Structural, never the class. */
export interface NativeProtocolError {
  readonly kind: string;
  /** Seconds, when the provider signalled one. */
  readonly retryAfter?: number;
  readonly cause?: unknown;
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
  const credentialCode = credentialFaultCode(protocolError);
  const base =
    credentialCode === undefined
      ? (FAILURES[protocolError.kind] ?? UNKNOWN)
      : { ...FAILURES.auth, message: `Credential authentication failed: ${credentialCode}` };
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
