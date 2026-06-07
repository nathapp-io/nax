// test/unit/execution/non-blocking-fix-wiring.test.ts
import { describe, expect, test } from "bun:test";
import { shouldRunNonBlockingFix } from "../../../src/execution/non-blocking-fix";

describe("non-blocking-fix wiring gate", () => {
  test("gate is off without config", () => {
    expect(shouldRunNonBlockingFix(undefined, 5)).toBe(false);
  });
  test("gate is on when enabled with advisory findings", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 5),
    ).toBe(true);
  });
  test("gate is off when enabled but zero advisory findings", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "source", regressionAttempts: 1, verifierGuard: false }, 0),
    ).toBe(false);
  });
  test("gate is off when config present but disabled", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true }, 3),
    ).toBe(false);
  });
});
