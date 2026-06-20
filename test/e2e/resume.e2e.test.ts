import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { QualityCommandResult } from "@/quality/runner";

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
  commandName: "lint", command: "lint", success: false, exitCode: 1,
  output: "E501 line too long", durationMs: 1, timedOut: false,
};

describe("E2E: post-rectification resume", () => {
  test("review-incomplete: carve-out cannot launder a story whose adversarial-review never ran (US-002)", async () => {
    // The full-suite-gate (canonical pos 4) fails persistently. full-suite-rectify
    // re-judges the verifier, which PASSES — so the verifier-SSOT carve-out exempts the
    // (still-red) gate from success aggregation. The resume then walks the canonical order
    // and reaches semantic-review (pos 9), but breaks again at the still-red gate before
    // adversarial-review (pos 10) can run. The completeness guard (US-002) refuses to let
    // the carve-out pass a story that was never adversarially reviewed: it forces
    // success=false and surfaces the never-run review for escalation routing.
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

    // Despite the verifier-SSOT carve-out exempting the red gate, the story cannot pass.
    expect(result.success).toBe(false);
    expect(result.missingRequiredReviewPhases).toBeDefined();
    expect(result.missingRequiredReviewPhases).toContain("adversarial-review");
    // The resume reached semantic-review (it ran) but never adversarial-review — that gap
    // is precisely what the US-002 guard catches.
    expect(phaseLog).toContain("semantic-review");
    expect(phaseLog).not.toContain("adversarial-review");
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
