/**
 * Mutation classification tests.
 *
 * Covers classifyMutant — interpretation of a VerificationResult.status
 * into a MutantOutcome (killed / survived / errored).
 *
 * Story US-003: TEST_FAILURE is only "killed" when there is evidence
 * tests actually executed. A non-zero exit with no pass/fail counts
 * (compile failure, module-resolution failure, parser miss) is "errored".
 */

import { describe, expect, test } from "bun:test";
import { type VerificationResult, classifyMutant } from "@/verification";

function makeResult(status: VerificationResult["status"]): VerificationResult {
  return {
    status,
    success: status === "SUCCESS",
    countsTowardEscalation: true,
  };
}

describe("classifyMutant — outcomes", () => {
  test("AC1: TEST_FAILURE with passCount 0 / failCount 0 -> errored", () => {
    expect(
      classifyMutant({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        passCount: 0,
        failCount: 0,
      }),
    ).toBe("errored");
  });

  test("AC2: TEST_FAILURE with both counts absent -> errored", () => {
    expect(classifyMutant(makeResult("TEST_FAILURE"))).toBe("errored");
  });

  test("AC3: TEST_FAILURE with passCount 0 / failCount 1 -> killed", () => {
    expect(
      classifyMutant({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        passCount: 0,
        failCount: 1,
      }),
    ).toBe("killed");
  });

  test("AC4: TEST_FAILURE with passCount 5 / failCount 2 -> killed", () => {
    expect(
      classifyMutant({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        passCount: 5,
        failCount: 2,
      }),
    ).toBe("killed");
  });

  test("AC5: SUCCESS -> survived", () => {
    expect(classifyMutant(makeResult("SUCCESS"))).toBe("survived");
  });

  test("AC6: TIMEOUT -> errored", () => {
    expect(classifyMutant(makeResult("TIMEOUT"))).toBe("errored");
  });

  test("AC7: ENVIRONMENTAL_FAILURE -> errored", () => {
    expect(classifyMutant(makeResult("ENVIRONMENTAL_FAILURE"))).toBe("errored");
  });

  test("AC8: ASSET_CHECK_FAILED -> errored", () => {
    expect(classifyMutant(makeResult("ASSET_CHECK_FAILED"))).toBe("errored");
  });
});

describe("classifyMutant — input passthrough", () => {
  test("AC2: TEST_FAILURE with only status populated classifies as errored (no evidence of executed tests)", () => {
    const result = classifyMutant({ status: "TEST_FAILURE", success: false, countsTowardEscalation: false });
    expect(result).toBe("errored");
  });
});
