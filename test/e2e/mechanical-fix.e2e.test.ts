import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { QualityCommandResult } from "@/quality/runner";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

const PASS_LINT: QualityCommandResult = {
  commandName: "lint", command: "lint", success: true, exitCode: 0,
  output: "", durationMs: 1, timedOut: false,
};
const FAIL_LINT: QualityCommandResult = {
  commandName: "lint", command: "lint", success: false, exitCode: 1,
  output: "lint error: unexpected token", durationMs: 1, timedOut: false,
};

describe("E2E: mechanical lint-fix", () => {
  test("lint fails then passes; only lint-check re-runs; gate NOT re-run", async () => {
    let lintCalls = 0;
    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        lint: () => lintCalls++ === 0 ? FAIL_LINT : PASS_LINT,
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
});
