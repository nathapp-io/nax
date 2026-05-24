import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "../../../src/context/engine";

describe("AdapterFailure.reason field (AC9)", () => {
  test("AdapterFailure accepts optional reason field", () => {
    const f: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "test",
      reason: "empty-output",
    };
    expect(f.reason).toBe("empty-output");
  });

  test("AdapterFailure without reason still compiles and has undefined reason", () => {
    const f: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle watchdog",
    };
    expect(f.reason).toBeUndefined();
  });
});
