import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { NaxConfig } from "@/config";

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

describe("E2E: full-suite-rectify (success path)", () => {
  test("three-session: failing gate -> full-suite-rectify edits tests -> verifier IS re-judged -> success", async () => {
    // full-suite-rectify is the ONLY strategy whose appliesTo matches a structured
    // test-runner finding, and the ONLY one whose revalidation set re-runs the
    // verifier (because it edits TEST code, which legitimately changes the verifier's
    // verdict). This locks both: (1) the strategy fires on a failing-test finding,
    // (2) the verifier runs after the test edit. The gate short-circuits the main loop
    // at canonical pos 4 — BEFORE the verifier (pos 5) — so the verifier running at all
    // proves it was pulled in by full-suite-rectify's revalidation set.
    const verifier = () => ({ output: PASSING_VERDICT });

    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        // attempt 0 (main loop): structured failing-test finding → full-suite-rectify matches.
        // attempt 1+ (revalidation): tests now pass after the test edit.
        fullSuite: (attempt) =>
          attempt === 0
            ? {
                passed: false,
                failed: 1,
                output: "1 failing",
                failures: [{ testName: "edge case", file: "test/a.test.ts", error: "expected 2, got 1" }],
              }
            : { passed: true, failed: 0 },
      },
    });

    expect(result.success).toBe(true);
    expect(result.rectificationExhausted).toBeFalsy();
    expect(strategiesFired).toContain("full-suite-rectify");

    // gate runs twice: main loop (fail) + revalidation (pass).
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(2);
    // The verifier — never reached in the main loop (gate short-circuited at pos 4) —
    // is re-judged by full-suite-rectify's revalidation set. This is the property that
    // distinguishes full-suite-rectify from autofix-implementer/autofix-test-writer,
    // both of which exclude the verifier.
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);
    // Reviews still run (revalidation runs semantic; resume backfills adversarial).
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(1);
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(1);

    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });

  test("single-session: failing verify-scoped is matched by full-suite-rectify (NOT no-strategy)", async () => {
    // Regression guard (build-plan-for-strategy.ts §"Without the verify-scoped arm").
    // In single-session there is no full-suite-gate; the scoped verify phase is the test
    // gate. A scoped test failure must still load full-suite-rectify — otherwise the cycle
    // exits "no-strategy" at iteration 0 and the story fails without a single fix attempt.
    // We drive verify-scoped to fail via a static failing test command (commands.test:"false");
    // because the command can't be made attempt-aware, the story ultimately exhausts — but
    // the point is that full-suite-rectify FIRED (was matched), not that it resolved.
    const { result, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      config: { quality: { commands: { test: "false" } } } as unknown as Partial<NaxConfig>,
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    });

    // The matching strategy is loaded and attempted — the no-strategy regression is guarded.
    expect(strategiesFired).toContain("full-suite-rectify");
    // Static failing command can't be fixed → story exhausts and fails (expected).
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });
});
