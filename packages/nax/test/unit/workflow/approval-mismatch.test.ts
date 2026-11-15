/** US-009/US-010: the one text source for a branch review's verdict mismatch, and the readiness it holds. */
import { describe, expect, test } from "bun:test";
import {
  _approvalDeps,
  branchMismatchReasons,
  featurePassed,
  type ReadinessFacts,
  readinessReasons,
} from "@/workflow/approval";
import { newFeatureRecord } from "@/workflow/feature-record";
import { buildVerdict } from "@/workflow/open-items";
import type { StorySummary, WorkflowFeatureRecord } from "@/workflow/types";

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

/** A story that finished: nothing about it holds readiness. */
const done = (id: string): StorySummary => ({
  id,
  title: id,
  state: "complete",
  rounds: 0,
  unreviewed: false,
  flagged: 0,
});

/** Every deterministic condition holds, so the mismatch is the only fact in play. */
const READY: ReadinessFacts = {
  finalGates: { ran: ["build", "test"], failing: [] },
  ci: "green",
  stories: [done("US-001")],
  flagged: 0,
  branchReviewRan: true,
};

describe("readinessReasons — branch verdict mismatch (US-010)", () => {
  test("AC-1: a persisted spec mismatch is a readiness reason", () => {
    expect(readinessReasons({ ...READY, branchReviewMismatch: ["spec"] })).toEqual([SPEC]);
  });

  test("AC-2: a persisted quality mismatch is a readiness reason", () => {
    expect(readinessReasons({ ...READY, branchReviewMismatch: ["quality"] })).toEqual([QUALITY]);
  });

  test("AC-3: both kinds read spec then quality, once each", () => {
    expect(readinessReasons({ ...READY, branchReviewMismatch: ["quality", "spec"] })).toEqual([SPEC, QUALITY]);
    expect(readinessReasons({ ...READY, branchReviewMismatch: ["spec", "quality", "spec"] })).toEqual([SPEC, QUALITY]);
  });

  // AC-4: a mismatch explains nothing else, so every independent reason stays exactly where it was.
  test("AC-4: independent unread, gate, CI, skipped-review and story reasons survive beside it", () => {
    const reasons = readinessReasons({
      ...READY,
      finalGates: { ran: ["build"], failing: ["build"] },
      ci: "failed",
      stories: [done("US-001"), { ...done("US-002"), state: "not-run" }],
      branchReviewUnread: ["src/a.ts"],
      reReviewSkipped: true,
      branchReviewMismatch: ["spec", "quality"],
    });
    expect(reasons).toEqual([
      "gates red: build",
      "CI failed",
      "stories not run: US-002",
      "branch review did not read 1 changed file(s): src/a.ts",
      SPEC,
      QUALITY,
      "branch re-review did not run: the fix commits are unreviewed",
    ]);
  });

  test("no persisted mismatch and an empty kind list both add no reason", () => {
    expect(readinessReasons(READY)).toEqual([]);
    expect(readinessReasons({ ...READY, branchReviewMismatch: [] })).toEqual([]);
  });

  // AC-15: a mismatch is readiness evidence only — it never claims the tests or the stories failed.
  test("AC-15: mismatch-only readiness leaves featurePassed true", () => {
    const facts: ReadinessFacts = { ...READY, branchReviewMismatch: ["spec", "quality"] };
    expect(readinessReasons(facts)).toEqual([SPEC, QUALITY]);
    expect(featurePassed(facts)).toBe(true);
    expect(featurePassed(facts)).toBe(featurePassed(READY));
    // `RunResult.success` reads `isComplete(prd) && !pluginGateFailed && workflowPassed !== false`, and
    // `workflowPassed` is the record's own `passed`/verdict — never the readiness list. Both stay true.
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      passed: featurePassed(facts),
      outcome: "draft",
      reviewRan: true,
      finalGates: facts.finalGates,
      reviewMismatch: { kinds: ["spec", "quality"] },
      reasons: readinessReasons(facts),
    };
    expect(buildVerdict(record)?.workflowPassed).toBe(true);
  });
});
