/**
 * contextStageForOp — nax#1737 Phase B op-name -> context-engine stage-key mapping,
 * extended by the Phase B follow-up (nax#1737 Phase B2) with a rectification branch.
 *
 * `runPhase` (src/execution/story-orchestrator/run-phase.ts) is the single
 * dispatch seam for both the CANONICAL_ORDER phases and the rectification fix
 * cycle. This mapping tells it which context-engine stage config (declared in
 * stage-config.ts's STAGE_CONTEXT_MAP) applies to a given op, so it can
 * request a bundle assembled for that stage instead of reusing whatever
 * bundle Phase A already put on ctx.contextBundle.
 *
 * The three TDD op names are gated on `isThreeSession` because the same op
 * names (`test-writer`, `implementer`, `verifier`) also run under
 * single-session strategies, where the execution-stage bundle is already the
 * right one and must not be overridden.
 *
 * `inRectification` is consulted FIRST and takes precedence over the
 * three-session branch: inside the fix cycle, `implementer` is doing
 * rectification work and needs `rectify`'s query_scratch, not `tdd-implementer`.
 */

import { describe, expect, test } from "bun:test";
import { contextStageForOp } from "@/context/engine/phase-stage-map";

describe("contextStageForOp (nax#1737 Phase B)", () => {
  test.each([
    ["test-writer", { isThreeSession: true }, "tdd-test-writer"],
    ["implementer", { isThreeSession: true }, "tdd-implementer"],
    ["verifier", { isThreeSession: true }, "tdd-verifier"],
    ["semantic-review", { isThreeSession: true }, "review-semantic"],
    ["semantic-review", { isThreeSession: false }, "review-semantic"],
    ["adversarial-review", { isThreeSession: true }, "review-adversarial"],
    ["adversarial-review", { isThreeSession: false }, "review-adversarial"],
    ["rectify", { isThreeSession: true }, "rectify"],
    ["rectify", { isThreeSession: false }, "rectify"],
  ] as const)("maps %s (%p) -> %s", (opName, opts, expected) => {
    expect(contextStageForOp(opName, opts)).toBe(expected);
  });

  test.each([
    ["test-writer", { isThreeSession: false }],
    ["implementer", { isThreeSession: false }],
    ["verifier", { isThreeSession: false }],
  ] as const)("does not map %s when isThreeSession=false (single-session already correct)", (opName, opts) => {
    expect(contextStageForOp(opName, opts)).toBeUndefined();
  });

  test.each([
    ["lint-check", { isThreeSession: true }],
    ["lint-check", { isThreeSession: false }],
    ["full-suite-gate", { isThreeSession: true }],
    ["", { isThreeSession: false }],
  ] as const)("returns undefined for unmapped op %s (%p)", (opName, opts) => {
    expect(contextStageForOp(opName, opts)).toBeUndefined();
  });

  test("no opts argument behaves as isThreeSession=false, inRectification=false", () => {
    expect(contextStageForOp("implementer", {})).toBeUndefined();
    expect(contextStageForOp("rectify", {})).toBe("rectify");
  });
});

describe("contextStageForOp — inRectification branch (nax#1737 Phase B2)", () => {
  test.each([
    ["autofix-implementer", "rectify"],
    ["full-suite-rectify", "rectify"],
    ["repo-scoped-test-fix", "rectify"],
    ["implementer", "rectify"],
  ] as const)("maps %s -> %s under inRectification", (opName, expected) => {
    expect(contextStageForOp(opName, { inRectification: true })).toBe(expected);
  });

  test("inRectification takes precedence over the three-session branch for implementer", () => {
    // Without the precedence rule this would resolve to tdd-implementer.
    expect(contextStageForOp("implementer", { inRectification: true, isThreeSession: true })).toBe("rectify");
  });

  test.each([["mechanical-lintfix"], ["mechanical-formatfix"], ["autofix-test-writer"]] as const)(
    "%s stays unmapped under inRectification (deliberately deferred/inert)",
    (opName) => {
      expect(contextStageForOp(opName, { inRectification: true })).toBeUndefined();
    },
  );

  test("rectify still maps to rectify under inRectification (retained though currently dead)", () => {
    expect(contextStageForOp("rectify", { inRectification: true })).toBe("rectify");
  });

  test("an op unmapped in rectification falls through to the unconditional map", () => {
    expect(contextStageForOp("semantic-review", { inRectification: true })).toBe("review-semantic");
  });

  test("inRectification=false does not apply the rectification map to autofix-implementer", () => {
    expect(contextStageForOp("autofix-implementer", { inRectification: false })).toBeUndefined();
  });
});
