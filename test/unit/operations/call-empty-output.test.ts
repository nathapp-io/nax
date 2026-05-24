import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "../../../src/context/engine";

// This file covers synthesis logic in sendWithFileOutput (src/operations/call.ts).
// The AC9 tests below are a forward-declaration placeholder — Task 2 adds
// behavioral tests once the synthesis is implemented.
describe("AdapterFailure – optional reason field", () => {
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
