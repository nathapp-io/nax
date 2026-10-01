/**
 * classifyMissingReviewPhases — #1666 Part A.
 *
 * Pure classification: distinguishes a required review phase missing because an
 * upstream phase failure short-circuited the main phase loop (this issue) from
 * one missing because the post-rectification resume loop itself broke at a
 * still-red full-suite-gate (US-002, unaffected by this change).
 */
import { describe, expect, test } from "bun:test";
import { classifyMissingReviewPhases } from "@/execution/story-orchestrator";

describe("classifyMissingReviewPhases", () => {
  test("no missing review phases -> not short-circuited, nothing to append", () => {
    const report = classifyMissingReviewPhases({
      storyId: "US-1",
      packageDir: "/tmp",
      missingRequiredReviewPhases: [],
      shortCircuitPhase: "lint-check",
      resumeLoopEligible: false,
    });
    expect(report.upstreamShortCircuited).toBe(false);
    expect(report.failedPhaseEntries).toEqual([]);
  });

  test("upstream short-circuit: shortCircuitPhase set + resume loop never ran -> classified as short-circuited, entries suppressed", () => {
    const report = classifyMissingReviewPhases({
      storyId: "US-2",
      packageDir: "/tmp",
      missingRequiredReviewPhases: ["semantic-review", "adversarial-review"],
      shortCircuitPhase: "lint-check",
      resumeLoopEligible: false,
    });
    expect(report.upstreamShortCircuited).toBe(true);
    // Not reported as independent "(never ran)" failedPhases entries — the
    // originating phase (lint-check) already reports this via its own entry.
    expect(report.failedPhaseEntries).toEqual([]);
  });

  test("US-002 case: resume loop ran (resumeLoopEligible=true) -> NOT classified as short-circuited, existing '(never ran)' reporting preserved", () => {
    const report = classifyMissingReviewPhases({
      storyId: "US-3",
      packageDir: "/tmp",
      missingRequiredReviewPhases: ["semantic-review", "adversarial-review"],
      shortCircuitPhase: "full-suite-gate",
      resumeLoopEligible: true,
    });
    expect(report.upstreamShortCircuited).toBe(false);
    expect(report.failedPhaseEntries).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("no shortCircuitPhase recorded (main loop never broke) -> NOT classified as short-circuited even if phases are missing", () => {
    // Defensive: if the main loop somehow completed without breaking (e.g. reviews
    // simply not configured on this build) but a caller still passes a missing-phase
    // list, absence of a recorded short-circuit means we cannot attribute it upstream.
    const report = classifyMissingReviewPhases({
      storyId: "US-4",
      packageDir: "/tmp",
      missingRequiredReviewPhases: ["semantic-review"],
      shortCircuitPhase: undefined,
      resumeLoopEligible: false,
    });
    expect(report.upstreamShortCircuited).toBe(false);
    expect(report.failedPhaseEntries).toEqual(["semantic-review"]);
  });
});
