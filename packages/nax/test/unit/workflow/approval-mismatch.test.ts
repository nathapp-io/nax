/** US-009: the one text source for a branch review's verdict mismatch. */
import { describe, expect, test } from "bun:test";
import { _approvalDeps, branchMismatchReasons } from "@/workflow/approval";

const SPEC = "branch review verdict inconsistent: spec fail without a blocking spec finding";
const QUALITY = "branch review verdict inconsistent: quality changes without a blocking finding";

describe("branchMismatchReasons (US-009)", () => {
  test("emits each applicable sentence once, in spec then quality order (AC-14)", () => {
    expect(branchMismatchReasons(["spec"])).toEqual([SPEC]);
    expect(branchMismatchReasons(["quality"])).toEqual([QUALITY]);
    expect(branchMismatchReasons(["quality", "spec"])).toEqual([SPEC, QUALITY]);
    // The same kind twice is one sentence: a ledger line repeats nothing.
    expect(branchMismatchReasons(["quality", "quality", "spec", "spec"])).toEqual([SPEC, QUALITY]);
    expect(branchMismatchReasons([])).toEqual([]);
  });

  test("the injected seam defaults to the shared formatter (AC-15)", () => {
    expect(_approvalDeps.branchMismatchReasons).toBe(branchMismatchReasons);
  });
});
