/**
 * nax-ai error kinds to nax's failure taxonomy.
 *
 * Five of seven kinds file "availability". A blanket quality/fail-unknown once
 * made every transient failure terminal for exactly these complete-kind ops;
 * this table is what stops that returning. The category tag is observability
 * only — swap behaviour comes from the policy table by outcome (nax#1883).
 */

import { describe, expect, test } from "bun:test";
import { NativeSessionUnsupportedError, toAdapterFailure } from "@/agents/native/errors";
import { decideSwap } from "@/agents/swap-decision";
import type { AdapterFailure } from "@/context/engine";

const CASES: Array<[kind: string, category: "availability" | "quality", outcome: AdapterFailure["outcome"]]> = [
  ["rate-limit", "availability", "fail-rate-limit"],
  ["auth", "availability", "fail-auth"],
  ["overloaded", "availability", "fail-service-down"],
  ["transport", "availability", "fail-service-down"],
  ["bad-request", "quality", "fail-adapter-error"],
  ["context-overflow", "availability", "fail-adapter-error"],
  ["unknown", "quality", "fail-unknown"],
];

describe("toAdapterFailure", () => {
  test.each(CASES)("maps %s to %s/%s", (kind, category, outcome) => {
    const failure = toAdapterFailure({ kind });
    expect(failure.category).toBe(category);
    expect(failure.outcome).toBe(outcome);
  });

  test("keeps five of seven kinds swappable", () => {
    const kinds = ["rate-limit", "auth", "overloaded", "transport", "bad-request", "context-overflow", "unknown"];
    const availability = kinds.filter((k) => toAdapterFailure({ kind: k }).category === "availability");
    expect(availability).toHaveLength(5);
  });

  test("does not mark an overflow retriable: the same agent would rebuild the same oversized request", () => {
    expect(toAdapterFailure({ kind: "context-overflow" }).retriable).toBe(false);
  });

  test("says the prompt outgrew the window, not that the request was malformed", () => {
    const message = toAdapterFailure({ kind: "context-overflow" }).message;
    expect(message).toContain("context window");
    expect(message).not.toContain("malformed");
  });

  test("treats an unrecognised kind as unknown rather than throwing", () => {
    expect(toAdapterFailure({ kind: "something-new" }).outcome).toBe("fail-unknown");
  });
});

describe("retryAfterSeconds", () => {
  test("carries the provider's retryAfter onto the failure", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
  });

  test("omits the field when the provider supplied none", () => {
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });

  test("carries it for any kind, not just rate-limit", () => {
    expect(toAdapterFailure({ kind: "overloaded", retryAfter: 5 }).retryAfterSeconds).toBe(5);
  });

  test("an unrecognised kind still degrades to unknown, and still carries retryAfter", () => {
    const failure = toAdapterFailure({ kind: "brand-new-kind", retryAfter: 9 });
    expect(failure.outcome).toBe("fail-unknown");
    expect(failure.retryAfterSeconds).toBe(9);
  });

  test("the shared table entries are not mutated across calls", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });
});

/**
 * The mapping only matters through the gate it feeds. Asserting the category
 * string alone would pass even if decideSwap stopped reading it, so both sides
 * are pinned here: an overflow becomes swappable, a malformed request does not.
 */
describe("swap eligibility, through the real gate", () => {
  const fallback = { enabled: true, maxHopsPerStory: 2 };

  test("an overflow is swap-eligible once quality swaps are opted in", () => {
    expect(
      decideSwap(toAdapterFailure({ kind: "context-overflow" }), 0, { ...fallback, onQualityFailure: true }),
    ).toEqual({
      swap: true,
    });
  });

  test("an overflow is declined by default, like any fail-adapter-error", () => {
    expect(decideSwap(toAdapterFailure({ kind: "context-overflow" }), 0, fallback)).toEqual({
      swap: false,
      reason: "quality-failure-declined",
    });
  });

  test("a genuinely malformed request stays declined", () => {
    expect(decideSwap(toAdapterFailure({ kind: "bad-request" }), 0, fallback)).toEqual({
      swap: false,
      reason: "quality-failure-declined",
    });
  });
});

describe("NativeSessionUnsupportedError", () => {
  test("names the method and the phase that will add it", () => {
    const err = new NativeSessionUnsupportedError("openSession");
    expect(err.message).toContain("openSession");
    expect(err.message).toContain("Phase B");
  });
});
