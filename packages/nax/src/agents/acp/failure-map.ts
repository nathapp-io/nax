/**
 * Backend failure -> SessionTurnError (S4b spec §7.1). The cancel cause is set
 * on the abort reason by whoever aborts, and is never inferred from a stop
 * reason. Every abort uses a fresh reason object, because the backend attaches
 * the failed prompt's spend to the reason it throws (attachTurnSpend keys on it).
 *
 * Without an abort cause the row is keyed by the backend's error code (D3-d:
 * session errors are "availability", as session-run-hop.ts synthesizes for an
 * acpx SessionTurnError; capability, stop-reason and unknown rows are "quality").
 * A deadline expiry is not a failure: the loop returns TurnResult{ timedOut: true }.
 */
import type { AdapterFailure } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
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

/** The backend's restore-time not-found patterns (nax-agent-acp errors.ts), applied to a prompt (D3-f). */
const SESSION_NOT_FOUND_TEXT = /session not found|no conversation found/i;
const RESOURCE_NOT_FOUND_RPC_CODE = -32002;

interface Row {
  readonly outcome: AdapterFailure["outcome"];
  readonly category: AdapterFailure["category"];
  readonly retryable: boolean;
}

const SESSION_ERROR: Row = { outcome: "fail-adapter-error", category: "availability", retryable: false };

const ROWS: Readonly<Record<string, Row>> = {
  AGENT_SESSION_AUTH_REQUIRED: { outcome: "fail-auth", category: "availability", retryable: false },
  AGENT_SESSION_RATE_LIMITED: { outcome: "fail-rate-limit", category: "availability", retryable: true },
  AGENT_SESSION_CAPABILITY_UNSUPPORTED: { outcome: "fail-adapter-error", category: "quality", retryable: false },
  AGENT_SESSION_BACKEND_UNAVAILABLE: SESSION_ERROR,
  AGENT_SESSION_TURN_FAILED: SESSION_ERROR,
  AGENT_SESSION_CLOSED: SESSION_ERROR,
  AGENT_SESSION_NOT_FOUND: SESSION_ERROR,
  ACP_STOP_CANCELLED: { outcome: "fail-adapter-error", category: "quality", retryable: false },
  ACP_STOP_MAX_TOKENS: { outcome: "fail-incomplete", category: "quality", retryable: false },
  ACP_STOP_MAX_TURN_REQUESTS: { outcome: "fail-incomplete", category: "quality", retryable: false },
  ACP_STOP_REFUSAL: { outcome: "fail-quality", category: "quality", retryable: false },
};

const UNKNOWN: Row = { outcome: "fail-unknown", category: "quality", retryable: false };

export function codeOf(err: unknown): string | undefined {
  return err instanceof NaxError ? err.code : undefined;
}

export function contextOf(err: unknown): Readonly<Record<string, unknown>> {
  return err instanceof NaxError && err.context !== undefined ? err.context : {};
}

/** The agent no longer knows the session: recover by re-opening fresh (§6.2 step 3.5, D3-f). */
export function isSessionGone(err: unknown): boolean {
  const code = codeOf(err);
  if (code === "AGENT_SESSION_NOT_FOUND") return true;
  if (code !== "AGENT_SESSION_TURN_FAILED" || !(err instanceof Error)) return false;
  return contextOf(err).rpcCode === RESOURCE_NOT_FOUND_RPC_CODE || SESSION_NOT_FOUND_TEXT.test(err.message);
}

function failure(
  row: Row,
  message: string,
  flags: { readonly cancelled: boolean; readonly reason?: string; readonly retryAfterSeconds?: number },
): TurnFailure {
  return {
    message,
    cancelled: flags.cancelled,
    retryable: row.retryable,
    adapterFailure: {
      category: row.category,
      outcome: row.outcome,
      retriable: row.retryable,
      message,
      ...(flags.reason === undefined ? {} : { reason: flags.reason }),
      ...(flags.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: flags.retryAfterSeconds }),
    },
  };
}

function retryAfterOf(err: unknown): number | undefined {
  const value = contextOf(err).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** `cause` is the iteration signal's reason when it was aborted, else undefined. */
export function classifyTurnFailure(err: unknown, cause: unknown): TurnFailure {
  if (cause instanceof WatchdogCancel) {
    return failure({ outcome: "fail-stale", category: "availability", retryable: true }, cause.message, {
      cancelled: true,
      reason: "idle-watchdog",
    });
  }
  if (cause !== undefined) {
    // A run abort, the session closing, or an abort nax did not label: never retried (§7.1, D2-c).
    return failure({ outcome: "fail-aborted", category: "availability", retryable: false }, "The turn was aborted", {
      cancelled: true,
    });
  }
  const code = codeOf(err);
  const row = (code !== undefined && Object.hasOwn(ROWS, code) ? ROWS[code] : undefined) ?? UNKNOWN;
  const message = capped(err instanceof Error ? err.message : String(err));
  const retryAfterSeconds = row.outcome === "fail-rate-limit" ? retryAfterOf(err) : undefined;
  return failure(row, message, { cancelled: false, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
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
