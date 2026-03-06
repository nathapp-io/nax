// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import {
  makeSkippedResult,
  makePassResult,
  makeFailResult,
  type VerifyResult,
} from "../../../src/verification/orchestrator-types";

describe("makeSkippedResult", () => {
  test("returns SKIPPED success result", () => {
    const r = makeSkippedResult("US-001", "scoped");
    expect(r.success).toBe(true);
    expect(r.status).toBe("SKIPPED");
    expect(r.storyId).toBe("US-001");
    expect(r.strategy).toBe("scoped");
    expect(r.countsTowardEscalation).toBe(false);
    expect(r.failures).toEqual([]);
  });
});

describe("makePassResult", () => {
  test("returns PASS success result", () => {
    const r = makePassResult("US-002", "regression", { passCount: 42, durationMs: 1234 });
    expect(r.success).toBe(true);
    expect(r.status).toBe("PASS");
    expect(r.passCount).toBe(42);
    expect(r.failCount).toBe(0);
    expect(r.totalCount).toBe(42);
    expect(r.durationMs).toBe(1234);
    expect(r.countsTowardEscalation).toBe(false);
  });
});

describe("makeFailResult", () => {
  test("returns failure result with correct totals", () => {
    const r = makeFailResult("US-003", "scoped", "TEST_FAILURE", {
      passCount: 10,
      failCount: 3,
      durationMs: 5000,
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe("TEST_FAILURE");
    expect(r.passCount).toBe(10);
    expect(r.failCount).toBe(3);
    expect(r.totalCount).toBe(13);
    expect(r.countsTowardEscalation).toBe(true);
  });

  test("timeout does not count toward escalation by default when overridden", () => {
    const r = makeFailResult("US-004", "scoped", "TIMEOUT", { countsTowardEscalation: false });
    expect(r.countsTowardEscalation).toBe(false);
  });
});
