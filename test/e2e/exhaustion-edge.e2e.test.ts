import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { QualityCommandResult } from "@/quality/runner";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

const ALWAYS_FAIL_TC: QualityCommandResult = {
  commandName: "typecheck", command: "tc", success: false, exitCode: 1,
  output: "TS2304: Cannot find name 'x'", durationMs: 1, timedOut: false,
};

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

describe("E2E: exhaustion + edge", () => {
  test("persistent typecheck failure exhausts rectification and fails the story", async () => {
    // autofix-implementer fires on every typecheck failure. With maxAttempts: 3,
    // the strategy fires 3 times, each time re-validating and failing again.
    // Observed 2026-06-14: exitReason="validate-short-circuit", iterationCount=3,
    // rectificationExhausted=true, success=false.
    const { result } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: () => ALWAYS_FAIL_TC,
      },
    });
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });

  test("greenfield-gate runs and does not prevent three-session completion", async () => {
    // The harness seeds a placeholder test file (test/placeholder.test.ts) so
    // greenfield-gate detects pre-existing tests and proceeds normally (does not pause
    // with "greenfield-no-tests"). Three-session completes all phases successfully.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: { "test-writer": tw, implementer: impl, verifier,
        "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    });
    // greenfield-gate must appear in the log (it always runs in three-session-tdd)
    expect(phaseLog).toContain("greenfield-gate");
    // With seeded placeholder.test.ts, greenfield-gate does NOT pause — three-session completes normally
    expect(result.success).toBe(true);
  });

  test("full-suite-gate regression during revalidation causes rectification failure (gateRegressedDuringRect stays false)", async () => {
    // Scenario: typecheck fails (call 0) → autofix-implementer fires → revalidation
    // runs full-suite-gate (call 1 → fails) and typecheck-check (call 1 → passes).
    // full-suite-gate failure in revalidation causes rectification to fail with
    // exitReason="validator-error" (iterationCount=0, single attempt).
    //
    // shouldSkipPhaseForRectification controls skipping phases in the MAIN pipeline
    // re-run, not in the revalidation set assembled by STRATEGY_TO_REVALIDATION_PHASES.
    // autofix-implementer revalidation always includes full-suite-gate regardless of
    // whether verifier passed — the verifier is in the main loop, not revalidation.
    // Therefore gateRegressedDuringRect stays false (the staleness guard never triggers)
    // because the revalidation failure is detected by the rectification engine itself,
    // not by the staleness-guard path.
    //
    // Observed 2026-06-14: success=false, gateRegressedDuringRect=false,
    // phaseLog includes full-suite-gate 3 times (1 initial pass + 2 revalidation failures).
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    let tcCall = 0;
    let fsCall = 0;

    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: { "test-writer": tw, implementer: impl, verifier,
        "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: () => tcCall++ === 0
          ? { commandName: "typecheck", command: "tc", success: false, exitCode: 1, output: "TS2304", durationMs: 1, timedOut: false }
          : { commandName: "typecheck", command: "tc", success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false },
        fullSuite: () => fsCall++ === 0
          ? { passed: true, failed: 0 }
          : { passed: false, failed: 1, output: "new failure" },
      },
    });

    // Staleness guard did NOT trigger — gateRegressedDuringRect is false because
    // the full-suite-gate regression was detected inside the revalidation set, not
    // the main pipeline loop where the staleness guard operates.
    expect(result.gateRegressedDuringRect).toBe(false);
    // Story fails because revalidation keeps hitting the regressed full-suite-gate.
    expect(result.success).toBe(false);
    // full-suite-gate appears 3 times: once in the main loop (passes), twice in
    // revalidation attempts (both fail because fsCall >= 1 always returns failed).
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(3);
  });
});
