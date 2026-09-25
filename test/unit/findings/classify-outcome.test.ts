/**
 * `classifyOutcome` — per-iteration finding outcome classification (ADR-022,
 * nax#2154).
 *
 * nax#2154 adds the `rotated` outcome: every finding in `after` is one that was
 * not present in `before`, so the defect moved rather than converging. The
 * classifier's other precedence rules must survive that addition untouched, and
 * the three import paths (`@/findings/classify-outcome`, `@/findings/cycle`,
 * `@/findings`) must keep agreeing.
 *
 * Baseline precedence cases that predate #2154 stay in `cycle.test.ts`; this
 * file owns the #2154 contract. It lives beside — not inside — the baseline
 * `cycle.test.ts` so that file keeps its size.
 */

import { describe, expect, test } from "bun:test";
import type { Finding, IterationOutcome } from "@/findings";
import { classifyOutcome as classifyFromBarrel } from "@/findings";
import { classifyOutcome as classifyFromModule } from "@/findings/classify-outcome";
import { classifyOutcome as classifyFromCycle } from "@/findings/cycle";
import { makeFinding } from "./_cycle-fixtures";

/** A semantic-review finding in src/a.ts. `rule` is omitted when undefined. */
function semantic(line: number, rule?: string, message = `defect at line ${line}`): Finding {
  return makeFinding({
    source: "semantic-review",
    message,
    file: "src/a.ts",
    line,
    ...(rule === undefined ? {} : { rule }),
  });
}

/** An adversarial-review finding in src/a.ts — a different `source` from {@link semantic}. */
function adversarial(line: number, message = `test gap at line ${line}`): Finding {
  return makeFinding({ source: "adversarial-review", message, file: "src/a.ts", line });
}

/** AC1/AC8 before-set: semantic at 114 (twice, different rules), 121, adversarial at 108. */
function rotationBefore(): Finding[] {
  return [semantic(114, "AC-1"), semantic(114, "AC-2"), semantic(121, "AC-3"), adversarial(108)];
}

/** AC1/AC8 after-set: two semantic findings, both at locations absent from {@link rotationBefore}. */
function rotationAfter(): Finding[] {
  return [semantic(96, "AC-1"), semantic(76, "AC-2")];
}

describe("classifyOutcome — nax#2154 'rotated' outcome", () => {
  test("AC1: four before findings fully replaced by two new semantic findings → 'rotated'", () => {
    const outcome: IterationOutcome = classifyFromModule(rotationBefore(), rotationAfter());
    expect(outcome).toBe("rotated");
  });

  test("AC1 boundary: a single surviving recurrence key withholds 'rotated'", () => {
    // 114/AC-1 persists into after, so the replacement is only partial and the
    // per-source aggregation still decides: 96 is new, 121 was resolved → regressed.
    const before = [semantic(114, "AC-1"), semantic(121, "AC-3"), adversarial(108)];
    const after = [semantic(114, "AC-1"), semantic(96, "AC-2")];
    expect(classifyFromModule(before, after)).toBe("regressed");
  });

  test("AC2: one semantic finding moved from a.ts:10 to a.ts:20 → 'rotated'", () => {
    expect(classifyFromModule([semantic(10)], [semantic(20)])).toBe("rotated");
  });

  test("AC2 boundary: rotation by replacement, not by count — two out, one in → 'rotated'", () => {
    expect(classifyFromModule([semantic(10), semantic(20)], [semantic(30)])).toBe("rotated");
  });

  test("AC3: one key persisting (10,20 → 20,30) → 'regressed', not 'rotated'", () => {
    expect(classifyFromModule([semantic(10), semantic(20)], [semantic(20), semantic(30)])).toBe("regressed");
  });

  test("AC3 boundary: every key persisting → 'unchanged'", () => {
    expect(classifyFromModule([semantic(10), semantic(20)], [semantic(20), semantic(10)])).toBe("unchanged");
  });

  test("AC4: a new source takes precedence over rotation (semantic a.ts:10 → adversarial a.ts:10)", () => {
    expect(classifyFromModule([semantic(10)], [adversarial(10)])).toBe("regressed-different-source");
  });

  test("AC4 boundary: new source plus a fully replaced location is still 'regressed-different-source'", () => {
    expect(classifyFromModule([semantic(10)], [adversarial(30)])).toBe("regressed-different-source");
  });

  test("AC5: same file:line:rule with a different message → 'unchanged' (nax#1581 preserved)", () => {
    const before = [semantic(10, "AC-2", "cannot return X on the failure path")];
    const after = [semantic(10, "AC-2", "violates AC-2 — cannot return X")];
    expect(classifyFromModule(before, after)).toBe("unchanged");
  });

  test("AC5 boundary: a different rule at the same location is a rotation, not a reword", () => {
    expect(classifyFromModule([semantic(10, "AC-2")], [semantic(10, "AC-7")])).toBe("rotated");
  });

  test("AC6: no prior findings and one new finding → 'regressed'", () => {
    expect(classifyFromModule([], [semantic(10)])).toBe("regressed");
  });

  test("AC6 boundary: no prior findings and two new findings → 'regressed', never 'rotated'", () => {
    expect(classifyFromModule([], [semantic(10), adversarial(30)])).toBe("regressed");
  });

  test("AC7: no findings before or after → 'resolved'", () => {
    expect(classifyFromModule([], [])).toBe("resolved");
  });

  test("AC7 boundary: every finding cleared → 'resolved', never 'rotated'", () => {
    expect(classifyFromModule([semantic(10), adversarial(108)], [])).toBe("resolved");
  });
});

describe("classifyOutcome — import-path agreement (nax#2154)", () => {
  test("AC8: cycle.ts and the findings barrel classify the four-to-two rotation like the new module", () => {
    const fromModule = classifyFromModule(rotationBefore(), rotationAfter());
    expect(fromModule).toBe("rotated");
    expect(classifyFromCycle(rotationBefore(), rotationAfter())).toBe(fromModule);
    expect(classifyFromBarrel(rotationBefore(), rotationAfter())).toBe(fromModule);
  });

  test("AC8 boundary: all three import paths agree on a non-rotation outcome too", () => {
    const before = [semantic(10, "AC-2", "one wording")];
    const after = [semantic(10, "AC-2", "another wording")];
    const classify = [classifyFromModule, classifyFromCycle, classifyFromBarrel];
    for (const fn of classify) expect(fn(before, after)).toBe("unchanged");
  });
});
