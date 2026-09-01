/**
 * nax-ai error kinds to nax's failure taxonomy.
 *
 * Four of six kinds must be "availability", because that is the only category
 * shouldSwap's fallback branch accepts. A blanket quality/fail-unknown once
 * made every transient failure terminal for exactly these complete-kind ops;
 * this table is what stops that returning.
 */

import { describe, expect, test } from "bun:test";
import { NativeSessionUnsupportedError, toAdapterFailure } from "@/agents/native/errors";
import type { AdapterFailure } from "@/context/engine";

const CASES: Array<[kind: string, category: "availability" | "quality", outcome: AdapterFailure["outcome"]]> = [
  ["rate-limit", "availability", "fail-rate-limit"],
  ["auth", "availability", "fail-auth"],
  ["overloaded", "availability", "fail-service-down"],
  ["transport", "availability", "fail-service-down"],
  ["bad-request", "quality", "fail-adapter-error"],
  ["unknown", "quality", "fail-unknown"],
];

describe("toAdapterFailure", () => {
  test.each(CASES)("maps %s to %s/%s", (kind, category, outcome) => {
    const failure = toAdapterFailure(kind);
    expect(failure.category).toBe(category);
    expect(failure.outcome).toBe(outcome);
  });

  test("keeps four of six kinds swappable", () => {
    const kinds = ["rate-limit", "auth", "overloaded", "transport", "bad-request", "unknown"];
    const availability = kinds.filter((k) => toAdapterFailure(k).category === "availability");
    expect(availability).toHaveLength(4);
  });

  test("treats an unrecognised kind as unknown rather than throwing", () => {
    expect(toAdapterFailure("something-new").outcome).toBe("fail-unknown");
  });
});

describe("NativeSessionUnsupportedError", () => {
  test("names the method and the phase that will add it", () => {
    const err = new NativeSessionUnsupportedError("openSession");
    expect(err.message).toContain("openSession");
    expect(err.message).toContain("Phase B");
  });
});
