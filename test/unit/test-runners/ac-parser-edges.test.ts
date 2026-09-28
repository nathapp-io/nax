/**
 * ac-parser.ts — characterisation tests for parseTestFailuresDetailed branches
 * nothing pins (the acceptance-stage suites exercise the parseTestFailures
 * wrapper only), written before the complexity drain refactor
 * (docs/plans/STATUS-complexity-drain.md, batch C2). Every assertion below is
 * green against the unrefactored parser; the tests pin behaviour, not
 * implementation.
 */

import { describe, expect, test } from "bun:test";
import { parseTestFailuresDetailed } from "@/test-runners/ac-parser";

describe("parseTestFailuresDetailed — taggedFailureCount (BUG-32)", () => {
  test("counts every tagged failure line, not the deduplicated AC count", () => {
    const output = [
      "  (fail) AC-3: first it() block",
      "  (fail) AC-3: second it() block",
      "  (fail) AC-3: third it() block",
    ].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-3"], taggedFailureCount: 3 });
  });

  test("an overridden AC's raw count exceeds its deduplicated id count", () => {
    const output = ["  (fail) AC-2: case a", "  (fail) AC-2: case b", "  (fail) AC-9: other"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-2", "AC-9"], taggedFailureCount: 3 });
  });

  test("failure lines without an AC tag count nothing", () => {
    const output = ["  (fail) no tag here", "  (fail) AC-4: tagged", "  --- FAIL: TestNoTag"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-4"], taggedFailureCount: 1 });
  });
});

describe("parseTestFailuresDetailed — AC-HOOK sentinel detection", () => {
  test("an unnamed bun failure beside a hook timeout emits AC-HOOK and counts it", () => {
    const output = ["(fail) tests/app.test.ts (unnamed)", "hook timed out after 5000ms"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-HOOK"], taggedFailureCount: 1 });
  });

  test("the 'hook failed' marker also triggers the sentinel", () => {
    const output = ["(fail) (unnamed)", "hook failed in beforeAll"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-HOOK"], taggedFailureCount: 1 });
  });

  test("an unnamed failure without a hook marker emits nothing", () => {
    const output = "(fail) tests/app.test.ts (unnamed)";
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: [], taggedFailureCount: 0 });
  });

  test("a hook marker without an unnamed failure emits nothing", () => {
    const output = "hook timed out after 5000ms";
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: [], taggedFailureCount: 0 });
  });

  test("several unnamed hook-timeout failures emit AC-HOOK exactly once", () => {
    const output = ["(fail) (unnamed) a", "(fail) (unnamed) b", "hook timed out after 5000ms"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-HOOK"], taggedFailureCount: 1 });
  });
});

describe("parseTestFailuresDetailed — framework gating", () => {
  test("a bun-detected output ignores an indented go FAIL marker", () => {
    const output = ["(fail) plain bun failure", "    --- FAIL: TestAC_2_indented (0.00s)"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: [], taggedFailureCount: 0 });
  });

  test("the same go marker extracts AC-2 when no framework is detected", () => {
    const output = "    --- FAIL: TestAC_2_indented (0.00s)";
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-2"], taggedFailureCount: 1 });
  });

  test("a rust-detected output runs no matcher even with bun and go markers present", () => {
    const output = ["test result: FAILED. 0 passed", "(fail) AC-5: bun marker"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: [], taggedFailureCount: 0 });
  });

  test("a mocha-detected output runs no matcher even with a bun marker present", () => {
    const output = ["12 passing", "(fail) AC-6: bun marker"].join("\n");
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: [], taggedFailureCount: 0 });
  });

  test("the bun matcher uppercases a lowercase AC tag", () => {
    const output = "(fail) ac-2: lowercase tag";
    expect(parseTestFailuresDetailed(output)).toEqual({ failedACs: ["AC-2"], taggedFailureCount: 1 });
  });
});
