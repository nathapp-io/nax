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
import { NaxError } from "@/errors";
import { classifyMutant, type VerificationResult } from "@/verification";

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

  test("TEST_FAILURE with negative counts is not evidence of execution -> errored", () => {
    expect(
      classifyMutant({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        passCount: -1,
        failCount: 2,
      }),
    ).toBe("errored");
  });

  test("TEST_FAILURE with negative passCount and zero failCount -> errored", () => {
    expect(
      classifyMutant({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        passCount: -3,
        failCount: 0,
      }),
    ).toBe("errored");
  });

  test("AC5: SUCCESS with executed tests -> survived", () => {
    expect(
      classifyMutant({
        status: "SUCCESS",
        success: true,
        countsTowardEscalation: true,
        passCount: 3,
        failCount: 0,
      }),
    ).toBe("survived");
  });

  // BUG-13 (nax review 20260829, issue #1207): a scoped command that exits 0
  // having executed ZERO tests must not classify as "survived" — that is the
  // worst possible test-quality verdict, produced by a run that proves
  // nothing. Language-independent cases named in verify-scoped.ts's #1207
  // rationale: Go `[no test files]` on a helper-only file, Mocha on a
  // spec-less mapped `.js` file. Mirrors the TEST_FAILURE arm's
  // hasValidEvidence check (AC1/AC2 above) rather than SUCCESS being
  // unconditional.
  test("BUG-13: SUCCESS with zero executed tests -> errored, not survived", () => {
    expect(classifyMutant(makeResult("SUCCESS"))).toBe("errored");
  });

  test("BUG-13: SUCCESS with passCount 0 / failCount 0 -> errored", () => {
    expect(
      classifyMutant({
        status: "SUCCESS",
        success: true,
        countsTowardEscalation: true,
        passCount: 0,
        failCount: 0,
      }),
    ).toBe("errored");
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

describe("classifyMutant — unhandled status", () => {
  test("throws a tagged NaxError rather than silently classifying", () => {
    // A status outside VerificationStatus can still arrive at runtime — from a
    // plugin-supplied runner, or a fixture written against an older union. The
    // exhaustiveness guard is the backstop, and until #1514 the only thing
    // reaching it was a mutation-check fixture carrying `status: "FAILURE"`,
    // a value that was never a member of the union. Fixing that fixture left
    // this branch uncovered, which is how the gap surfaced.
    //
    // Object.assign rather than a cast: the widened `status` comes from the
    // source literal's inferred type, so the out-of-union value is expressible
    // without an `as` (see .nax/rules/test-ratchets.md).
    const rogue = Object.assign(makeResult("SUCCESS"), { status: "FAILURE" });

    expect(() => classifyMutant(rogue)).toThrow(NaxError);

    try {
      classifyMutant(rogue);
      throw new Error("expected classifyMutant to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      if (err instanceof NaxError) {
        expect(err.code).toBe("MUTATION_UNHANDLED_STATUS");
        expect(err.message).toContain("FAILURE");
        expect(err.context?.stage).toBe("mutation-classify");
      }
    }
  });
});
