/**
 * The spend a failed turn had already incurred, attached to the error it throws
 * (#2367). Keyed on the error's identity, so the error itself is rethrown
 * unchanged and keeps its own code. The facade's turn_end reads it on every
 * error path; the native loop writes it through recordNativeTurnFailureUsage
 * (nax#1840), an ACP backend through attachTurnSpend.
 */
import type { TokenUsage } from "#src/cost/standard-types";
import type { CostSource } from "./agent-session-types.ts";

export interface FailedTurnSpend {
  readonly tokenUsage: TokenUsage;
  readonly costUsd: number;
  readonly costSource?: CostSource;
}

const spendByError = new WeakMap<object, FailedTurnSpend>();

/** Attaches the spend a failed turn had already incurred to the error it throws. */
export function attachTurnSpend(err: object, spend: FailedTurnSpend): void {
  spendByError.set(err, Object.freeze({ ...spend }));
}

/** The spend attached to `err`, if any. */
export function readTurnSpend(err: unknown): FailedTurnSpend | undefined {
  return typeof err === "object" && err !== null ? spendByError.get(err) : undefined;
}
