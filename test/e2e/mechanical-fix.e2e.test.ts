import { describe, expect, test } from "bun:test";
import type { QualityCommandResult } from "@/quality/runner";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

const PASS_LINT: QualityCommandResult = {
  commandName: "lint",
  command: "lint",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 1,
  timedOut: false,
};
const FAIL_LINT: QualityCommandResult = {
  commandName: "lint",
  command: "lint",
  success: false,
  exitCode: 1,
  output: "lint error: unexpected token",
  durationMs: 1,
  timedOut: false,
};

describe("E2E: mechanical lint-fix", () => {
  test("lint fails then passes; only lint-check re-runs; gate NOT re-run", async () => {
    let lintCalls = 0;
    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        lint: () => (lintCalls++ === 0 ? FAIL_LINT : PASS_LINT),
      },
    });

    expect(result.success).toBe(true);
    // Observed 2026-06-14: mechanical-lintfix op fires as the fix strategy
    expect(strategiesFired).toContain("mechanical-lintfix");
    // lint-check runs twice: once failing, once passing after lintfix revalidation
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);
    // SOUNDNESS: verify-scoped (the test gate in test-after) runs exactly once — NOT re-run after lint-fix
    expect(phaseLog.filter((p) => p === "verify-scoped").length).toBe(1);
  });

  test("three-session: lint-fix re-runs ONLY lint-check; full-suite-gate + verifier NOT re-run", async () => {
    // Strategy parity for mechanical-lintfix: in three-session the test gate is the
    // full-suite-gate (not verify-scoped) and a verifier phase exists. mechanical-lintfix's
    // revalidation set is ["lint-check"] only (AST-preserving fixes can't regress tests),
    // so neither the full-suite-gate nor the verifier may be re-run by the fix.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({
      output: JSON.stringify({
        version: 1,
        approved: true,
        tests: { allPassing: true, passCount: 3, failCount: 0 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "no modifications" },
        acceptanceCriteria: { allMet: true, criteria: [] },
        quality: { rating: "good", issues: [] },
        fixes: [],
        reasoning: "All tests pass",
      }),
    });
    let lintCalls = 0;
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
        lint: () => (lintCalls++ === 0 ? FAIL_LINT : PASS_LINT),
      },
    });

    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("mechanical-lintfix");
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);
    // SOUNDNESS: the test gate (full-suite-gate) and the verifier each run exactly once —
    // mechanical-lintfix's revalidation set is lint-check only.
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(1);
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);

    // Main loop short-circuits at lint-check (canonical pos 7) → mechanical-lintfix →
    // lint-check passes → post-rectification resume runs typecheck/semantic/adversarial.
    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });
});
