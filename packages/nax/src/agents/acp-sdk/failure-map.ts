/**
 * Backend failure -> SessionTurnError (S4b spec §7.1). The cancel cause is set
 * on the abort reason by whoever aborts, and is never inferred from a stop
 * reason. Every abort uses a fresh reason object, because the backend attaches
 * the failed prompt's spend to the reason it throws (attachTurnSpend keys on it).
 *
 * S4b-2 carries the cancel rows and a fail-adapter-error fallback, the outcome
 * session-run-hop.ts synthesizes for an acpx SessionTurnError today (D2-d); S4b-3 adds
 * the rows keyed by the backend's error codes. A deadline expiry is not a
 * failure: the loop returns TurnResult{ timedOut: true } (§6.2 step 2).
 */
import type { AdapterFailure } from "@nathapp/nax-agent";
import type { RateCard } from "../cost";
import { SessionTurnError } from "../types";
import { failedSpendFields, type Spend } from "./pricing";

const MAX_MESSAGE_CHARS = 500;

/** The idle watchdog's cancel (onActiveCall). */
export class WatchdogCancel extends Error {
  constructor() {
    super("The idle watchdog cancelled the turn");
    this.name = "WatchdogCancel";
  }
}

/** The run's signal, or the session closing, ended the turn. */
export class RunAborted extends Error {
  constructor(cause?: unknown) {
    super("The turn was aborted", { cause });
    this.name = "RunAborted";
  }
}

/** The loop's one deadline expired (§6.2 step 2). */
export class TurnDeadlineExpired extends Error {
  constructor() {
    super("The turn deadline expired");
    this.name = "TurnDeadlineExpired";
  }
}

export interface TurnFailure {
  readonly message: string;
  readonly cancelled: boolean;
  readonly retryable: boolean;
  readonly adapterFailure: AdapterFailure;
}

function capped(text: string): string {
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function failure(
  outcome: AdapterFailure["outcome"],
  message: string,
  flags: { readonly cancelled: boolean; readonly retryable: boolean; readonly reason?: string },
): TurnFailure {
  return {
    message,
    cancelled: flags.cancelled,
    retryable: flags.retryable,
    adapterFailure: {
      category: "availability",
      outcome,
      retriable: flags.retryable,
      message,
      ...(flags.reason === undefined ? {} : { reason: flags.reason }),
    },
  };
}

/** `cause` is the iteration signal's reason when it was aborted, else undefined. */
export function classifyTurnFailure(err: unknown, cause: unknown): TurnFailure {
  if (cause instanceof WatchdogCancel) {
    return failure("fail-stale", cause.message, { cancelled: true, retryable: true, reason: "idle-watchdog" });
  }
  if (cause !== undefined) {
    // A run abort, the session closing, or an abort nax did not label: never retried (§7.1).
    return failure("fail-aborted", "The turn was aborted", { cancelled: true, retryable: false });
  }
  const message = capped(err instanceof Error ? err.message : String(err));
  return failure("fail-adapter-error", message, { cancelled: false, retryable: false });
}

export function turnFailureError(failed: TurnFailure, spend: Spend, rateCard: RateCard): SessionTurnError {
  const fields = failedSpendFields(spend, rateCard);
  return new SessionTurnError(
    failed.message,
    failed.cancelled,
    failed.retryable,
    fields.tokenUsage,
    fields.estimatedCostUsd,
    fields.exactCostUsd,
    fields.pricingSource,
    failed.adapterFailure,
  );
}
