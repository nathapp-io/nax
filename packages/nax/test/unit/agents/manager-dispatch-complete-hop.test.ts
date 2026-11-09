// test/unit/agents/manager-dispatch-complete-hop.test.ts
/**
 * US-005 (M10): a failed `complete()` hop keeps the spend it already incurred.
 *
 * `dispatchCompleteHop` used to zero `tokenUsage` and `estimatedCostUsd` on
 * every throw, so a timed-out or cancelled complete() hop that had already
 * burned tokens recorded nothing — the failed hop vanished from the cost
 * ledger even though the spend was real. The catch now lifts spend from the
 * error: a `SessionTurnError` carries it directly (BUG-57 slots), and anything
 * else may carry a `FailedTurnSpend` attached by `attachTurnSpend` (the ACP
 * transport attaches it on the timeout path).
 */
import { describe, expect, test } from "bun:test";
import { attachTurnSpend, SessionTurnError } from "@nathapp/nax-agent";
import { dispatchCompleteHop } from "@/agents/manager-dispatch";
import type { CompleteResult } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";
import { NaxError } from "@/errors";

/** A single injected classification, so each case proves the classifier's answer is passed through untouched. */
const CLASSIFIED: AdapterFailure = {
  category: "quality",
  outcome: "fail-unknown",
  retriable: false,
  message: "hop failed",
};

function classify(): AdapterFailure {
  return CLASSIFIED;
}

/** Dispatch a hop whose call always throws `err`. */
function hopThrowing(err: unknown): Promise<{ result: CompleteResult; dispatched: boolean }> {
  return dispatchCompleteHop(async () => {
    throw err;
  }, classify);
}

describe("dispatchCompleteHop — failed hop spend (US-005)", () => {
  test("AC-1: a SessionTurnError's tokenUsage and estimatedCostUsd reach the result, dispatched false", async () => {
    const err = new SessionTurnError("hop failed", false, false, { inputTokens: 100, outputTokens: 20 }, 0.05);

    const { result, dispatched } = await hopThrowing(err);

    expect(dispatched).toBe(false);
    expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.estimatedCostUsd).toBe(0.05);
  });

  test("AC-2: a SessionTurnError's exactCostUsd reaches the result", async () => {
    const err = new SessionTurnError("hop failed", false, false, { inputTokens: 10, outputTokens: 1 }, undefined, 0.07);

    const { result } = await hopThrowing(err);

    expect(result.exactCostUsd).toBe(0.07);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 1 });
  });

  test("AC-3: a 'computed' attached spend becomes an estimate and no exact cost", async () => {
    const err = new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp" });
    attachTurnSpend(err, {
      tokenUsage: { inputTokens: 50, outputTokens: 5 },
      costUsd: 0.02,
      costSource: "computed",
    });

    const { result } = await hopThrowing(err);

    expect(result.tokenUsage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(result.estimatedCostUsd).toBe(0.02);
    expect("exactCostUsd" in result).toBe(false);
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("AC-4: a 'reported' attached spend is both the estimate and the exact cost", async () => {
    const err = new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp" });
    attachTurnSpend(err, {
      tokenUsage: { inputTokens: 50, outputTokens: 5 },
      costUsd: 0.02,
      costSource: "reported",
    });

    const { result } = await hopThrowing(err);

    expect(result.tokenUsage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(result.estimatedCostUsd).toBe(0.02);
    expect(result.exactCostUsd).toBe(0.02);
  });

  test("AC-5: a plain Error keeps zero spend and the injected classification", async () => {
    const { result, dispatched } = await hopThrowing(new Error("no spend anywhere"));

    expect(dispatched).toBe(false);
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.exactCostUsd).toBeUndefined();
    expect(result.adapterFailure).toBe(CLASSIFIED);
  });
});
