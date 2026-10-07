import { describe, expect, test } from "bun:test";
import { attachTurnSpend, readTurnSpend } from "@nathapp/nax-agent";
import { readNativeTurnFailureUsage, recordNativeTurnFailureUsage } from "#src/native/session/turn-types";

const SPEND = { tokenUsage: { inputTokens: 4, outputTokens: 5 }, costUsd: 0.0133, costSource: "reported" } as const;

describe("turn spend attached to a failed turn's error", () => {
  test("round trip: the spend comes back for the same error object, frozen", () => {
    const err = new Error("stopped");
    attachTurnSpend(err, SPEND);
    expect(readTurnSpend(err)).toEqual(SPEND);
    expect(Object.isFrozen(readTurnSpend(err))).toBe(true);
  });

  test("nothing for another error, a primitive, null or undefined", () => {
    attachTurnSpend(new Error("a"), SPEND);
    expect(readTurnSpend(new Error("b"))).toBeUndefined();
    expect(readTurnSpend("boom")).toBeUndefined();
    expect(readTurnSpend(null)).toBeUndefined();
    expect(readTurnSpend(undefined)).toBeUndefined();
  });

  test("a later attach replaces the earlier one", () => {
    const err = new Error("x");
    attachTurnSpend(err, SPEND);
    attachTurnSpend(err, { tokenUsage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
    expect(readTurnSpend(err)).toEqual({ tokenUsage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
  });

  test("the native wrappers share the same ledger", () => {
    const native = new Error("native");
    recordNativeTurnFailureUsage(native, { tokenUsage: { inputTokens: 2, outputTokens: 3 }, costUsd: 0.5 });
    expect(readTurnSpend(native)).toEqual({ tokenUsage: { inputTokens: 2, outputTokens: 3 }, costUsd: 0.5 });
    const acp = new Error("acp");
    attachTurnSpend(acp, SPEND);
    expect(readNativeTurnFailureUsage(acp)).toEqual({ tokenUsage: SPEND.tokenUsage, costUsd: SPEND.costUsd });
  });
});
