import { describe, expect, test } from "bun:test";
import type { QualityCommandResult } from "@/quality/runner";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });

const PASSING_VERDICT = JSON.stringify({
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 3, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "no modifications" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "All tests pass",
});

const FAIL_LINT: QualityCommandResult = {
  commandName: "lint",
  command: "lint",
  success: false,
  exitCode: 1,
  output: "E501 line too long",
  durationMs: 1,
  timedOut: false,
};

describe("E2E: post-rectification resume", () => {
  test("carve-out PASS path: full-suite-rectify re-runs BOTH reviews, so an exempted red gate is fully judged (audit #2)", async () => {
    // The full-suite-gate (canonical pos 4) fails persistently with the SAME finding.
    // full-suite-rectify re-judges the verifier, which PASSES — so the verifier-SSOT
    // carve-out treats the still-red gate as a pre-existing/unrelated regression and
    // exempts it from success aggregation. Crucially, since audit #2, full-suite-rectify's
    // revalidation set includes BOTH semantic- AND adversarial-review, so the code is fully
    // review-judged before the carve-out lets it pass. The completeness guard
    // (missingRequiredReviewPhases) therefore stays empty and the story passes legitimately
    // — no longer the "silent pass without adversarial judgment" US-002 gap, which #2 closes
    // at the source. This also exercises the verifier-SSOT carve-out PASS path end-to-end.
    const verifier = () => ({ output: PASSING_VERDICT });
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        fullSuite: () => ({
          passed: false,
          failed: 1,
          output: "persistent failure",
          failures: [{ testName: "broken", file: "test/a.test.ts", error: "boom" }],
        }),
      },
    });

    // The gate is genuinely red, but the verifier-SSOT carve-out exempts it.
    const gateOut = result.phaseOutputs["full-suite-gate"] as { success?: boolean } | undefined;
    expect(gateOut?.success).toBe(false);
    // Story passes: gate exempted AND every configured review ran and passed.
    expect(result.success).toBe(true);
    expect(result.missingRequiredReviewPhases).toBeUndefined();
    // audit #2: full-suite-rectify edits tests, so adversarial-review re-runs (its prior
    // verdict would be stale). Both reviews appear in the log.
    expect(phaseLog).toContain("semantic-review");
    expect(phaseLog).toContain("adversarial-review");
  });

  test("mechanical-only resume: exhausted lint-only findings still run the reviews", async () => {
    // lint-check (pos 7) fails persistently. The main loop short-circuits before
    // typecheck/semantic/adversarial. mechanical-lintfix exhausts (a hard lint error it
    // can't fix). Lint-style errors do not invalidate LLM analysis, so the mechanical-only
    // resume runs every phase that never executed — including the reviews — even though
    // the gate never greened. The story still fails (lint stays red), but the reviews ran.
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        lint: () => FAIL_LINT,
      },
    });

    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
    // mechanical-only resume backfilled the reviews despite the unresolved lint error.
    expect(phaseLog).toContain("semantic-review");
    expect(phaseLog).toContain("adversarial-review");
  });
});
