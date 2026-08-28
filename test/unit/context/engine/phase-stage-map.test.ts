/**
 * contextStageForOp — nax#1737 Phase B op-name -> context-engine stage-key mapping.
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
 */

import { describe, expect, test } from "bun:test";
import { contextStageForOp } from "@/context/engine/phase-stage-map";

describe("contextStageForOp (nax#1737 Phase B)", () => {
  test.each([
    ["test-writer", true, "tdd-test-writer"],
    ["implementer", true, "tdd-implementer"],
    ["verifier", true, "tdd-verifier"],
    ["semantic-review", true, "review-semantic"],
    ["semantic-review", false, "review-semantic"],
    ["adversarial-review", true, "review-adversarial"],
    ["adversarial-review", false, "review-adversarial"],
    ["rectify", true, "rectify"],
    ["rectify", false, "rectify"],
  ] as const)("maps %s (isThreeSession=%s) -> %s", (opName, isThreeSession, expected) => {
    expect(contextStageForOp(opName, isThreeSession)).toBe(expected);
  });

  test.each([
    ["test-writer", false],
    ["implementer", false],
    ["verifier", false],
  ] as const)("does not map %s when isThreeSession=%s (single-session already correct)", (opName, isThreeSession) => {
    expect(contextStageForOp(opName, isThreeSession)).toBeUndefined();
  });

  test.each([
    ["lint-check", true],
    ["lint-check", false],
    ["full-suite-gate", true],
    ["autofix-implementer", false],
    ["", false],
  ] as const)("returns undefined for unmapped op %s (isThreeSession=%s)", (opName, isThreeSession) => {
    expect(contextStageForOp(opName, isThreeSession)).toBeUndefined();
  });
});
