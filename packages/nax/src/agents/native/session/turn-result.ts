/**
 * The turn's tail: the warnings emitted once the loop has exited, and the
 * `TurnResult` assembled from what the loop accumulated.
 *
 * Extracted from `turn-loop.ts`, which keeps the `saveTranscript` call that
 * sits between the two: a write failure there fails the turn, unlike the
 * best-effort save in the catch, and that distinction belongs with the control
 * flow rather than in a result builder.
 */

import type { InteractionExchange, InvalidToolCallDetail, TurnResult } from "@/agents/session-types";
import { getSafeLogger } from "@/logger";
import type { CodingTool } from "@/tools";
import type { TurnAccumulator } from "./turn-accumulator";
import type { TurnDeps } from "./turn-types";

export interface LogTurnTailWarningsArgs {
  readonly sessionName: string;
  readonly completedNormally: boolean;
  readonly spinStopped: boolean;
  readonly roundTrips: number;
  readonly timedOut: boolean;
  readonly spinBreaker: TurnDeps["spinBreaker"];
  /** The call that tripped the invalid-call budget; absent when it did not trip. */
  readonly invalidCallHalt?: InvalidToolCallDetail;
}

export function logTurnTailWarnings(args: LogTurnTailWarningsArgs): void {
  const { sessionName, completedNormally, spinStopped, roundTrips, timedOut, spinBreaker, invalidCallHalt } = args;

  // Parity with acp/adapter.ts:555, which warns in exactly this situation. A
  // native turn that stops here is indistinguishable from a finished one
  // without this line plus the `turnIncomplete` fact below.
  if (!completedNormally) {
    getSafeLogger()?.warn("native-adapter", "turn ended with tool calls outstanding", {
      sessionName,
      roundTrips,
      timedOut,
      ...(invalidCallHalt !== undefined ? { invalidCallBudgetExceeded: true } : {}),
    });
  }

  if (spinStopped) {
    getSafeLogger()?.error("native-adapter", "turn ended by the spin breaker", {
      sessionName,
      roundTrips,
      ...spinBreaker?.summary(),
    });
  }

  // nax#2200: the budget halt used to leave no trace but the generic line
  // above, so a verifier that lost its verdict to three `refs: null` calls read
  // as a timeout. Name the tool and the property that was rejected.
  if (invalidCallHalt !== undefined) {
    getSafeLogger()?.error("native-adapter", "turn ended by the invalid tool call budget", {
      sessionName,
      roundTrips,
      tool: invalidCallHalt.tool,
      property: invalidCallHalt.property,
      expected: invalidCallHalt.expected,
      actual: invalidCallHalt.actual,
    });
  }
}

export interface BuildTurnResultArgs {
  readonly output: string;
  readonly usage: TurnAccumulator;
  readonly roundTrips: number;
  readonly codingTools: readonly CodingTool[];
  readonly codingToolsCalled: readonly string[];
  readonly completedNormally: boolean;
  readonly timedOut: boolean;
  readonly spinStopped: boolean;
  /** The call that tripped the invalid-call budget; absent when it did not trip. */
  readonly invalidCallHalt: InvalidToolCallDetail | undefined;
  readonly interactions: readonly InteractionExchange[];
  readonly pricingSource: TurnDeps["pricingSource"];
}

export function buildTurnResult(args: BuildTurnResultArgs): TurnResult {
  const {
    output,
    usage,
    roundTrips,
    codingTools,
    codingToolsCalled,
    completedNormally,
    timedOut,
    spinStopped,
    invalidCallHalt,
    interactions,
    pricingSource,
  } = args;

  const rates = usage.rates();
  return {
    output,
    tokenUsage: usage.tokens(),
    estimatedCostUsd: usage.costUsd(),
    internalRoundTrips: roundTrips,
    ...(codingTools.length > 0 ? { codingToolUse: { advertised: codingTools.length, called: codingToolsCalled } } : {}),
    ...(completedNormally ? {} : { turnIncomplete: true }),
    ...(timedOut ? { timedOut: true } : {}),
    ...(spinStopped ? { spinStopped: true as const } : {}),
    ...(invalidCallHalt !== undefined
      ? { invalidCallBudgetExceeded: true as const, invalidToolCall: invalidCallHalt }
      : {}),
    ...(interactions.length > 0 ? { interactions } : {}),
    ...(pricingSource !== undefined ? { pricingSource } : {}),
    ...(rates !== undefined ? { rates } : {}),
  };
}
