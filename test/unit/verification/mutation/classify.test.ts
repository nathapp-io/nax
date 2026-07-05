/**
 * Mutation classification tests.
 *
 * Covers classifyMutant — interpretation of a VerificationResult.status
 * into a MutantOutcome (killed / survived / errored).
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
  test("AC3: TEST_FAILURE -> killed", () => {
    expect(classifyMutant(makeResult("TEST_FAILURE"))).toBe("killed");
  });

  test("AC4: SUCCESS -> survived", () => {
    expect(classifyMutant(makeResult("SUCCESS"))).toBe("survived");
  });

  test("AC5: ENVIRONMENTAL_FAILURE -> errored", () => {
    expect(classifyMutant(makeResult("ENVIRONMENTAL_FAILURE"))).toBe("errored");
  });

  test("AC5: ASSET_CHECK_FAILED -> errored", () => {
    expect(classifyMutant(makeResult("ASSET_CHECK_FAILED"))).toBe("errored");
  });

  test("AC5: TIMEOUT -> errored", () => {
    expect(classifyMutant(makeResult("TIMEOUT"))).toBe("errored");
  });
});

describe("classifyMutant — input passthrough", () => {
  test("AC3: accepts a VerificationResult with only status populated", () => {
    const result = classifyMutant({ status: "TEST_FAILURE", success: false, countsTowardEscalation: false });
    expect(result).toBe("killed");
  });
});
