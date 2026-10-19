import { describe, expect, test } from "bun:test";
import { isGateTimingItem, splitGateTimingItems } from "@/workflow/gate-timing";

// Verbatim reviewer lines from 10-19 run ledgers (oct19-bundle, earlier nax and koda runs).
const TIMING = [
  "Full test suite (bun run test) runs only after this review, so no result exists to check",
  "Repository gates (bun run check:all) run after all stories; not reached for this story",
  "Full test suite (nax runs it after review; scoped story tests run here: 13 pass, 0 fail)",
  "Full package suite (bun run test, 1059 tests per report) and repo gates after review: not reached in this review, pending nax post-review run",
  "repository gates run once every story is done",
  "Full test suite and repository gates after review were never reached in this workflow stage, so not verified here.",
];

const REAL = [
  // Concrete failure evidence about a gate.
  "Coverage gate not verified: report states `bun run test:coverage` exits 1 on pre-existing unrelated test/unit/cli/config-descriptions.test.ts failure",
  "Full test suite: nax runs it after review; in this sandbox the 41 tool-host-dependent tests fail with EPERM on loopback bind",
  "Full test suite including the 16 PG-backed integration ACs under KODA_DB_TESTS=1 has not yet run (nax runs it after this review): this sandbox has no Docker",
  // Coverage is not one of nax's repository gates.
  "Repository gates (check:all, test:coverage) not yet run",
  // No gate named, or no timing reason given.
  "The scoped integration test did not complete: `bun run test:scoped x.spec.ts` failed because no test Postgres was available",
  "Full test suite and repo gates beyond lint+typecheck+scoped tests",
  "CI-only path",
];

describe("isGateTimingItem", () => {
  for (const item of TIMING) {
    test(`a bare 'nax runs this gate later' line is timing: ${item.slice(0, 60)}`, () => {
      expect(isGateTimingItem(item)).toBe(true);
    });
  }
  for (const item of REAL) {
    test(`a line with evidence, coverage or no timing reason is kept: ${item.slice(0, 60)}`, () => {
      expect(isGateTimingItem(item)).toBe(false);
    });
  }
});

describe("splitGateTimingItems", () => {
  test("keeps order and partitions every item", () => {
    const out = splitGateTimingItems([REAL[0] ?? "", TIMING[0] ?? "", "CI-only path"]);
    expect(out.kept).toEqual([REAL[0] ?? "", "CI-only path"]);
    expect(out.dropped).toEqual([TIMING[0] ?? ""]);
  });
});
